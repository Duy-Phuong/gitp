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
    /// The index changed — stage, unstage, or a single hunk of either.
    ///
    /// Held as a copy of `.git/index` on each side rather than a list of paths,
    /// because staging is not per-file: a file can be staged in part, and
    /// "unstage all" has to come back to exactly the mixture that was there
    /// before, not to "everything staged".
    ///
    /// The two fields are paths to those copies (under `.git`), not the bytes:
    /// an index runs to ~780 KB for 10,000 files, and holding two of them per
    /// open repository is memory spent on something the filesystem already
    /// stores perfectly well.
    IndexChanged {
        label: String,
        before: String,
        after: String,
    },
    /// A tag was created; undo deletes it again. `target` is recorded so redo
    /// can put it back — by then undo has removed the ref, and with it any way
    /// to look up where it pointed.
    TagCreated {
        label: String,
        name: String,
        target: String,
    },
    /// A tag was deleted. `target` is the id the *ref* held, not the commit it
    /// peels to, so restoring it brings an annotated tag back with its message
    /// and tagger intact — the tag object itself outlives the ref.
    TagDeleted {
        label: String,
        name: String,
        target: String,
    },
    /// A stash entry was dropped. The commit survives until gc, so undo can put
    /// the entry back on the stack from its id.
    StashDropped {
        label: String,
        oid: String,
        message: String,
    },
    /// A branch's upstream was set or cleared. `None` on either side means it
    /// had no upstream then.
    UpstreamChanged {
        label: String,
        branch: String,
        before: Option<String>,
        after: Option<String>,
    },
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
            | Undoable::Discarded { label, .. }
            | Undoable::IndexChanged { label, .. }
            | Undoable::TagCreated { label, .. }
            | Undoable::TagDeleted { label, .. }
            | Undoable::StashDropped { label, .. }
            | Undoable::UpstreamChanged { label, .. } => label,
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

    /// Copy `.git/index` into `.git/<slot>`, returning that path — a complete,
    /// exact snapshot of the staging area, partial staging included.
    ///
    /// The obvious alternative is to write the index out as a tree and restore
    /// it with `read-tree`. Measured on a 10,000-file index that costs 1.8s,
    /// because every tree object has to be written; copying the index file is
    /// ~1ms and restores *more* faithfully, keeping the stat cache that stops
    /// git re-hashing the whole working tree afterwards.
    ///
    /// `None` when there is no index file yet (a repository with nothing staged
    /// and nothing committed).
    pub fn snapshot_index(&self, slot: &str) -> Result<Option<String>> {
        let index_path = self.inner.path().join("index");
        if !index_path.exists() {
            return Ok(None);
        }
        let dest = self.inner.path().join(slot);
        fs::copy(&index_path, &dest)
            .map_err(|e| Error::Message(format!("can't snapshot the index: {e}")))?;
        Ok(Some(dest.to_string_lossy().into_owned()))
    }

    /// Put a snapshot taken by [`Repo::snapshot_index`] back.
    ///
    /// Written to a temporary file and renamed, the way git updates the index
    /// itself, so a failure part-way can't leave a half-written index behind.
    fn restore_index(&self, snapshot: &str) -> Result<()> {
        let index_path = self.inner.path().join("index");
        let staging = self.inner.path().join("gitp-undo-index.tmp");
        fs::copy(snapshot, &staging).map_err(|e| {
            Error::Message(format!("that staging snapshot is no longer available: {e}"))
        })?;
        fs::rename(&staging, &index_path)
            .map_err(|e| Error::Message(format!("can't restore the index: {e}")))?;
        Ok(())
    }

    /// The id stored in `refs/tags/<name>` — the tag object for an annotated
    /// tag, the commit for a lightweight one. Deliberately unpeeled, so undoing
    /// a delete restores the tag exactly as it was.
    pub fn tag_ref_target(&self, name: &str) -> Result<String> {
        let reference = self.inner.find_reference(&format!("refs/tags/{name}"))?;
        reference
            .target()
            .map(|oid| oid.to_string())
            .ok_or_else(|| Error::Message(format!("tag {name} has no target")))
    }

    /// The commit id backing `stash@{index}`, so a dropped entry can be restored.
    pub fn stash_commit_id(&self, index: usize) -> Result<String> {
        let out = self.run_git(&["rev-parse", &format!("stash@{{{index}}}")])?;
        Ok(out.trim().to_string())
    }

    /// The message shown for `stash@{index}`, so a restored entry reads the same
    /// as the one that was dropped.
    pub fn stash_message(&self, index: usize) -> Result<String> {
        let out = self.run_git(&[
            "log",
            "-1",
            "--format=%s",
            &format!("stash@{{{index}}}"),
        ])?;
        Ok(out.trim().to_string())
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
            Undoable::IndexChanged { before, .. } => self.restore_index(before),
            Undoable::TagCreated { name, .. } => self.delete_tag(name).map(|_| ()),
            Undoable::TagDeleted { name, target, .. } => self.restore_tag(name, target),
            Undoable::StashDropped { oid, message, .. } => self.restore_stash(oid, message),
            Undoable::UpstreamChanged { branch, before, .. } => {
                self.apply_upstream(branch, before.as_deref())
            }
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
            Undoable::IndexChanged { after, .. } => self.restore_index(after),
            Undoable::TagCreated { name, target, .. } => self.restore_tag(name, target),
            Undoable::TagDeleted { name, .. } => self.delete_tag(name).map(|_| ()),
            Undoable::StashDropped { oid, .. } => self.drop_stash_by_oid(oid),
            Undoable::UpstreamChanged { branch, after, .. } => {
                self.apply_upstream(branch, after.as_deref())
            }
        }
    }

    /// Recreate `refs/tags/<name>` pointing at exactly the id it held before.
    fn restore_tag(&self, name: &str, target: &str) -> Result<()> {
        let oid = git2::Oid::from_str(target)?;
        self.inner
            .reference(&format!("refs/tags/{name}"), oid, true, "gitp undo")?;
        Ok(())
    }

    /// Put a dropped stash entry back on the stack.
    fn restore_stash(&self, oid: &str, message: &str) -> Result<()> {
        self.run_git(&["stash", "store", "-m", message, oid]).map(|_| ())
    }

    /// Remove the stash entry whose commit is `oid`, wherever it now sits — a
    /// redo can't assume the index it had, since restoring pushed it on top.
    fn drop_stash_by_oid(&self, oid: &str) -> Result<()> {
        let list = self.run_git(&["stash", "list", "--format=%H"])?;
        let position = list
            .lines()
            .position(|line| line.trim() == oid)
            .ok_or_else(|| Error::Message("that stash is no longer on the stack".into()))?;
        self.run_git(&["stash", "drop", &format!("stash@{{{position}}}")]).map(|_| ())
    }

    fn apply_upstream(&self, branch: &str, upstream: Option<&str>) -> Result<()> {
        match upstream {
            Some(up) => self
                .run_git(&["branch", &format!("--set-upstream-to={up}"), branch])
                .map(|_| ()),
            None => self.run_git(&["branch", "--unset-upstream", branch]).map(|_| ()),
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
