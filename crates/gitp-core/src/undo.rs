//! Single-level undo/redo of the most recent supported action, GitKraken-style.
//!
//! Each supported mutating action is recorded as an [`Undoable`] capturing the
//! git state around it — the branch tip before/after, the previous checkout, a
//! deleted branch's commit, or the exact bytes of discarded files. Undo reverses
//! that record; redo re-applies it. Only ONE action is remembered at a time (the
//! last one), matching GitKraken's single-step scope.
//!
//! Reversal shells out through `run_git`/git2 like the rest of the crate, so
//! git's own reflog, safety checks, and messages apply. Ref moves use a *safe*
//! reset (`--keep`, or `--soft` for commit) so an undo aborts rather than
//! clobbering unrelated uncommitted work.

use std::fs;

use crate::error::{Error, Result};
use crate::repo::Repo;

/// A deleted branch's tip and tracking config, enough to recreate it exactly.
#[derive(Debug, Clone)]
pub struct DeletedBranch {
    pub name: String,
    /// Hex id the branch pointed at. The commits stay in the object database,
    /// so recreating the ref here restores the branch whole.
    pub oid: String,
    /// Its upstream, e.g. `origin/main`, when it had one. `None` for a branch
    /// that was never pushed.
    pub upstream: Option<String>,
}

/// One file's content on both sides of a discard, so it can be restored exactly.
/// `None` means the file was absent on that side (a new file discarded, or the
/// original when the discard deleted it).
#[derive(Debug, Clone)]
pub struct FileBlob {
    pub path: String,
    pub before: Option<Vec<u8>>,
    pub after: Option<Vec<u8>>,
}

/// A recorded, reversible action. Stored one-at-a-time (single-level undo).
#[derive(Debug, Clone)]
pub enum Undoable {
    /// The current branch's tip moved `before` → `after` — commit, reset, merge,
    /// cherry-pick, revert, or rebase. `soft` keeps the index/working tree on the
    /// move (commit, so undone changes reappear staged); otherwise a `--keep`
    /// reset also updates the working tree without discarding local edits.
    HeadMoved {
        label: String,
        before: String,
        after: String,
        soft: bool,
    },
    /// HEAD switched between two revisions (checkout). Each side is a branch name
    /// or, when detached, a commit id.
    Switched {
        label: String,
        before: String,
        after: String,
    },
    /// A branch was created at `at`, switching from `prev` (a branch name or id).
    BranchCreated {
        label: String,
        name: String,
        at: String,
        prev: String,
    },
    /// One or more branches were deleted; recreate each at its recorded tip to
    /// undo.
    ///
    /// A list rather than a single branch because undo is single-level: a bulk
    /// delete recorded one branch at a time would leave only the last one
    /// recoverable, which is precisely backwards — the more branches an action
    /// removes, the more it matters that Undo brings all of them back.
    BranchesDeleted {
        label: String,
        branches: Vec<DeletedBranch>,
    },
    /// A branch was renamed `old` → `new`.
    BranchRenamed {
        label: String,
        old: String,
        new: String,
    },
    /// Files were discarded; each file's bytes are captured for an exact restore.
    Discarded { label: String, files: Vec<FileBlob> },
}

impl Undoable {
    /// A short human label for the action, shown in the Undo/Redo tooltips
    /// ("Undo Commit").
    pub fn label(&self) -> &str {
        match self {
            Undoable::HeadMoved { label, .. }
            | Undoable::Switched { label, .. }
            | Undoable::BranchCreated { label, .. }
            | Undoable::BranchesDeleted { label, .. }
            | Undoable::BranchRenamed { label, .. }
            | Undoable::Discarded { label, .. } => label,
        }
    }
}

impl Repo {
    // --- capture helpers (called around an action to record it) --------------

    /// The current HEAD commit id, as hex.
    pub fn head_commit_id(&self) -> Result<String> {
        Ok(self.inner.head()?.peel_to_commit()?.id().to_string())
    }

    /// A revision that re-selects the current HEAD later: the branch shorthand
    /// when on a branch, or the commit id when detached.
    pub fn head_ref_name(&self) -> Result<String> {
        if self.inner.head_detached()? {
            self.head_commit_id()
        } else {
            Ok(self.inner.head()?.shorthand().unwrap_or("HEAD").to_string())
        }
    }

