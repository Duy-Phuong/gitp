//! Linked worktrees (`git worktree`): list, add, remove, lock and prune.
//!
//! Everything shells out to the `git` CLI. libgit2's worktree support lags the
//! CLI's (no `--porcelain` listing of each one's HEAD and branch, no prunable
//! reason, different refusal rules), and git's own refusals — a branch already
//! checked out elsewhere, a worktree with local changes — are exactly the text
//! the user needs to see.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::repo::Repo;

/// One working tree of the repository, as `git worktree list` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Worktree {
    /// Absolute path of the worktree's folder.
    pub path: String,
    /// The commit checked out there. `None` for a bare main repository, or a
    /// branch with no commits yet.
    pub head: Option<String>,
    /// The checked-out branch's short name; `None` when HEAD is detached.
    pub branch: Option<String>,
    /// The repository's own working tree (always listed first), as opposed to
    /// a linked one added with `git worktree add`.
    pub is_main: bool,
    /// The worktree this `Repo` was opened in.
    pub is_current: bool,
    /// Locked worktrees are never pruned, and git refuses to remove or move
    /// them until unlocked.
    pub locked: bool,
    pub lock_reason: Option<String>,
    /// Its folder is gone, so `git worktree prune` would drop the entry.
    pub prunable: bool,
}

/// A worktree's state at a glance, for its row in the sidebar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorktreeSummary {
    pub path: String,
    /// Files with uncommitted changes there: staged, unstaged or untracked.
    pub changed: usize,
    /// Commits its branch is ahead of / behind its upstream; both 0 without one.
    pub ahead: usize,
    pub behind: usize,
}

/// What removing a worktree would put at risk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorktreeUnsavedWork {
    /// Paths with uncommitted changes, untracked files included.
    pub changed: Vec<String>,
    /// How many of `changed` are untracked.
    pub untracked: usize,
    /// Commits only this worktree's branch has: ahead of its upstream, or —
    /// without one — on no remote branch. On a detached HEAD, the commits no
    /// branch or remote branch has, which the remove would orphan.
    pub unpushed: usize,
}

/// A worktree entry `git worktree prune` would drop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StaleWorktree {
    /// Its folder under `.git/worktrees/`.
    pub name: String,
    /// Why git considers it stale (e.g. its folder is gone).
    pub reason: String,
}

/// What a new worktree checks out.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorktreeTarget {
    /// An existing local branch — refused by git when another worktree already
    /// has it checked out.
    Branch { name: String },
    /// A branch created for the worktree, starting at `start`.
    NewBranch { name: String, start: String },
    /// A detached HEAD at `rev`.
    Detached { rev: String },
}

impl Repo {
    /// Every worktree of the repository, the main one first.
    pub fn worktrees(&self) -> Result<Vec<Worktree>> {
        // -z: NUL-terminated fields, so a lock reason may hold any text.
        let raw = self.run_git_raw(&["worktree", "list", "--porcelain", "-z"])?;
        let here = canonical(self.workdir());
        let mut list = parse_porcelain(&String::from_utf8_lossy(&raw));
        for (i, wt) in list.iter_mut().enumerate() {
            wt.is_main = i == 0;
            wt.is_current = canonical(Path::new(&wt.path)) == here;
        }
        Ok(list)
    }

    /// `git worktree add` at `path` (relative paths resolve against the
    /// working directory, as on the command line). Returns the new worktree's
    /// absolute path.
    pub fn add_worktree(&self, path: &str, target: &WorktreeTarget) -> Result<PathBuf> {
        let mut args = vec!["worktree", "add"];
        match target {
            WorktreeTarget::Branch { name } => args.extend(["--", path, name]),
            WorktreeTarget::NewBranch { name, start } => {
                args.extend(["-b", name, "--", path, start])
            }
            WorktreeTarget::Detached { rev } => args.extend(["--detach", "--", path, rev]),
        }
        self.run_git(&args)?;
        let full = self.workdir().join(path);
        Ok(std::fs::canonicalize(&full).unwrap_or(full))
    }

