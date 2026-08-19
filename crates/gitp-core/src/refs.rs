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
        tags.sort_by(|a, b| a.name.cmp(&b.name));

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