    /// The commit id a local branch points at.
    pub fn branch_commit_id(&self, name: &str) -> Result<String> {
        Ok(self
            .inner
            .find_branch(name, git2::BranchType::Local)?
            .get()
            .peel_to_commit()?
            .id()
            .to_string())
    }

    /// The working-tree bytes of `path`, or `None` if it doesn't exist — used to
    /// snapshot a file around a discard.
    pub fn read_workfile(&self, path: &str) -> Result<Option<Vec<u8>>> {
        let full = self.workdir_path()?.join(path);
        match fs::read(&full) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Error::Message(format!("can't read {path}: {e}"))),
        }
    }

    // --- reversal ------------------------------------------------------------

    /// Reverse `action` (Undo).
    pub fn undo(&self, action: &Undoable) -> Result<()> {
        match action {
            Undoable::HeadMoved { before, soft, .. } => self.move_head(before, *soft),
            Undoable::Switched { before, .. } => self.checkout_branch(before),
            Undoable::BranchCreated { name, prev, .. } => {
                self.checkout_branch(prev)?;
                self.run_git(&["branch", "-D", name]).map(|_| ())
            }
            Undoable::BranchesDeleted { branches, .. } => {
                for b in branches {
                    self.run_git(&["branch", &b.name, &b.oid])?;
                    // Re-point it at its upstream if that still exists. It often
                    // won't — a branch deleted *because* its upstream was gone
                    // has nothing to track — so a failure here is expected and
                    // must not lose the branch we just restored.
                    if let Some(upstream) = &b.upstream {
                        let _ = self.run_git(&[
                            "branch",
                            &format!("--set-upstream-to={upstream}"),
                            &b.name,
                        ]);
                    }
                }
                Ok(())
            }
            Undoable::BranchRenamed { old, new, .. } => {
                self.run_git(&["branch", "-m", new, old]).map(|_| ())
            }
            Undoable::Discarded { files, .. } => self.restore_blobs(files, Side::Before),
        }
    }

    /// Re-apply `action` (Redo) — the inverse of [`Repo::undo`].
    pub fn redo(&self, action: &Undoable) -> Result<()> {
        match action {
            Undoable::HeadMoved { after, soft, .. } => self.move_head(after, *soft),
            Undoable::Switched { after, .. } => self.checkout_branch(after),
            Undoable::BranchCreated { name, at, .. } => {
                self.run_git(&["checkout", "-b", name, at]).map(|_| ())
            }
            Undoable::BranchesDeleted { branches, .. } => {
                for b in branches {
                    self.run_git(&["branch", "-D", &b.name])?;
                }
                Ok(())
            }
            Undoable::BranchRenamed { old, new, .. } => {
                self.run_git(&["branch", "-m", old, new]).map(|_| ())
            }
            Undoable::Discarded { files, .. } => self.restore_blobs(files, Side::After),
        }
    }

    /// Move the current branch to `target`. `soft` keeps the index/working tree
    /// (`--soft`); otherwise `--keep` also updates the working tree but aborts if
    /// that would overwrite local modifications — so undo never loses work.
    fn move_head(&self, target: &str, soft: bool) -> Result<()> {
        let mode = if soft { "--soft" } else { "--keep" };
        self.run_git(&["reset", mode, target]).map(|_| ())
    }

    /// Write each file's captured bytes back (or delete it when that side was
    /// absent), restoring the working tree to the requested side of a discard.
    fn restore_blobs(&self, files: &[FileBlob], side: Side) -> Result<()> {
        let workdir = self.workdir_path()?;
        for f in files {
            let content = match side {
                Side::Before => &f.before,
                Side::After => &f.after,
            };
            let full = workdir.join(&f.path);
            match content {
                Some(bytes) => {
                    if let Some(parent) = full.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|e| Error::Message(format!("can't create dir for {}: {e}", f.path)))?;
                    }
                    fs::write(&full, bytes)
                        .map_err(|e| Error::Message(format!("can't restore {}: {e}", f.path)))?;
                }
                None => {
                    if full.exists() {
                        fs::remove_file(&full)
                            .map_err(|e| Error::Message(format!("can't remove {}: {e}", f.path)))?;
                    }
                }
            }
        }
        Ok(())
    }
}

/// Which captured side of a [`FileBlob`] to restore.
#[derive(Clone, Copy)]
enum Side {
    Before,
    After,
}