    /// `git worktree remove`. Without `force` git refuses a worktree with
    /// modified or untracked files, and says so (mentioning `--force`); with
    /// it, those changes are deleted along with the folder. A locked worktree
    /// is refused either way until unlocked.
    pub fn remove_worktree(&self, path: &Path, force: bool) -> Result<String> {
        let path = path_arg(path)?;
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.extend(["--", path]);
        self.run_git(&args)
    }

    /// `git worktree lock`, with `reason` when it isn't empty.
    pub fn lock_worktree(&self, path: &Path, reason: &str) -> Result<String> {
        let path = path_arg(path)?;
        let mut args = vec!["worktree", "lock"];
        if !reason.trim().is_empty() {
            args.extend(["--reason", reason.trim()]);
        }
        args.extend(["--", path]);
        self.run_git(&args)
    }

    /// `git worktree unlock`.
    pub fn unlock_worktree(&self, path: &Path) -> Result<String> {
        self.run_git(&["worktree", "unlock", "--", path_arg(path)?])
    }

    /// `git worktree prune -v`: forget worktrees whose folders are gone.
    /// Returns git's list of what it removed (empty when nothing was stale).
    pub fn prune_worktrees(&self) -> Result<String> {
        self.run_git(&["worktree", "prune", "-v"])
    }

    /// What `prune_worktrees` would remove (`git worktree prune --dry-run -v`),
    /// without removing anything.
    pub fn stale_worktrees(&self) -> Result<Vec<StaleWorktree>> {
        let out = self.run_git(&["worktree", "prune", "--dry-run", "-v"])?;
        Ok(parse_prune_dry_run(&out))
    }

    /// `git worktree move`, to `to` (relative paths resolve against the
    /// working directory). Returns the new absolute path. The main worktree is
    /// the repository's own folder and can't move; a locked one is refused
    /// until unlocked — both said plainly here rather than in git's terms.
    pub fn move_worktree(&self, from: &Path, to: &str) -> Result<PathBuf> {
        let from_canon = canonical(from);
        let wt = self
            .worktrees()?
            .into_iter()
            .find(|w| canonical(Path::new(&w.path)) == from_canon)
            .ok_or_else(|| {
                Error::Message(format!(
                    "{} is not a worktree of this repository",
                    from.display()
                ))
            })?;
        if wt.is_main {
            return Err(Error::Message(
                "The main worktree is the repository's own folder and can't be moved.".into(),
            ));
        }
        if wt.locked {
            let why = wt
                .lock_reason
                .map(|r| format!(" ({r})"))
                .unwrap_or_default();
            return Err(Error::Message(format!(
                "{} is locked{why}. Unlock it before moving it.",
                wt.path
            )));
        }
        self.run_git(&["worktree", "move", "--", path_arg(from)?, to])?;
        let full = self.workdir().join(to);
        Ok(std::fs::canonicalize(&full).unwrap_or(full))
    }

    /// Each worktree's changed-file count and ahead/behind, one `git status`
    /// apiece. A worktree whose folder is gone (prunable) is left out, and so
    /// is one whose status fails — a row without counts beats no sidebar.
    pub fn worktree_summaries(&self) -> Result<Vec<WorktreeSummary>> {
        Ok(self
            .worktrees()?
            .into_iter()
            .filter(|w| !w.prunable)
            .filter_map(|w| {
                let st = self.status_in(&w.path).ok()?;
                Some(WorktreeSummary {
                    path: w.path,
                    changed: st.changed.len(),
                    ahead: st.ahead,
                    behind: st.behind,
                })
            })
            .collect())
    }

    /// The work removing the worktree at `path` would lose or strand: its
    /// uncommitted changes and the commits only it has (see
    /// `WorktreeUnsavedWork::unpushed`).
    pub fn worktree_unsaved_work(&self, path: &Path) -> Result<WorktreeUnsavedWork> {
        let path = path_arg(path)?;
        let st = self.status_in(path)?;
        let unpushed = if st.detached {
            self.count_in(
                path,
                &[
                    "rev-list",
                    "--count",
                    "HEAD",
                    "--not",
                    "--branches",
                    "--remotes",
                ],
            )?
        } else if st.has_ab {
            st.ahead
        } else if self
            .inner
            .references_glob("refs/remotes/*")?
            .next()
            .is_some()
        {
            // No upstream (or it's gone): what no remote branch has. A repo
            // with no remotes has nowhere to push, so nothing is "unpushed".
            self.count_in(path, &["rev-list", "--count", "HEAD", "--not", "--remotes"])?
        } else {
            0
        };
        Ok(WorktreeUnsavedWork {
            changed: st.changed,
            untracked: st.untracked,
            unpushed,
        })
    }

