//! Single-level undo/redo of the most recent supported action, GitKraken-style.
//!
//! Each supported mutating action is recorded as an [`Undoable`] capturing the
//! git state around it — the branch tip before/after, the previous checkout, a
//! deleted branch's commit, or the exact bytes of discarded files. Undo reverses
//! that record; redo re-applies it. Only ONE action is remembered at a time (the
//! last one), matching GitKraken's single-step scope.
//!
//! Reversal shells out through `run_git`/git2 like the rest of the crate, so
//! git's own reflog, safety checks, and messages apply. Ref moves use a reset
//! that can't lose work (`--keep`, or `--soft`/`--mixed` to mirror a soft or
//! mixed reset) so an undo aborts rather than clobbering uncommitted work.

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

/// How undo/redo moves the branch tip of a [`Undoable::HeadMoved`] — the
/// `git reset` mode, chosen so the move can never lose work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadMoveMode {
    /// `--soft`: index and working tree stay (commit, so undone changes
    /// reappear staged; a soft reset).
    Soft,
    /// `--mixed`: the index follows, the working tree stays. A mixed reset
    /// leaves the files it moved past as local edits, which `--keep` would
    /// refuse to step over — so it is undone the way it was done.
    Mixed,
    /// `--keep`: the working tree follows too, but git aborts rather than
    /// overwrite a file with local edits.
    Keep,
}

