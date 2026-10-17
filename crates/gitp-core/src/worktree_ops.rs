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