    /// `git status` of the worktree at `path`.
    fn status_in(&self, path: &str) -> Result<WorktreeStatus> {
        // --no-optional-locks: this runs on every sidebar refresh, possibly
        // while the user works in that worktree; writing its index back would
        // contend with them (and wake their watcher).
        let raw = self.run_git_raw(&[
            "-C",
            path,
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ])?;
        Ok(parse_status_v2(&String::from_utf8_lossy(&raw)))
    }

    fn count_in(&self, path: &str, args: &[&str]) -> Result<usize> {
        let mut all = vec!["-C", path];
        all.extend_from_slice(args);
        let out = self.run_git(&all)?;
        out.trim()
            .parse()
            .map_err(|_| Error::Message(format!("unexpected git output: {out}")))
    }

    /// The path of the *other* worktree that has local branch `name` checked
    /// out, if one does. A branch may be checked out in only one worktree at a
    /// time — git refuses the second — but libgit2's checkout doesn't check.
    pub(crate) fn branch_checked_out_elsewhere(&self, name: &str) -> Option<String> {
        // Most repos have no linked worktrees: one directory read says so
        // without spawning git on every checkout.
        if self.inner.worktrees().is_ok_and(|names| names.is_empty()) {
            return None;
        }
        // Best-effort: a git too old for `list -z` can't have made worktrees
        // this would matter for.
        self.worktrees()
            .ok()?
            .into_iter()
            .find(|w| !w.is_current && w.branch.as_deref() == Some(name))
            .map(|w| w.path)
    }
}

fn path_arg(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or_else(|| Error::Message(format!("unsupported path: {}", path.display())))
}

/// Resolve symlinks (macOS's `/var` → `/private/var`) and trailing slashes so
/// two spellings of one folder compare equal. Falls back to the path as given.
fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The parts of a worktree's `git status` its summary and remove check use.
#[derive(Debug, Default, PartialEq)]
struct WorktreeStatus {
    changed: Vec<String>,
    untracked: usize,
    detached: bool,
    /// Whether git reported ahead/behind, i.e. the upstream exists.
    has_ab: bool,
    ahead: usize,
    behind: usize,
}

/// Parse `git status --porcelain=v2 --branch -z`: `# branch.*` headers, then
/// one record per changed path. A rename/copy record (`2 …`) is followed by
/// its original path as a field of its own.
fn parse_status_v2(text: &str) -> WorktreeStatus {
    let mut st = WorktreeStatus::default();
    let mut fields = text.split('\0').filter(|f| !f.is_empty());
    while let Some(field) = fields.next() {
        // The path is the last of a fixed number of space-separated parts, so
        // it may itself hold spaces.
        let path = |parts: usize| field.splitn(parts, ' ').nth(parts - 1).map(str::to_string);
        match field.split(' ').next() {
            Some("#") => {
                let mut words = field.split(' ').skip(1);
                match words.next() {
                    Some("branch.head") => st.detached = words.next() == Some("(detached)"),
                    Some("branch.ab") => {
                        let n = |w: Option<&str>| w.and_then(|w| w[1..].parse().ok()).unwrap_or(0);
                        st.has_ab = true;
                        st.ahead = n(words.next());
                        st.behind = n(words.next());
                    }
                    _ => {}
                }
            }
            Some("1") => st.changed.extend(path(9)),
            Some("2") => {
                st.changed.extend(path(10));
                fields.next(); // the original path
            }
            Some("u") => st.changed.extend(path(11)),
            Some("?") => {
                st.changed.extend(path(2));
                st.untracked += 1;
            }
            _ => {} // "!" ignored files aren't asked for
        }
    }
    st
}

