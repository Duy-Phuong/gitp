//! Reference listing for the sidebar: local branches (with ahead/behind vs their
//! upstream), remote-tracking branches, tags, and stashes.

use std::collections::HashSet;

use serde::Serialize;

use crate::error::Result;
use crate::repo::Repo;

/// A local branch and how far it is ahead/behind its upstream.
#[derive(Debug, Clone, Serialize)]
pub struct BranchRef {
    /// Short name, e.g. `master` or `feature/widget`.
    pub name: String,
    pub is_head: bool,
    /// Commits on the local branch not on its upstream (0 if no upstream).
    pub ahead: usize,
    /// Commits on the upstream not on the local branch (0 if no upstream).
    pub behind: usize,
    /// Full hex oid of the branch tip, so the UI can jump to that commit.
    pub target: String,
    /// Whether the branch tracks an upstream. `false` means it has never been
    /// pushed / has no configured remote branch (so ahead/behind are 0 not
    /// because it's in sync, but because there's nothing to compare against).
    pub has_upstream: bool,
}

/// A remote-tracking branch, e.g. `origin/master`.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteBranch {
    /// The remote it belongs to, e.g. `origin`.
    pub remote: String,
    /// Full tracking name, e.g. `origin/master`.
    pub name: String,
    /// Full hex oid of the branch tip.
    pub target: String,
}

/// A tag and the commit it resolves to (peeled through annotated tags).
#[derive(Debug, Clone, Serialize)]
pub struct TagRef {
    pub name: String,
    pub target: String,
}

/// One entry in the stash stack.
#[derive(Debug, Clone, Serialize)]
pub struct StashRef {
    /// Stack position: 0 is the most recent (`stash@{0}`).
    pub index: usize,
    pub message: String,
}

/// Everything the sidebar's ref tree needs, in one shot.
#[derive(Debug, Clone, Serialize)]
pub struct Refs {
    /// Name of the checked-out branch, if HEAD is not detached.
    pub head: Option<String>,
    pub branches: Vec<BranchRef>,
    pub remotes: Vec<RemoteBranch>,
    pub tags: Vec<TagRef>,
    pub stashes: Vec<StashRef>,
    /// Local branches most recently switched to (from HEAD's reflog), newest
    /// first, excluding the current branch — for a quick-switch "Recent" list.
    pub recent: Vec<String>,
}

impl Repo {
    /// List branches, remote-tracking branches, tags and stashes.
    pub fn refs(&self) -> Result<Refs> {
        let repo = &self.inner;

        let mut branches = Vec::new();
        let mut head = None;
        for entry in repo.branches(Some(git2::BranchType::Local))? {
            let (branch, _) = entry?;
            let name = match branch.name()? {
                Some(n) => n.to_string(),
                None => continue,
            };
            let is_head = branch.is_head();
            if is_head {
                head = Some(name.clone());
            }
            let (ahead, behind) = ahead_behind(repo, &branch);
            let has_upstream = branch.upstream().is_ok();
            let target = branch
                .get()
                .target()
                .map(|oid| oid.to_string())
                .unwrap_or_default();
            branches.push(BranchRef {
                name,
                is_head,
                ahead,
                behind,
                target,
                has_upstream,
            });
        }
        branches.sort_by(|a, b| a.name.cmp(&b.name));

        let mut remotes = Vec::new();
        for entry in repo.branches(Some(git2::BranchType::Remote))? {
            let (branch, _) = entry?;
            if let Some(name) = branch.name()? {
                // Skip the symbolic `origin/HEAD` pointer.
                if name.ends_with("/HEAD") {
                    continue;
                }
                let remote = name.split('/').next().unwrap_or("").to_string();
                let target = branch
                    .get()
                    .target()
                    .map(|oid| oid.to_string())
                    .unwrap_or_default();
                remotes.push(RemoteBranch {
                    remote,
                    name: name.to_string(),
                    target,
                });
            }
        }
        remotes.sort_by(|a, b| a.name.cmp(&b.name));

        let mut tags: Vec<TagRef> = repo
            .tag_names(None)?
            .iter()
            .flatten()
            .map(|name| TagRef {
                name: name.to_string(),
                // Peel through annotated tags to the underlying commit.
                target: repo
                    .revparse_single(name)
                    .and_then(|obj| obj.peel_to_commit())
                    .map(|c| c.id().to_string())
                    .unwrap_or_default(),
            })
            .collect();
        // Newest release first, comparing digit runs numerically: a plain
        // string sort puts 3.10.0 *before* 3.9.0, and puts the oldest release at
        // the top of a list whose whole purpose is finding the latest one.
        tags.sort_by(|a, b| natural_cmp(&b.name, &a.name));

        let existing: HashSet<&str> = branches.iter().map(|b| b.name.as_str()).collect();
        let recent = read_recent_branches(repo, &existing, head.as_deref(), 8);

        Ok(Refs {
            head,
            branches,
            remotes,
            tags,
            stashes: read_stashes(repo),
            recent,
        })
    }
}