/// A recorded, reversible action. Stored one-at-a-time (single-level undo).
#[derive(Debug, Clone)]
pub enum Undoable {
    /// The current branch's tip moved `before` → `after` — commit, reset, merge,
    /// cherry-pick, revert, or rebase.
    ///
    /// `backup` is set for a hard reset that threw away uncommitted work: the
    /// commit [`Repo::backup_uncommitted_work`] saved it in. Undo puts that work
    /// back in the working tree and the index after moving the tip; `before`
    /// and `after` may then be equal (a hard reset to HEAD only discards
    /// changes).
    HeadMoved {
        label: String,
        before: String,
        after: String,
        mode: HeadMoveMode,
        backup: Option<String>,
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

    /// Whether a merge, rebase, cherry-pick, revert or bisect is in progress —
    /// any of the sessions whose state lives in `.git` and that undo must not
    /// touch. A bisect detaches HEAD and checks out commit after commit; none
    /// of those moves is the user's to undo, and `git bisect reset` is the way
    /// back.
    pub fn operation_in_progress(&self) -> bool {
        let git_dir = self.inner.path();
        ["rebase-merge", "rebase-apply"]
            .iter()
            .any(|d| git_dir.join(d).is_dir())
            || [
                "MERGE_HEAD",
                "CHERRY_PICK_HEAD",
                "REVERT_HEAD",
                "BISECT_LOG",
            ]
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
                "A merge, rebase, cherry-pick, revert or bisect is in progress; nothing was {verb}."
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
            Undoable::HeadMoved {
                before,
                mode,
                backup,
                ..
            } => {
                // Checked before the tip moves: once it has, a refusal here
                // would leave the branch back but the work still missing.
                if let Some(backup) = backup {
                    self.check_backup_restorable(backup)?;
                }
                self.move_head(before, *mode, "Undo")?;
                match backup {
                    Some(backup) => self.restore_backup(backup),
                    None => Ok(()),
                }
            }
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
            Undoable::HeadMoved {
                after,
                mode,
                backup,
                ..
            } => {
                // Redo of a backed-up hard reset discards the restored work
                // again, but only while it is exactly what the backup holds —
                // anything edited since is new work, and then the move falls
                // back to `--keep`, which refuses to overwrite it.
                if let Some(backup) = backup {
                    let saved = self.run_git(&["rev-parse", &format!("{backup}^{{tree}}")])?;
                    let (index, work) = self.uncommitted_trees()?;
                    if work == saved && index == Some(self.backup_index_tree(backup)?) {
                        return self.run_git(&["reset", "--hard", after]).map(|_| ());
                    }
                }
                self.move_head(after, *mode, "Redo")
            }
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

    /// Move the current branch to `target` with a reset that can't lose work
    /// (see [`HeadMoveMode`]). `verb` ("Undo"/"Redo") heads the message when
    /// `--keep` refuses.
    fn move_head(&self, target: &str, mode: HeadMoveMode, verb: &str) -> Result<()> {
        let flag = match mode {
            HeadMoveMode::Soft => "--soft",
            HeadMoveMode::Mixed => "--mixed",
            HeadMoveMode::Keep => "--keep",
        };
        self.run_git(&["reset", flag, target])
            .map(|_| ())
            .map_err(|e| match mode {
                HeadMoveMode::Keep => self.explain_keep_refusal(target, verb).unwrap_or(e),
                _ => e,
            })
    }

    /// A plain explanation of a refused `reset --keep`: which of the files the
    /// move has to change hold local edits (or are untracked files in the way).
    /// git itself names only the first one, as "Entry 'x' not uptodate. Cannot
    /// merge." `None` when no such file explains the refusal — git's own message
    /// is the better one then.
    fn explain_keep_refusal(&self, target: &str, verb: &str) -> Option<Error> {
        let moved = self
            .git_paths(&["diff", "--name-only", "-z", "HEAD", target])
            .ok()?;
        let mut dirty = self
            .git_paths(&["diff", "--name-only", "-z", "HEAD"])
            .ok()?;
        dirty.extend(self.untracked_paths().ok()?);
        let blocking: Vec<String> = moved.into_iter().filter(|p| dirty.contains(p)).collect();
        if blocking.is_empty() {
            return None;
        }
        Some(local_changes_in_the_way(verb, &blocking))
    }

    /// The NUL-separated paths a `git ... -z` listing prints.
    fn git_paths(&self, args: &[&str]) -> Result<Vec<String>> {
        let out = self.run_git_raw(args)?;
        Ok(out
            .split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect())
    }

    /// Untracked, non-ignored files, each listed (not collapsed to its folder).
    fn untracked_paths(&self) -> Result<Vec<String>> {
        self.git_paths(&["ls-files", "--others", "--exclude-standard", "-z"])
    }

    // --- hard-reset backups ----------------------------------------------------

    /// Save the uncommitted work a hard reset throws away — the tracked files'
    /// changes and the index, staged new files included — as a commit on top
    /// of HEAD, kept reachable under `refs/gitp/backups/<millis>`, so a hard
    /// reset can be undone with that work. Like a stash, the commit's tree is
    /// the working tree and its second parent holds the index; with unmerged
    /// entries, which can't be written as a tree, there is no second parent
    /// and only the working tree comes back. Untracked files are left out: the
    /// reset leaves them alone, and copying them (build output, datasets) into
    /// the object database would only cost time and space. Neither the working
    /// tree nor the real index is touched. `None` when there is nothing to save.
    ///
    /// Only the newest [`BACKUPS_KEPT`] backups are kept; older refs are deleted
    /// (their commits then go with the next gc).
    pub fn backup_uncommitted_work(&self) -> Result<Option<String>> {
        let (index, work) = self.uncommitted_trees()?;
        let head = self.head_commit_id()?;
        let head_tree = self.run_git(&["rev-parse", "HEAD^{tree}"])?;
        if work == head_tree && index.as_deref().is_none_or(|t| t == head_tree) {
            return Ok(None);
        }
        // A fixed identity: the commit is private and never pushed, and a
        // repository without user.name/email must still be able to reset.
        let identity = [
            ("GIT_AUTHOR_NAME", "gitp"),
            ("GIT_AUTHOR_EMAIL", "gitp@localhost"),
            ("GIT_COMMITTER_NAME", "gitp"),
            ("GIT_COMMITTER_EMAIL", "gitp@localhost"),
        ];
        let index_commit = match &index {
            Some(tree) => Some(self.run_git_env(
                &[
                    "commit-tree",
                    tree,
                    "-p",
                    &head,
                    "-m",
                    "gitp: index before a hard reset",
                ],
                &identity,
            )?),
            None => None,
        };
        let mut args = vec!["commit-tree", &work, "-p", &head];
        if let Some(index_commit) = &index_commit {
            args.extend(["-p", index_commit]);
        }
        args.extend(["-m", "gitp: uncommitted work before a hard reset"]);
        let commit = self.run_git_env(&args, &identity)?;
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        self.run_git(&["update-ref", &format!("{BACKUP_REFS}{millis}"), &commit])?;
        self.prune_backups();
        Ok(Some(commit))
    }

    /// The index as a tree (`None` while it has unmerged entries, which
    /// `write-tree` refuses), and the tree the tracked files would commit as
    /// with `git add -u` — both written through a scratch copy of the index,
    /// so the real one is left alone (`write-tree` would store its cache in it).
    ///
    /// The copy starts from the real index rather than an empty `read-tree
    /// HEAD` so it keeps the stat cache: `add -u` then hashes only the files
    /// that changed, not the whole working tree.
    fn uncommitted_trees(&self) -> Result<(Option<String>, String)> {
        // Named like the undo index snapshots so the sweep on open
        // (`remove_index_snapshots`) also clears one left by a crash.
        let scratch = self.inner.path().join("gitp-undo-index-backup.tmp");
        let real = self.inner.path().join("index");
        let _ = fs::remove_file(&scratch);
        if real.exists() {
            fs::copy(&real, &scratch)
                .map_err(|e| Error::Message(format!("can't snapshot the index: {e}")))?;
        }
        let scratch_str = scratch.to_string_lossy().into_owned();
        let env = [("GIT_INDEX_FILE", scratch_str.as_str())];
        let trees = (|| {
            if !real.exists() {
                self.run_git_env(&["read-tree", "HEAD"], &env)?;
            }
            let index = self.run_git_env(&["write-tree"], &env).ok();
            self.run_git_env(&["add", "-u"], &env)?;
            Ok((index, self.run_git_env(&["write-tree"], &env)?))
        })();
        let _ = fs::remove_file(&scratch);
        trees
    }

    /// The index tree `backup` saved: its second parent's, or — for one taken
    /// with unmerged entries, which has none — HEAD's tree at the time, which
    /// is what undo then leaves in the index.
    fn backup_index_tree(&self, backup: &str) -> Result<String> {
        self.run_git(&["rev-parse", "-q", "--verify", &format!("{backup}^2^{{tree}}")])
            .or_else(|_| self.run_git(&["rev-parse", &format!("{backup}^1^{{tree}}")]))
    }

    /// Delete all but the newest [`BACKUPS_KEPT`] backup refs. Best effort: a
    /// failure leaves an extra ref, never loses the new one.
    fn prune_backups(&self) {
        let Ok(out) = self.run_git(&["for-each-ref", "--format=%(refname)", BACKUP_REFS]) else {
            return;
        };
        // Millisecond names have the same width for centuries, so the text
        // order is the time order.
        let mut refs: Vec<&str> = out.lines().filter(|l| !l.is_empty()).collect();
        refs.sort_unstable();
        let stale = refs.len().saturating_sub(BACKUPS_KEPT);
        if stale == 0 {
            return;
        }
        let script: String = refs[..stale]
            .iter()
            .map(|r| format!("delete {r}\n"))
            .collect();
        let _ = self.run_git_stdin(&["update-ref", "--stdin"], &script);
    }

    /// Refuse to undo a backed-up hard reset when restoring the backup would
    /// overwrite work done since: any tracked change (the reset left the tracked
    /// files clean, so it is new), or an untracked file that differs from the
    /// one the backup would write there (a staged new file the reset deleted,
    /// made again). Untracked files the reset left alone aren't in the backup
    /// and pass.
    fn check_backup_restorable(&self, backup: &str) -> Result<()> {
        let mut blocking = self.git_paths(&["diff", "--name-only", "-z", "HEAD"])?;
        let untracked = self.untracked_paths()?;
        if !untracked.is_empty() {
            let saved: std::collections::HashMap<String, String> = self
                .git_paths(&["ls-tree", "-r", "-z", backup])?
                .into_iter()
                .filter_map(|line| {
                    // "<mode> <type> <id>\t<path>"
                    let (meta, path) = line.split_once('\t')?;
                    Some((path.to_string(), meta.rsplit(' ').next()?.to_string()))
                })
                .collect();
            let candidates: Vec<&String> = untracked
                .iter()
                .filter(|p| saved.contains_key(*p))
                .collect();
            if !candidates.is_empty() {
                let input: String = candidates.iter().map(|p| format!("{p}\n")).collect();
                let ids = self.run_git_stdin(&["hash-object", "--stdin-paths"], &input)?;
                for (path, id) in candidates.into_iter().zip(ids.lines()) {
                    if saved[path] != id.trim() {
                        blocking.push(path.clone());
                    }
                }
            }
        }
        if blocking.is_empty() {
            Ok(())
        } else {
            Err(local_changes_in_the_way("Undo", &blocking))
        }
    }

    /// Write the backed-up work back: every tracked file as the backup holds
    /// it, those it lacks deleted, then the index it saved — so staged and
    /// unstaged changes come back split as they were.
    fn restore_backup(&self, backup: &str) -> Result<()> {
        self.run_git(&[
            "restore",
            &format!("--source={backup}"),
            "--worktree",
            "--",
            ".",
        ])?;
        let index = self.backup_index_tree(backup)?;
        self.run_git(&["read-tree", &index]).map(|_| ())
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

/// Where hard-reset backups live: a private namespace no log walk or sidebar
/// lists, but which keeps the commits from being garbage-collected.
const BACKUP_REFS: &str = "refs/gitp/backups/";

/// How many hard-reset backups are kept — enough to reach back past a few
/// resets, small enough that old work doesn't pile up in the repository.
const BACKUPS_KEPT: usize = 20;

/// The refusal for an undo/redo blocked by local changes in `paths`, in place
/// of git's "Entry 'x' not uptodate. Cannot merge.".
fn local_changes_in_the_way(verb: &str, paths: &[String]) -> Error {
    const SHOWN: usize = 5;
    let mut list = paths
        .iter()
        .take(SHOWN)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if paths.len() > SHOWN {
        list.push_str(&format!(" and {} more", paths.len() - SHOWN));
    }
    Error::Message(format!(
        "{verb} would overwrite uncommitted changes in {list}. Commit or stash them first; nothing was changed."
    ))
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