/// Parse `git worktree prune --dry-run -v`: a `Removing worktrees/<name>:
/// <reason>` line per stale entry. The verb is translated in other locales,
/// so only the `worktrees/<name>: ` part is relied on; a line without it is
/// kept whole as the reason.
fn parse_prune_dry_run(text: &str) -> Vec<StaleWorktree> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|line| {
            let entry = line
                .find("worktrees/")
                .and_then(|i| line[i + "worktrees/".len()..].split_once(": "));
            match entry {
                Some((name, reason)) => StaleWorktree {
                    name: name.to_string(),
                    reason: reason.to_string(),
                },
                None => StaleWorktree {
                    name: String::new(),
                    reason: line.to_string(),
                },
            }
        })
        .collect()
}

/// Parse `git worktree list --porcelain -z`: one NUL-terminated `key value`
/// field per attribute, each worktree's run of fields ended by an empty one.
fn parse_porcelain(text: &str) -> Vec<Worktree> {
    let mut list = Vec::new();
    let mut current: Option<Worktree> = None;
    for field in text.split('\0') {
        if field.is_empty() {
            list.extend(current.take());
            continue;
        }
        let (key, value) = field.split_once(' ').unwrap_or((field, ""));
        if key == "worktree" {
            list.extend(current.take());
            current = Some(Worktree {
                path: value.to_string(),
                head: None,
                branch: None,
                is_main: false,
                is_current: false,
                locked: false,
                lock_reason: None,
                prunable: false,
            });
            continue;
        }
        let Some(wt) = current.as_mut() else { continue };
        match key {
            // All zeros: a branch with no commits yet.
            "HEAD" if value.bytes().any(|b| b != b'0') => wt.head = Some(value.to_string()),
            "branch" => {
                let short = value.strip_prefix("refs/heads/").unwrap_or(value);
                wt.branch = Some(short.to_string());
            }
            "locked" => {
                wt.locked = true;
                wt.lock_reason = (!value.is_empty()).then(|| value.to_string());
            }
            "prunable" => wt.prunable = true,
            _ => {} // "bare", "detached", and anything newer gits add
        }
    }
    list.extend(current);
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_v2_counts_every_kind_of_change_and_reads_ahead_behind() {
        let text = [
            "# branch.oid 1234",
            "# branch.head feat",
            "# branch.upstream origin/feat",
            "# branch.ab +2 -1",
            "1 .M N... 100644 100644 100644 aaa aaa src/with space.rs",
            "2 R. N... 100644 100644 100644 aaa aaa R100 new name.txt",
            "old name.txt",
            "u UU N... 100644 100644 100644 100644 aaa bbb ccc both.txt",
            "? notes/todo.md",
            "",
        ]
        .join("\0");
        let st = parse_status_v2(&text);
        assert_eq!(
            st.changed,
            [
                "src/with space.rs",
                "new name.txt",
                "both.txt",
                "notes/todo.md"
            ]
        );
        assert_eq!(st.untracked, 1);
        assert!(st.has_ab && !st.detached);
        assert_eq!((st.ahead, st.behind), (2, 1));
    }

    #[test]
    fn status_v2_without_upstream_or_on_a_detached_head() {
        let st = parse_status_v2("# branch.oid 1234\0# branch.head (detached)\0");
        assert!(st.detached && !st.has_ab);
        assert_eq!(
            st,
            WorktreeStatus {
                detached: true,
                ..Default::default()
            }
        );
    }

    #[test]
    fn prune_dry_run_lists_each_stale_entry_with_its_reason() {
        let out = "Removing worktrees/feat: gitdir file points to non-existent location\n\
                   Removing worktrees/old-x: gitdir file does not exist\n\n";
        assert_eq!(
            parse_prune_dry_run(out),
            [
                StaleWorktree {
                    name: "feat".into(),
                    reason: "gitdir file points to non-existent location".into()
                },
                StaleWorktree {
                    name: "old-x".into(),
                    reason: "gitdir file does not exist".into()
                },
            ]
        );
        assert!(parse_prune_dry_run("").is_empty());
        // An unexpected line is kept, not dropped.
        assert_eq!(
            parse_prune_dry_run("something else")[0].reason,
            "something else"
        );
    }
}
