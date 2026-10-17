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
use std::path::Path;

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
    ///
    /// A discard also resets the index for those paths (a staged hunk is
    /// dropped, a staged-new file is unstaged), so the staging area is
    /// snapshotted on each side too — the same `.git` copies as
    /// [`Undoable::IndexChanged`]. `None` when there was no index to copy.
    Discarded {
        label: String,
        files: Vec<FileBlob>,
        index_before: Option<String>,
        index_after: Option<String>,
    },
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
    ///
    /// Refuses while `.git/index.lock` exists: another git process is writing
    /// the index right now, and swapping the file under it would corrupt
    /// whatever it is about to commit to disk.
    fn restore_index(&self, snapshot: &str) -> Result<()> {
        let index_path = self.inner.path().join("index");
        if self.inner.path().join("index.lock").exists() {
            return Err(Error::Message(
                "the index is locked by another git process; try again in a moment".into(),
            ));
        }
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
        let out = self.run_git(&["log", "-1", "--format=%s", &format!("stash@{{{index}}}")])?;
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

    /// Delete every index snapshot left in `.git` by an earlier run. Snapshots
    /// are named uniquely per recording (see the GUI's `with_recorded_index`),
    /// so a crash or a force-quit leaves the live pair behind; this is called
    /// when a repository is opened to sweep them up.
    pub fn remove_index_snapshots(&self) {
        let Ok(entries) = fs::read_dir(self.inner.path()) else {
            return;
        };
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with("gitp-undo-index")
            {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    /// Whether a merge, rebase, cherry-pick, or revert is in progress — any of
    /// the sessions whose state lives in `.git` and that undo must not touch.
    pub fn operation_in_progress(&self) -> bool {
        let git_dir = self.inner.path();
        ["rebase-merge", "rebase-apply"]
            .iter()
            .any(|d| git_dir.join(d).is_dir())
            || ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]
                .iter()
                .any(|f| git_dir.join(f).exists())
    }

    // --- preconditions -------------------------------------------------------

    /// Check that `action` can still be undone: no merge/rebase session is in
    /// progress, and the repository is exactly where the action left it. An
    /// action recorded as `before → after` is only reversible while the
    /// repository is still at `after`; otherwise something else (a commit from
    /// the terminal, an edit, a tag re-created by hand) happened in between and
    /// undoing would destroy *that* instead.
    pub fn can_undo(&self, action: &Undoable) -> Result<()> {
        self.check_precondition(action, Side::After, "undone")
    }

    /// Check that `action` can still be re-applied — the mirror of
    /// [`Repo::can_undo`]: the repository must be back at the action's `before`.
    pub fn can_redo(&self, action: &Undoable) -> Result<()> {
        self.check_precondition(action, Side::Before, "redone")
    }

    fn check_precondition(&self, action: &Undoable, side: Side, verb: &str) -> Result<()> {
        if self.operation_in_progress() {
            return Err(Error::Message(format!(
                "A merge, rebase, cherry-pick or revert is in progress; nothing was {verb}."
            )));
        }
        if !self.is_at(action, side) {
            return Err(Error::Message(format!(
                "The repository changed since that action; nothing was {verb}."
            )));
        }
        Ok(())
    }

    /// Whether the repository currently matches `side` of `action`. Every check
    /// is a ref lookup or a file compare — this also runs when the toolbar is
    /// drawn, so it must stay cheap and must not shell out.
    fn is_at(&self, action: &Undoable, side: Side) -> bool {
        let pick = |before: &str, after: &str| -> String {
            match side {
                Side::Before => before.to_string(),
                Side::After => after.to_string(),
            }
        };
        match action {
            Undoable::HeadMoved { before, after, .. } => {
                self.head_commit_id().ok().as_deref() == Some(pick(before, after).as_str())
            }
            Undoable::Switched { before, after, .. } => {
                self.head_ref_name().ok().as_deref() == Some(pick(before, after).as_str())
            }
            Undoable::BranchCreated { name, at, prev, .. } => match side {
                // Undo deletes the branch, so it must still be the checked-out
                // one and still point where it was created.
                Side::After => {
                    self.head_ref_name().ok().as_deref() == Some(name.as_str())
                        && self.branch_commit_id(name).ok().as_deref() == Some(at.as_str())
                }
                Side::Before => {
                    self.branch_commit_id(name).is_err()
                        && self.head_ref_name().ok().as_deref() == Some(prev.as_str())
                }
            },
            Undoable::BranchesDeleted { branches, .. } => branches.iter().all(|b| {
                let current = self.branch_commit_id(&b.name).ok();
                match side {
                    // Undo tolerates a branch that is already back at its tip
                    // (a retried undo), but not one re-created elsewhere.
                    Side::After => current.is_none() || current.as_deref() == Some(b.oid.as_str()),
                    Side::Before => current.as_deref() == Some(b.oid.as_str()),
                }
            }),
            Undoable::BranchRenamed { old, new, .. } => {
                let (present, absent) = match side {
                    Side::After => (new, old),
                    Side::Before => (old, new),
                };
                self.branch_commit_id(present).is_ok() && self.branch_commit_id(absent).is_err()
            }
            Undoable::IndexChanged { before, after, .. } => {
                self.index_matches(Some(&pick(before, after)))
            }
            Undoable::TagCreated { name, target, .. } => match side {
                Side::After => self.tag_ref_target(name).ok().as_deref() == Some(target.as_str()),
                Side::Before => self.tag_ref_target(name).is_err(),
            },
            Undoable::TagDeleted { name, target, .. } => match side {
                Side::After => self.tag_ref_target(name).is_err(),
                Side::Before => self.tag_ref_target(name).ok().as_deref() == Some(target.as_str()),
            },
            Undoable::StashDropped { oid, .. } => match side {
                Side::After => !self.stash_on_stack(oid),
                Side::Before => self.stash_on_stack(oid),
            },
            Undoable::UpstreamChanged {
                branch,
                before,
                after,
                ..
            } => {
                let expected = match side {
                    Side::Before => before,
                    Side::After => after,
                };
                self.branch_upstream(branch).ok().as_ref() == Some(expected)
            }
            Undoable::Discarded {
                files,
                index_before,
                index_after,
                ..
            } => {
                let index = match side {
                    Side::Before => index_before,
                    Side::After => index_after,
                };
                self.index_matches(index.as_deref())
                    && files.iter().all(|f| {
                        let expected = match side {
                            Side::Before => &f.before,
                            Side::After => &f.after,
                        };
                        self.read_workfile(&f.path).ok().as_ref() == Some(expected)
                    })
            }
        }
    }

    /// Whether the live index holds the same staging state as `snapshot`.
    /// `None` (no snapshot was taken because there was no index) imposes no
    /// condition.
    ///
    /// Compared by content, not by bytes: `git status` rewrites `.git/index`
    /// whenever a file's stat data changes (touching an unchanged file is
    /// enough), so a byte compare would call an untouched "Stage" stale the
    /// moment the user saves anything in an editor.
    fn index_matches(&self, snapshot: Option<&str>) -> bool {
        let Some(snapshot) = snapshot else {
            return true;
        };
        let live = self
            .inner
            .index()
            .and_then(|mut i| i.read(true).map(|()| i));
        match (live, git2::Index::open(Path::new(snapshot))) {
            (Ok(a), Ok(b)) => index_entries(&a) == index_entries(&b),
            _ => false,
        }
    }

    /// Whether two index snapshots taken by [`Repo::snapshot_index`] hold the
    /// same staging state — see [`Repo::index_matches`] for why this is not a
    /// byte compare. Either file being unreadable counts as "different".
    pub fn index_snapshots_equal(a: &str, b: &str) -> bool {
        match (
            git2::Index::open(Path::new(a)),
            git2::Index::open(Path::new(b)),
        ) {
            (Ok(a), Ok(b)) => index_entries(&a) == index_entries(&b),
            _ => false,
        }
    }

    /// Whether the stash commit `oid` is on the stack — read from the
    /// `refs/stash` reflog, which is what the stack *is*, rather than shelling
    /// out to `git stash list`.
    fn stash_on_stack(&self, oid: &str) -> bool {
        let Ok(reflog) = self.inner.reflog("refs/stash") else {
            return false;
        };
        reflog.iter().any(|e| e.id_new().to_string() == oid)
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
                // Idempotent on purpose: if one branch fails to come back, the
                // ones before it already have, and a retry must not then fail on
                // "already exists" for them — so a branch already at its tip is
                // treated as done and the rest are still attempted. Failures are
                // collected and reported together once every branch has been tried.
                let mut failures = Vec::new();
                for b in branches {
                    if self.branch_commit_id(&b.name).ok().as_deref() == Some(b.oid.as_str()) {
                        continue;
                    }
                    if let Err(e) = self.run_git(&["branch", &b.name, &b.oid]) {
                        failures.push(format!("{}: {e}", b.name));
                        continue;
                    }
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
                if failures.is_empty() {
                    Ok(())
                } else {
                    Err(Error::Message(format!(
                        "couldn't restore {}",
                        failures.join("; ")
                    )))
                }
            }
            Undoable::BranchRenamed { old, new, .. } => {
                self.run_git(&["branch", "-m", new, old]).map(|_| ())
            }
            Undoable::Discarded {
                files,
                index_before,
                ..
            } => {
                if let Some(snapshot) = index_before {
                    self.restore_index(snapshot)?;
                }
                self.restore_blobs(files, Side::Before)
            }
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
            Undoable::Discarded {
                files, index_after, ..
            } => {
                if let Some(snapshot) = index_after {
                    self.restore_index(snapshot)?;
                }
                self.restore_blobs(files, Side::After)
            }
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
    /// Never forced: if a tag of that name exists again, it is the user's and
    /// must not be retargeted.
    fn restore_tag(&self, name: &str, target: &str) -> Result<()> {
        let oid = git2::Oid::from_str(target)?;
        self.inner
            .reference(&format!("refs/tags/{name}"), oid, false, "gitp undo")?;
        Ok(())
    }

    /// Put a dropped stash entry back on the stack.
    fn restore_stash(&self, oid: &str, message: &str) -> Result<()> {
        self.run_git(&["stash", "store", "-m", message, oid])
            .map(|_| ())
    }

    /// Remove the stash entry whose commit is `oid`, wherever it now sits — a
    /// redo can't assume the index it had, since restoring pushed it on top.
    fn drop_stash_by_oid(&self, oid: &str) -> Result<()> {
        let list = self.run_git(&["stash", "list", "--format=%H"])?;
        let position = list
            .lines()
            .position(|line| line.trim() == oid)
            .ok_or_else(|| Error::Message("that stash is no longer on the stack".into()))?;
        self.run_git(&["stash", "drop", &format!("stash@{{{position}}}")])
            .map(|_| ())
    }

    fn apply_upstream(&self, branch: &str, upstream: Option<&str>) -> Result<()> {
        match upstream {
            Some(up) => self
                .run_git(&["branch", &format!("--set-upstream-to={up}"), branch])
                .map(|_| ()),
            None => self
                .run_git(&["branch", "--unset-upstream", branch])
                .map(|_| ()),
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
                        fs::create_dir_all(parent).map_err(|e| {
                            Error::Message(format!("can't create dir for {}: {e}", f.path))
                        })?;
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

/// What an index *means* for undo: each entry's path, mode, blob id and
/// conflict stage, sorted. Stat data, assume-valid/skip-worktree flags and
/// extensions (untracked cache, fsmonitor) are left out — they change without
/// the staging area changing.
fn index_entries(index: &git2::Index) -> Vec<(Vec<u8>, u32, git2::Oid, u16)> {
    let mut entries: Vec<_> = index
        .iter()
        .map(|e| (e.path, e.mode, e.id, (e.flags & 0x3000) >> 12))
        .collect();
    entries.sort();
    entries
}

/// Which side of a recorded action: `Before` it ran, or `After`. Selects the
/// side of a [`FileBlob`] to restore, and the state a precondition expects
/// (undo needs the repository at `After`, redo at `Before`).
#[derive(Clone, Copy)]
enum Side {
    Before,
    After,
}