/// The local branches most recently checked out, newest first, read from
/// HEAD's reflog ("checkout: moving from A to B" → B). Skips the current
/// branch, entries whose target no longer exists (e.g. deleted branches or
/// detached-commit checkouts), and duplicates. Capped at `limit`.
fn read_recent_branches(
    repo: &git2::Repository,
    existing: &HashSet<&str>,
    head: Option<&str>,
    limit: usize,
) -> Vec<String> {
    let reflog = match repo.reflog("HEAD") {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    // Index 0 is the most recent reflog entry.
    for i in 0..reflog.len() {
        let Some(entry) = reflog.get(i) else { continue };
        // Ref names can't contain spaces, so the " to " separator is unambiguous.
        let Some(to) = entry
            .message()
            .and_then(|m| m.strip_prefix("checkout: moving from "))
            .and_then(|rest| rest.split_once(" to ").map(|(_, b)| b))
        else {
            continue;
        };
        if Some(to) == head || !existing.contains(to) || !seen.insert(to.to_string()) {
            continue;
        }
        out.push(to.to_string());
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// Ahead/behind counts for `branch` vs its upstream, or (0, 0) if it has none.
fn ahead_behind(repo: &git2::Repository, branch: &git2::Branch) -> (usize, usize) {
    let local = match branch.get().target() {
        Some(oid) => oid,
        None => return (0, 0),
    };
    let upstream = match branch.upstream() {
        Ok(u) => u,
        Err(_) => return (0, 0),
    };
    let up = match upstream.get().target() {
        Some(oid) => oid,
        None => return (0, 0),
    };
    repo.graph_ahead_behind(local, up).unwrap_or((0, 0))
}

/// The full stash stack, read from the reflog of `refs/stash` (index 0 = newest).
fn read_stashes(repo: &git2::Repository) -> Vec<StashRef> {
    let reflog = match repo.reflog("refs/stash") {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    (0..reflog.len())
        .filter_map(|i| {
            reflog.get(i).map(|entry| StashRef {
                index: i,
                message: entry.message().unwrap_or("").to_string(),
            })
        })
        .collect()
}

/// Compare two ref names the way a human reads version numbers: split each into
/// runs of digits and non-digits, then compare run by run — digit runs
/// numerically, the rest as text.
///
/// Plain `str::cmp` is wrong for version tags because it compares digits
/// character by character, so `3.10.0` sorts before `3.9.0` ('1' < '9'). Leading
/// zeros are handled by the numeric comparison, and a numeric run that overflows
/// `u64` (not a version number by then) falls back to text so the ordering stays
/// total rather than panicking.
pub(crate) fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    let mut x = a.as_bytes();
    let mut y = b.as_bytes();
    loop {
        match (x.is_empty(), y.is_empty()) {
            (true, true) => return Ordering::Equal,
            (true, false) => return Ordering::Less,
            (false, true) => return Ordering::Greater,
            (false, false) => {}
        }

        let x_digit = x[0].is_ascii_digit();
        let y_digit = y[0].is_ascii_digit();
        if x_digit != y_digit {
            // A digit sorts before a letter, matching plain text comparison for
            // names that don't line up segment for segment.
            return x[0].cmp(&y[0]);
        }

        let x_len = run_len(x, x_digit);
        let y_len = run_len(y, y_digit);
        let (x_run, y_run) = (&x[..x_len], &y[..y_len]);

        let ord = if x_digit {
            match (parse_run(x_run), parse_run(y_run)) {
                (Some(m), Some(n)) => m.cmp(&n),
                _ => x_run.cmp(y_run),
            }
        } else {
            x_run.cmp(y_run)
        };
        if ord != Ordering::Equal {
            return ord;
        }
        x = &x[x_len..];
        y = &y[y_len..];
    }
}

/// The length of the leading run of digits (or of non-digits) in `s`.
fn run_len(s: &[u8], digits: bool) -> usize {
    s.iter().take_while(|c| c.is_ascii_digit() == digits).count()
}

fn parse_run(run: &[u8]) -> Option<u64> {
    std::str::from_utf8(run).ok()?.parse().ok()
}

#[cfg(test)]
mod natural_cmp_tests {
    use super::natural_cmp;
    use std::cmp::Ordering;

    /// Sort ascending with the comparator, for readable expectations.
    fn sorted(names: &[&str]) -> Vec<String> {
        let mut v: Vec<String> = names.iter().map(|s| s.to_string()).collect();
        v.sort_by(|a, b| natural_cmp(a, b));
        v
    }

    #[test]
    fn orders_version_numbers_by_value_not_by_character() {
        // The case a plain string sort gets wrong: '1' < '9', so 3.10.0 would
        // come first.
        assert_eq!(natural_cmp("3.9.0", "3.10.0"), Ordering::Less);
        assert_eq!(
            sorted(&["3.10.0", "3.9.0", "3.33.1", "3.4.0"]),
            ["3.4.0", "3.9.0", "3.10.0", "3.33.1"]
        );
    }

    #[test]
    fn orders_by_each_segment_in_turn() {
        assert_eq!(
            sorted(&["3.28.3", "3.28.10", "3.28.1", "3.29.0"]),
            ["3.28.1", "3.28.3", "3.28.10", "3.29.0"]
        );
    }

    #[test]
    fn handles_prefixes_and_suffixes_around_the_numbers() {
        assert_eq!(
            sorted(&["v2.10.0", "v2.9.0", "v10.0.0"]),
            ["v2.9.0", "v2.10.0", "v10.0.0"]
        );
        assert_eq!(natural_cmp("1.0.0-rc2", "1.0.0-rc10"), Ordering::Less);
    }

    #[test]
    fn leading_zeros_compare_by_value() {
        assert_eq!(natural_cmp("3.07.0", "3.7.0"), Ordering::Equal);
        assert_eq!(natural_cmp("3.007.0", "3.10.0"), Ordering::Less);
    }

    #[test]
    fn non_version_names_still_order_sensibly_and_totally() {
        assert_eq!(sorted(&["zeta", "alpha", "beta"]), ["alpha", "beta", "zeta"]);
        // A prefix sorts before the longer name it prefixes.
        assert_eq!(natural_cmp("release", "release-1"), Ordering::Less);
        assert_eq!(natural_cmp("same", "same"), Ordering::Equal);
    }

    #[test]
    fn a_numeric_run_too_large_for_u64_does_not_panic() {
        let huge = "1".repeat(30);
        let other = "2".repeat(30);
        // Falls back to text comparison rather than overflowing.
        assert_eq!(natural_cmp(&huge, &other), Ordering::Less);
    }
}
