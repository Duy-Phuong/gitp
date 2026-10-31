//! Single-level undo/redo: the recording helpers that wrap undoable
//! operations, and the commands that reverse and re-apply them.

use std::sync::atomic::{AtomicU64, Ordering};

use gitp_core::{FileBlob, HeadMoveMode, Repo, Undoable};
use serde::Serialize;
use tauri::State;

use crate::state::{invalidate_status, to_message, RepoState, Session};

// --- undo/redo -------------------------------------------------------------
// A single supported action is remembered at a time (GitKraken-style). Each
// recording helper captures the git state around an op and stores it as the
// session's undo slot, clearing any pending redo (a new action forks history).

/// Labels of what Undo/Redo would do, for the toolbar buttons (null = disabled).
#[derive(Serialize, Clone, Default)]
pub(crate) struct UndoView {
    pub(crate) undo: Option<String>,
    pub(crate) redo: Option<String>,
}

/// A stored action is only offered while the repository is still where it
/// left it (see `Repo::can_undo`), so a commit made in the terminal greys the
/// button out instead of arming an Undo that would drop that commit. The check
/// is ref lookups and file compares — cheap enough to run on every snapshot.
pub(crate) fn undo_view(session: &Session) -> UndoView {
    let repo = &session.repo;
    UndoView {
        undo: session
            .undo
            .as_ref()
            .filter(|a| repo.can_undo(a).is_ok())
            .map(|a| a.label().to_string()),
        redo: session
            .redo
            .as_ref()
            .filter(|a| repo.can_redo(a).is_ok())
            .map(|a| a.label().to_string()),
    }
}

pub(crate) fn set_undo(session: &mut Session, action: Undoable) {
    remove_snapshots_of(session.undo.as_ref());
    remove_snapshots_of(session.redo.as_ref());
    session.undo = Some(action);
    session.redo = None;
}

/// Delete the index snapshot files an action owns, once nothing can undo or
/// redo it any more. Each recording gets its own files (see
/// `index_snapshot_slots`), so a dropped action's pair would otherwise linger.
fn remove_snapshots_of(action: Option<&Undoable>) {
    match action {
        Some(Undoable::IndexChanged { before, after, .. }) => {
            remove_snapshot(Some(before));
            remove_snapshot(Some(after));
        }
        Some(Undoable::Discarded {
            index_before,
            index_after,
            ..
        }) => {
            remove_snapshot(index_before.as_ref());
            remove_snapshot(index_after.as_ref());
        }
        _ => {}
    }
}

fn remove_snapshot(path: Option<&String>) {
    if let Some(path) = path {
        let _ = std::fs::remove_file(path);
    }
}

/// Run a HEAD-moving op (commit / reset / merge / cherry-pick / revert /
/// rebase), recording it as an undo only when the branch tip actually moves.
/// `mode` is how undo/redo move it back (see `HeadMoveMode`): `Soft` for a
/// commit, so undone changes stay staged; `Keep` for most ops. Invalidates the
/// log.
pub(crate) fn with_recorded_head_move<T>(
    state: &RepoState,
    label: &str,
    mode: HeadMoveMode,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
) -> Result<T, String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    record_head_move(session, label, mode, None, f)
}

/// Run a hard reset, first saving the uncommitted work it is about to throw
/// away (see `Repo::backup_uncommitted_work`) so its Undo can bring that back
/// too. The backup is taken under the same lock as the reset, so nothing can
/// change the working tree in between. A backup that fails stops the reset:
/// the confirmation promised the work could come back.
pub(crate) fn with_recorded_hard_reset<T>(
    state: &RepoState,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
) -> Result<T, String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let backup = session.repo.backup_uncommitted_work().map_err(|e| {
        format!("Couldn't save a backup of the uncommitted changes, so nothing was reset: {e}")
    })?;
    record_head_move(session, "Reset", HeadMoveMode::Keep, backup, f)
}

fn record_head_move<T>(
    session: &mut Session,
    label: &str,
    mode: HeadMoveMode,
    backup: Option<String>,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
) -> Result<T, String> {
    let before = session.repo.head_commit_id().ok(); // None on an unborn HEAD
    let out = f(&session.repo).map_err(to_message)?;
    // A rebase paused on `edit` or a conflict (or a merge/cherry-pick/revert
    // that stopped) returns Ok with HEAD detached mid-way. That is not a move
    // to undo: a reset back would leave the todo and the branch ref behind,
    // breaking `--continue`. Nothing is recorded, and an older action is
    // dropped too — undo must not run inside the session at all.
    if session.repo.operation_in_progress() {
        clear_undo(session);
        return Ok(out);
    }
    let after = session.repo.head_commit_id().map_err(to_message)?;
    if let Some(before) = before {
        // A backed-up hard reset is recorded even when the tip stayed put
        // (reset to HEAD): discarding the work was the whole action.
        if before != after || backup.is_some() {
            set_undo(
                session,
                Undoable::HeadMoved {
                    label: label.into(),
                    before,
                    after,
                    mode,
                    backup,
                },
            );
        }
    }
    Ok(out)
}

/// Sequence number for index snapshot names.
static UNDO_INDEX_SEQ: AtomicU64 = AtomicU64::new(0);

/// A pair of fresh names (before, after) under `.git` for one recording's
/// staging snapshots. Unique per recording rather than two fixed names: the
/// `before` copy has to be taken before anyone knows whether the op will be
/// recorded, and with fixed names a no-op "Stage all" (or a failed stage)
/// overwrote the files the *armed* action pointed at — its Undo then silently
/// restored the current index. Files of superseded actions are removed in
/// `remove_snapshots_of`.
fn index_snapshot_slots() -> (String, String) {
    let seq = UNDO_INDEX_SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    (
        format!("gitp-undo-index-{pid}-{seq}-before"),
        format!("gitp-undo-index-{pid}-{seq}-after"),
    )
}

/// Run an index-changing op (stage / unstage, whole file or one hunk),
/// recording the staging area on each side so undo restores it exactly.
///
/// The index is captured rather than the list of paths touched: a file can be
/// staged in part, and "unstage all" has to come back to the mixture that was
/// there before rather than to all-or-nothing. Recording is skipped when there
/// is no index file to copy yet (nothing ever staged or committed) or when
/// nothing actually moved; the snapshots are deleted again in that case.
pub(crate) fn with_recorded_index<T>(
    state: &RepoState,
    label: &str,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
) -> Result<T, String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let (before_slot, after_slot) = index_snapshot_slots();
    let before = session.repo.snapshot_index(&before_slot).ok().flatten();
    let out = f(&session.repo);
    invalidate_status(session);
    let out = match out {
        Ok(out) => out,
        Err(e) => {
            remove_snapshot(before.as_ref());
            return Err(to_message(e));
        }
    };
    let after = session.repo.snapshot_index(&after_slot).ok().flatten();
    // An operation that staged nothing must not light up the Undo button.
    // Compared by content, not bytes: git may rewrite stat data on a no-op.
    let changed = match (&before, &after) {
        (Some(b), Some(a)) => !Repo::index_snapshots_equal(b, a),
        _ => false,
    };
    if changed {
        set_undo(
            session,
            Undoable::IndexChanged {
                label: label.into(),
                before: before.expect("checked"),
                after: after.expect("checked"),
            },
        );
    } else {
        remove_snapshot(before.as_ref());
        remove_snapshot(after.as_ref());
    }
    Ok(out)
}

/// Run an upstream change, recording what the branch tracked before.
pub(crate) fn with_recorded_upstream(
    state: &RepoState,
    branch: String,
    label: String,
    f: impl FnOnce(&Repo, &str) -> gitp_core::Result<String>,
) -> Result<String, String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let before = session.repo.branch_upstream(&branch).ok().flatten();
    let out = f(&session.repo, &branch).map_err(to_message)?;
    let after = session.repo.branch_upstream(&branch).ok().flatten();
    // The upstream lives in .git/config, which the ref fingerprint guarding the
    // refs cache doesn't hash — without this the sidebar keeps the old tracking
    // branch and ahead/behind counts.
    session.refs_cache = None;
    if before != after {
        set_undo(
            session,
            Undoable::UpstreamChanged {
                label,
                branch,
                before,
                after,
            },
        );
    }
    Ok(out)
}

/// A pull moves HEAD; record it so Undo is a plain reset back, the same as any
/// other ref move. The remote-tracking refs it also updated stay where they are
/// — undo puts *your* branch back, it doesn't un-fetch.
pub(crate) fn record_pull(session: &mut Session, before: Option<String>) {
    let Some(before) = before else { return };
    let Ok(after) = session.repo.head_commit_id() else {
        return;
    };
    if before != after {
        set_undo(
            session,
            Undoable::HeadMoved {
                label: "Pull".into(),
                before,
                after,
                mode: HeadMoveMode::Keep,
                backup: None,
            },
        );
    }
}

/// Run a checkout, recording the switch (branch/commit before → after) so undo
/// can return to the previous revision. Invalidates the log.
pub(crate) fn with_recorded_checkout<T>(
    state: &RepoState,
    label: impl FnOnce() -> String,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
) -> Result<T, String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let before = session.repo.head_ref_name().ok();
    let out = f(&session.repo).map_err(to_message)?;
    // Checking out a commit mid-bisect (to test it by hand) is part of the
    // session, not a switch to undo; `git bisect reset` is the way back. Same
    // rule as for a paused rebase in `with_recorded_head_move`.
    if session.repo.operation_in_progress() {
        clear_undo(session);
        return Ok(out);
    }
    let after = session.repo.head_ref_name().map_err(to_message)?;
    if let Some(before) = before {
        if before != after {
            set_undo(
                session,
                Undoable::Switched {
                    label: label(),
                    before,
                    after,
                },
            );
        }
    }
    Ok(out)
}

/// Run a branch-create that also checks it out (`name` created at `at_rev`, or at
/// HEAD when `at_rev` is None), recording it so undo returns to the previous
/// branch and deletes the new one. Invalidates the log.
pub(crate) fn with_recorded_branch_create(
    state: &RepoState,
    name: &str,
    at_rev: Option<&str>,
    f: impl FnOnce(&Repo) -> gitp_core::Result<String>,
) -> Result<String, String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let prev = session.repo.head_ref_name().map_err(to_message)?;
    // Resolved to an id now: `at_rev` may be a name (`origin/main`, a tag) that
    // points somewhere else by the time redo recreates the branch.
    let at = match at_rev {
        Some(r) => session.repo.resolve_commit(r).map_err(to_message)?,
        None => session.repo.head_commit_id().map_err(to_message)?,
    };
    let out = f(&session.repo).map_err(to_message)?;
    set_undo(
        session,
        Undoable::BranchCreated {
            label: format!("Create branch {name}"),
            name: name.into(),
            at,
            prev,
        },
    );
    Ok(out)
}

/// Discard `paths`, snapshotting each file's bytes before and after so undo can
/// restore the discarded content exactly (and redo re-discards).
///
/// The index is snapshotted alongside: a discard also resets it for those paths
/// (a staged hunk goes, a staged-new file is unstaged), and restoring the file
/// bytes alone would bring the edit back unstaged. If a file can't be read on
/// either side the discard still happens, but nothing is recorded — an undo
/// that mistook a read error for "absent" would delete the file.
pub(crate) fn with_recorded_discard(
    state: &RepoState,
    paths: &[String],
    f: impl FnOnce(&Repo) -> gitp_core::Result<()>,
) -> Result<(), String> {
    let n = paths.len();
    let label = format!("Discard {n} file{}", if n == 1 { "" } else { "s" });
    with_recorded_files(state, label, paths, f)
}

/// Run `f`, which rewrites `paths` in the working tree and the index, recording
/// it under `label` the way [`with_recorded_discard`] records a discard: each
/// file's bytes and the index on both sides. Anything that only overwrites
/// files — restoring them from a commit, reverting a block — undoes the same
/// way.
pub(crate) fn with_recorded_files(
    state: &RepoState,
    label: String,
    paths: &[String],
    f: impl FnOnce(&Repo) -> gitp_core::Result<()>,
) -> Result<(), String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let (before_slot, after_slot) = index_snapshot_slots();
    let befores: Vec<gitp_core::Result<Option<Vec<u8>>>> = paths
        .iter()
        .map(|p| session.repo.read_workfile(p))
        .collect();
    let before_modes: Vec<Option<u32>> = paths
        .iter()
        .map(|p| session.repo.workfile_mode(p))
        .collect();
    let index_before = session.repo.snapshot_index(&before_slot).ok().flatten();
    if let Err(e) = f(&session.repo) {
        remove_snapshot(index_before.as_ref());
        return Err(to_message(e));
    }
    invalidate_status(session); // a discard rewrites the worktree, not the index
    let index_after = session.repo.snapshot_index(&after_slot).ok().flatten();
    let afters: Vec<gitp_core::Result<Option<Vec<u8>>>> = paths
        .iter()
        .map(|p| session.repo.read_workfile(p))
        .collect();
    let mut files = Vec::with_capacity(paths.len());
    for ((path, before_mode), (before, after)) in paths
        .iter()
        .zip(before_modes)
        .zip(befores.into_iter().zip(afters))
    {
        match (before, after) {
            (Ok(before), Ok(after)) => files.push(FileBlob {
                path: path.clone(),
                before,
                after,
                before_mode,
                after_mode: session.repo.workfile_mode(path),
            }),
            _ => {
                remove_snapshot(index_before.as_ref());
                remove_snapshot(index_after.as_ref());
                clear_undo(session);
                return Ok(());
            }
        }
    }
    set_undo(
        session,
        Undoable::Discarded {
            label,
            files,
            index_before,
            index_after,
        },
    );
    Ok(())
}

/// Where branch `name` stands before an operation that may move it: whether
/// it is the checked-out branch, and its tip. Taken under the lock, before a
/// network round trip; `record_branch_move` finishes the recording after.
pub(crate) fn branch_move_snapshot(session: &Session, name: &str) -> BranchMoveSnapshot {
    BranchMoveSnapshot {
        is_head: session.repo.head_ref_name().ok().as_deref() == Some(name),
        before: session.repo.branch_commit_id(name).ok(),
    }
}

pub(crate) struct BranchMoveSnapshot {
    is_head: bool,
    before: Option<String>,
}

/// Record that branch `name` moved from where `snapshot` found it: as a HEAD
/// move when it is the checked-out branch (its undo is a `--keep` reset, the
/// working tree follows), else as a plain ref move. Nothing is recorded when
/// the tip is where it was — nothing changed, so the older action still
/// stands.
pub(crate) fn record_branch_move(
    session: &mut Session,
    label: &str,
    name: &str,
    snapshot: BranchMoveSnapshot,
) {
    let Some(before) = snapshot.before else {
        return;
    };
    let Ok(after) = session.repo.branch_commit_id(name) else {
        return;
    };
    if before == after {
        return;
    }
    let action = if snapshot.is_head {
        Undoable::HeadMoved {
            label: label.into(),
            before,
            after,
            mode: HeadMoveMode::Keep,
            backup: None,
        }
    } else {
        Undoable::BranchMoved {
            label: label.into(),
            name: name.into(),
            before,
            after,
        }
    };
    set_undo(session, action);
}

/// Run `f`, which moves branch `name` (a fast-forward), recording the move the
/// way [`record_branch_move`] does.
pub(crate) fn with_recorded_branch_move<T>(
    state: &RepoState,
    label: &str,
    name: &str,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
) -> Result<T, String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let snapshot = branch_move_snapshot(session, name);
    let out = f(&session.repo).map_err(to_message)?;
    record_branch_move(session, label, name, snapshot);
    Ok(out)
}

/// Run `f`, which creates branch `name` at HEAD without checking it out,
/// recording it so undo deletes the branch again.
pub(crate) fn with_recorded_branch_add<T>(
    state: &RepoState,
    name: &str,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
) -> Result<T, String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let at = session.repo.head_commit_id().map_err(to_message)?;
    let out = f(&session.repo).map_err(to_message)?;
    set_undo(
        session,
        Undoable::BranchAdded {
            label: format!("Create branch {name}"),
            name: name.into(),
            at,
        },
    );
    Ok(out)
}

/// Forget the undo/redo slots — used when a non-tracked op (pull, stash) moves
/// HEAD or the working tree, which could make a stored action stale.
pub(crate) fn clear_undo(session: &mut Session) {
    remove_snapshots_of(session.undo.take().as_ref());
    remove_snapshots_of(session.redo.take().as_ref());
}

pub(crate) fn undo_state_impl(state: &RepoState) -> Result<UndoView, String> {
    let guard = state.workspace();
    let Some(idx) = guard.active else {
        return Ok(UndoView::default());
    };
    Ok(undo_view(&guard.sessions[idx]))
}

/// Reverse the last recorded action. On failure the undo slot is kept so the
/// button stays and the user can retry after fixing the cause — except when
/// the repository is no longer where the action left it (`Repo::can_undo`):
/// then the action is stale for good, and the slot is cleared so the button
/// greys out rather than offering the same refusal again.
pub(crate) fn undo_impl(state: &RepoState) -> Result<UndoView, String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let action = session.undo.take().ok_or("nothing to undo")?;
    if let Err(e) = session.repo.can_undo(&action) {
        remove_snapshots_of(Some(&action));
        clear_undo(session);
        return Err(to_message(e));
    }
    match session.repo.undo(&action) {
        Ok(()) => {
            // Taking back a popped stash re-creates the entry under a new id;
            // the record follows it so redo finds the right one.
            let renewed = session.repo.after_undo(&action);
            session.redo = Some(renewed.unwrap_or(action));
            // Undoing a discard restores worktree files, and an upstream change
            // lives in .git/config — which the ref fingerprint guarding the refs
            // cache can't see. Undo is rare and user-initiated, so dropping both
            // caches outright is cheaper than reasoning per action kind.
            invalidate_status(session);
            session.refs_cache = None;
            Ok(undo_view(session))
        }
        Err(e) => {
            session.undo = Some(action);
            Err(to_message(e))
        }
    }
}

/// Re-apply the action that was just undone.
fn redo_impl(state: &RepoState) -> Result<UndoView, String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let action = session.redo.take().ok_or("nothing to redo")?;
    if let Err(e) = session.repo.can_redo(&action) {
        remove_snapshots_of(Some(&action));
        clear_undo(session);
        return Err(to_message(e));
    }
    match session.repo.redo(&action) {
        Ok(()) => {
            let renewed = session.repo.after_redo(&action);
            session.undo = Some(renewed.unwrap_or(action));
            invalidate_status(session);
            session.refs_cache = None; // same reasoning as undo_impl
            Ok(undo_view(session))
        }
        Err(e) => {
            session.redo = Some(action);
            Err(to_message(e))
        }
    }
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn undo_state(state: State<RepoState>) -> Result<UndoView, String> {
    undo_state_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn undo(state: State<RepoState>) -> Result<UndoView, String> {
    undo_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn redo(state: State<RepoState>) -> Result<UndoView, String> {
    redo_impl(&state)
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::Command;

    use gitp_core::{PickAction, PickStep, RebaseAction, RebaseStep, ResetMode};

    use super::{redo_impl, undo_impl, undo_state_impl};
    use crate::branches::{
        checkout_remote_impl, create_backup_branch_impl, create_branch_at_impl,
        fast_forward_branch_to_impl, stash_and_switch_impl,
    };
    use crate::commits::{cherry_pick_plan_impl, continue_cherry_pick_plan_impl, reset_impl};
    use crate::history::get_log_page_impl;
    use crate::rebase::interactive_rebase_impl;
    use crate::remote::{add_remote_impl, rename_remote_impl, set_remote_url_impl};
    use crate::staging::{
        add_to_gitignore_impl, apply_patch_impl, commit_changes_impl, discard_files_impl,
        discard_lines_impl, restore_files_from_commit_impl, stage_all_impl, stage_impl,
        stage_lines_impl, untrack_files_impl,
    };
    use crate::stash::{
        stash_apply_impl, stash_files_impl, stash_impl, stash_pop_impl, stash_rename_impl,
    };
    use crate::state::RepoState;
    use crate::tags::{create_tag_at_impl, delete_tag_impl};
    use crate::test_support::{branch_names, git, head_branch, make_repo};
    use crate::workspace::{open_repo_impl, workspace_snapshot_impl};

    // --- undo/redo wiring ---------------------------------------------------
    //
    // The core tests cover whether a recorded action reverses correctly. These
    // cover the half that the buttons actually depend on: that the operation
    // records anything at all, with a label, and that undo/redo through the
    // command layer put the repository back.

    fn staged_paths(state: &RepoState) -> Vec<String> {
        let mut v: Vec<String> = workspace_snapshot_impl(state)
            .unwrap()
            .status
            .staged
            .into_iter()
            .map(|f| f.path)
            .collect();
        v.sort();
        v
    }

    #[test]
    fn staging_a_file_is_undoable_through_the_command_layer() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        std::fs::write(dir.path().join("f.txt"), "new\n").unwrap();
        assert!(staged_paths(&state).is_empty());

        stage_impl(&state, "f.txt".into()).expect("stage");
        assert_eq!(staged_paths(&state), vec!["f.txt".to_string()]);

        let view = undo_state_impl(&state).unwrap();
        assert_eq!(
            view.undo.as_deref(),
            Some("Stage"),
            "the button has something to offer"
        );

        undo_impl(&state).expect("undo");
        assert!(staged_paths(&state).is_empty(), "undo unstaged it");
        // And the snapshot the UI reads must reflect it, not a cached status.
        assert_eq!(
            undo_state_impl(&state).unwrap().redo.as_deref(),
            Some("Stage")
        );

        redo_impl(&state).expect("redo");
        assert_eq!(
            staged_paths(&state),
            vec!["f.txt".to_string()],
            "redo staged it again"
        );
    }

    #[test]
    fn undoing_stage_all_restores_the_partial_selection() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        std::fs::write(dir.path().join("a.txt"), "a\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "b\n").unwrap();
        stage_impl(&state, "a.txt".into()).expect("stage a");
        assert_eq!(staged_paths(&state), vec!["a.txt".to_string()]);

        stage_all_impl(&state).expect("stage all");
        assert_eq!(
            staged_paths(&state),
            vec!["a.txt".to_string(), "b.txt".to_string()]
        );

        undo_impl(&state).expect("undo");
        assert_eq!(
            staged_paths(&state),
            vec!["a.txt".to_string()],
            "back to the partial selection, not to nothing staged"
        );
    }

    #[test]
    fn an_operation_that_changes_nothing_records_no_undo() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        // Nothing to stage: the index doesn't move, so the Undo button must not
        // light up offering to reverse a no-op.
        stage_all_impl(&state).expect("stage all on a clean tree");
        assert_eq!(undo_state_impl(&state).unwrap().undo, None);
    }

    #[test]
    fn creating_and_deleting_a_tag_are_both_undoable() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");
        let head = get_log_page_impl(&state, 0, 1, true).unwrap().rows[0]
            .id
            .clone();

        create_tag_at_impl(&state, "v1.0".into(), head, None).expect("tag");
        assert_eq!(
            undo_state_impl(&state).unwrap().undo.as_deref(),
            Some("Tag v1.0")
        );
        undo_impl(&state).expect("undo tag create");
        assert!(
            !tag_names(&state).contains(&"v1.0".to_string()),
            "tag removed"
        );
        redo_impl(&state).expect("redo tag create");
        assert!(tag_names(&state).contains(&"v1.0".to_string()), "tag back");

        delete_tag_impl(&state, "v1.0".into()).expect("delete tag");
        assert!(!tag_names(&state).contains(&"v1.0".to_string()));
        assert_eq!(
            undo_state_impl(&state).unwrap().undo.as_deref(),
            Some("Delete tag v1.0")
        );
        undo_impl(&state).expect("undo tag delete");
        assert!(
            tag_names(&state).contains(&"v1.0".to_string()),
            "delete undone"
        );
    }

    #[test]
    fn an_annotated_tag_comes_back_annotated_after_undo_and_redo() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");
        let head = get_log_page_impl(&state, 0, 1, true).unwrap().rows[0]
            .id
            .clone();

        create_tag_at_impl(&state, "v2".into(), head, Some("Release 2\n".into())).expect("tag");
        undo_impl(&state).expect("undo tag create");
        assert!(!tag_names(&state).contains(&"v2".to_string()));
        // Redo restores the ref to the tag object, not to the commit, so the
        // annotation survives the round trip.
        redo_impl(&state).expect("redo tag create");
        let tags = workspace_snapshot_impl(&state).unwrap().refs.tags;
        let v2 = tags.iter().find(|t| t.name == "v2").expect("tag back");
        assert_eq!(v2.message.as_deref(), Some("Release 2"));
    }

    fn tag_names(state: &RepoState) -> Vec<String> {
        workspace_snapshot_impl(state)
            .unwrap()
            .refs
            .tags
            .into_iter()
            .map(|t| t.name)
            .collect()
    }

    // --- preconditions and slot hygiene --------------------------------------
    //
    // Undo must only reverse the recorded action when the repository is still
    // where that action left it, and anything that changes the repository
    // behind undo's back must disarm it rather than leave a stale slot armed.

    fn git_out(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("run git");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn porcelain(dir: &Path) -> String {
        let mut lines: Vec<String> = git_out(dir, &["status", "--porcelain"])
            .lines()
            .map(str::to_string)
            .collect();
        lines.sort();
        lines.join("\n")
    }

    fn open(dir: &Path) -> RepoState {
        let state = RepoState::default();
        open_repo_impl(&state, dir.to_str().unwrap().to_string()).expect("open");
        state
    }

    #[test]
    fn undo_is_refused_and_disarmed_after_a_commit_made_outside() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = open(dir.path());

        std::fs::write(dir.path().join("f.txt"), "two\n").unwrap();
        stage_impl(&state, "f.txt".into()).unwrap();
        commit_changes_impl(&state, "c2".into(), String::new(), false, None, false)
            .expect("commit");
        assert_eq!(
            undo_state_impl(&state).unwrap().undo.as_deref(),
            Some("Commit")
        );

        // c3 from the terminal. Undo "Commit" would now drop it.
        std::fs::write(dir.path().join("f.txt"), "three\n").unwrap();
        git(dir.path(), &["commit", "-q", "-am", "c3"]);
        let c3 = git_out(dir.path(), &["rev-parse", "HEAD"]);

        // The toolbar sees a stale action as nothing to undo...
        assert_eq!(undo_state_impl(&state).unwrap().undo, None);
        // ...and an attempt anyway is refused, leaves c3 alone, and disarms.
        let err = undo_impl(&state).err().expect("refused");
        assert!(err.contains("changed since"), "got {err}");
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), c3);
        assert!(
            state.0.lock().unwrap().sessions[0].undo.is_none(),
            "slot cleared"
        );
    }

    #[test]
    fn a_paused_interactive_rebase_records_nothing_and_clears_the_slot() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1", "c2", "c3"]);
        let state = open(dir.path());
        let rows = get_log_page_impl(&state, 0, 10, true).unwrap().rows; // c3, c2, c1
        let (c3, c2, c1) = (rows[0].id.clone(), rows[1].id.clone(), rows[2].id.clone());

        // Arm the slot with something, so we can see the rebase clear it.
        create_tag_at_impl(&state, "t".into(), c1.clone(), None).unwrap();
        assert!(undo_state_impl(&state).unwrap().undo.is_some());

        let steps = vec![
            RebaseStep {
                sha: c2,
                action: RebaseAction::Edit,
                message: None,
            },
            RebaseStep {
                sha: c3,
                action: RebaseAction::Pick,
                message: None,
            },
        ];
        interactive_rebase_impl(&state, c1, steps, false).expect("rebase stops on edit");
        assert!(
            dir.path().join(".git/rebase-merge").is_dir(),
            "paused mid-rebase"
        );
        assert_eq!(
            undo_state_impl(&state).unwrap().undo,
            None,
            "a paused rebase is not an undoable HEAD move"
        );
        assert!(undo_impl(&state).is_err(), "nothing to undo mid-rebase");
        git(dir.path(), &["rebase", "--abort"]);
    }

    #[test]
    fn a_cherry_pick_plan_resumed_after_a_conflict_undoes_as_one_step() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let main = head_branch(dir.path());
        git(dir.path(), &["checkout", "-q", "-b", "side"]);
        std::fs::write(dir.path().join("f.txt"), "side\n").unwrap();
        git(dir.path(), &["commit", "-q", "-am", "s1"]);
        let s1 = git_out(dir.path(), &["rev-parse", "HEAD"]);
        std::fs::write(dir.path().join("g.txt"), "g\n").unwrap();
        git(dir.path(), &["add", "g.txt"]);
        git(dir.path(), &["commit", "-q", "-m", "s2"]);
        let s2 = git_out(dir.path(), &["rev-parse", "HEAD"]);
        git(dir.path(), &["checkout", "-q", &main]);
        std::fs::write(dir.path().join("f.txt"), "main\n").unwrap();
        git(dir.path(), &["commit", "-q", "-am", "c2"]);
        let start = git_out(dir.path(), &["rev-parse", "HEAD"]);
        let state = open(dir.path());

        let pick = |sha: &str| PickStep {
            sha: sha.into(),
            action: PickAction::Pick,
            message: None,
        };
        let out = cherry_pick_plan_impl(&state, vec![pick(&s1), pick(&s2)]).unwrap();
        assert!(out.paused, "s1 conflicts");
        assert_eq!(undo_state_impl(&state).unwrap().undo, None);

        std::fs::write(dir.path().join("f.txt"), "resolved\n").unwrap();
        git(dir.path(), &["add", "f.txt"]);
        git(
            dir.path(),
            &["-c", "core.editor=true", "cherry-pick", "--continue"],
        );
        let out = continue_cherry_pick_plan_impl(&state).unwrap();
        assert!(!out.paused);
        assert!(
            dir.path().join("g.txt").exists(),
            "s2 applied after the pause"
        );
        assert_eq!(
            undo_state_impl(&state).unwrap().undo.as_deref(),
            Some("Cherry-pick")
        );

        undo_impl(&state).expect("undo");
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "HEAD"]),
            start,
            "both picks undone"
        );
    }

    #[test]
    fn undo_after_a_no_op_stage_all_still_restores_the_original_index() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = open(dir.path());

        std::fs::write(dir.path().join("f.txt"), "two\n").unwrap();
        stage_impl(&state, "f.txt".into()).unwrap();
        // Nothing left to stage: must neither record nor disturb the armed
        // "Stage" (which used to point at snapshot files this overwrote).
        stage_all_impl(&state).unwrap();
        assert_eq!(
            undo_state_impl(&state).unwrap().undo.as_deref(),
            Some("Stage")
        );

        undo_impl(&state).expect("undo");
        assert!(
            staged_paths(&state).is_empty(),
            "the stage was really undone"
        );
        assert_eq!(
            undo_state_impl(&state).unwrap().redo.as_deref(),
            Some("Stage")
        );
        redo_impl(&state).expect("redo");
        assert_eq!(staged_paths(&state), vec!["f.txt".to_string()]);
    }

    #[test]
    fn index_snapshots_do_not_pile_up_in_dot_git() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = open(dir.path());
        for i in 0..4 {
            std::fs::write(dir.path().join("f.txt"), format!("{i}\n")).unwrap();
            stage_impl(&state, "f.txt".into()).unwrap();
            stage_all_impl(&state).unwrap(); // a no-op in between
        }
        let snapshots = std::fs::read_dir(dir.path().join(".git"))
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("gitp-undo-index")
            })
            .count();
        assert_eq!(snapshots, 2, "only the live before/after pair remains");
    }

    #[test]
    fn discard_of_a_partially_staged_file_round_trips_the_index() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = open(dir.path());

        std::fs::write(dir.path().join("f.txt"), "staged\n").unwrap();
        stage_impl(&state, "f.txt".into()).unwrap();
        std::fs::write(dir.path().join("f.txt"), "staged\nunstaged\n").unwrap();
        assert_eq!(porcelain(dir.path()), "MM f.txt");

        discard_files_impl(&state, vec!["f.txt".into()]).expect("discard");
        assert_eq!(porcelain(dir.path()), "");
        undo_impl(&state).expect("undo");
        assert_eq!(
            porcelain(dir.path()),
            "MM f.txt",
            "both the staged hunk and the edit are back"
        );
        redo_impl(&state).expect("redo");
        assert_eq!(porcelain(dir.path()), "");
    }

    #[test]
    fn restoring_a_file_from_a_commit_is_undoable() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c0", "c1"]);
        let state = open(dir.path());
        std::fs::write(dir.path().join("f.txt"), "edited\n").unwrap();
        let read = || std::fs::read_to_string(dir.path().join("f.txt")).unwrap();

        restore_files_from_commit_impl(&state, "HEAD~1".into(), vec!["f.txt".into()])
            .expect("restore");
        assert_eq!(read(), "line 0\n");
        assert_eq!(
            porcelain(dir.path()),
            "M  f.txt",
            "the restored file is staged"
        );
        assert_eq!(
            undo_state_impl(&state).unwrap().undo.as_deref(),
            Some("Restore 1 file from HEAD~1")
        );
        undo_impl(&state).expect("undo");
        assert_eq!(read(), "edited\n", "the local edit is back");
        redo_impl(&state).expect("redo");
        assert_eq!(read(), "line 0\n");
    }

    #[test]
    fn staging_and_discarding_selected_lines_are_undoable() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = open(dir.path());
        std::fs::write(dir.path().join("f.txt"), "line 0\nA\nB\n").unwrap();

        // Block 0 is " line 0", "+A", "+B": stage just "+A".
        stage_lines_impl(&state, "f.txt".into(), vec![(0, 1)], 3).expect("stage lines");
        assert_eq!(porcelain(dir.path()), "MM f.txt");
        assert_eq!(
            undo_state_impl(&state).unwrap().undo.as_deref(),
            Some("Stage lines")
        );
        undo_impl(&state).expect("undo");
        assert_eq!(porcelain(dir.path()), "M f.txt", "back to only unstaged");

        discard_lines_impl(&state, "f.txt".into(), vec![(0, 2)], 3).expect("discard lines");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            "line 0\nA\n"
        );
        undo_impl(&state).expect("undo");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            "line 0\nA\nB\n",
            "the discarded line is back"
        );
    }

    #[test]
    fn create_branch_at_records_where_the_rev_pointed_not_its_name() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1", "c2"]);
        git(dir.path(), &["branch", "base", "HEAD~1"]);
        let c1 = git_out(dir.path(), &["rev-parse", "base"]);
        let state = open(dir.path());

        create_branch_at_impl(&state, "topic".into(), "base".into()).expect("create");
        undo_impl(&state).expect("undo");
        assert!(!branch_names(dir.path()).contains(&"topic".to_string()));

        // `base` moves meanwhile; redo must recreate `topic` at c1, not at
        // wherever `base` points now.
        git(dir.path(), &["branch", "-f", "base", "HEAD"]);
        redo_impl(&state).expect("redo");
        assert_eq!(git_out(dir.path(), &["rev-parse", "topic"]), c1);
    }

    #[test]
    fn a_soft_reset_is_undone_without_losing_the_staged_files() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = open(dir.path());
        std::fs::write(dir.path().join("new.txt"), "n\n").unwrap();
        stage_impl(&state, "new.txt".into()).unwrap();
        commit_changes_impl(&state, "c2".into(), String::new(), false, None, false).unwrap();
        let c2 = git_out(dir.path(), &["rev-parse", "HEAD"]);

        reset_impl(&state, "HEAD~1".into(), ResetMode::Soft).expect("soft reset");
        assert_eq!(porcelain(dir.path()), "A  new.txt", "soft: still staged");
        // A `--keep` undo would refuse here (the index differs from HEAD in
        // new.txt); a soft one just puts the tip back.
        undo_impl(&state).expect("undo soft reset");
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), c2);
        assert_eq!(porcelain(dir.path()), "", "clean again");
    }

    #[test]
    fn a_mixed_reset_is_undone_and_redone_without_touching_the_edits() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1", "c2"]);
        let state = open(dir.path());
        let c2 = git_out(dir.path(), &["rev-parse", "HEAD"]);

        reset_impl(&state, "HEAD~1".into(), ResetMode::Mixed).expect("mixed reset");
        let c1 = git_out(dir.path(), &["rev-parse", "HEAD"]);
        // c2's change is now a local edit, which a `--keep` undo would refuse.
        undo_impl(&state).expect("undo mixed reset");
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), c2);
        assert_eq!(porcelain(dir.path()), "", "clean again");

        redo_impl(&state).expect("redo mixed reset");
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), c1);
        let f = std::fs::read_to_string(dir.path().join("f.txt")).unwrap();
        assert_eq!(f, "line 1\n", "the working tree kept c2's content");
    }

    #[test]
    fn a_hard_reset_with_uncommitted_work_is_undone_with_the_work() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1", "c2"]);
        let state = open(dir.path());
        let c2 = git_out(dir.path(), &["rev-parse", "HEAD"]);
        std::fs::write(dir.path().join("f.txt"), "unsaved\n").unwrap();
        std::fs::write(dir.path().join("u.txt"), "untracked\n").unwrap();

        reset_impl(&state, "HEAD~1".into(), ResetMode::Hard).expect("hard reset");
        let f = std::fs::read_to_string(dir.path().join("f.txt")).unwrap();
        assert_eq!(f, "line 0\n", "the edit is gone");
        assert_eq!(
            undo_state_impl(&state).unwrap().undo.as_deref(),
            Some("Reset")
        );

        undo_impl(&state).expect("undo hard reset");
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), c2);
        let f = std::fs::read_to_string(dir.path().join("f.txt")).unwrap();
        assert_eq!(f, "unsaved\n", "the edit is back");
        let u = std::fs::read_to_string(dir.path().join("u.txt")).unwrap();
        assert_eq!(u, "untracked\n");
    }

    #[test]
    fn an_untracked_mutation_disarms_undo() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = open(dir.path());
        std::fs::write(dir.path().join("f.txt"), "two\n").unwrap();
        stage_impl(&state, "f.txt".into()).unwrap();
        commit_changes_impl(&state, "c2".into(), String::new(), false, None, false).unwrap();
        assert!(undo_state_impl(&state).unwrap().undo.is_some());

        // Stash & Switch moves HEAD and the working tree in one go, which undo
        // doesn't track.
        git(dir.path(), &["branch", "other"]);
        std::fs::write(dir.path().join("f.txt"), "three\n").unwrap();
        stash_and_switch_impl(&state, "branch".into(), "other".into()).expect("stash and switch");
        assert_eq!(
            undo_state_impl(&state).unwrap().undo,
            None,
            "an operation undo doesn't track must not leave the old action armed"
        );
    }

    #[test]
    fn checking_out_a_remote_branch_is_undone_by_removing_the_new_local_branch() {
        let origin = tempfile::tempdir().unwrap();
        make_repo(origin.path(), &["c1"]);
        git(origin.path(), &["branch", "feature"]);
        let clone = tempfile::tempdir().unwrap();
        git(
            clone.path(),
            &["clone", "-q", origin.path().to_str().unwrap(), "."],
        );
        let main = head_branch(clone.path());
        let state = open(clone.path());

        checkout_remote_impl(&state, "origin/feature".into()).expect("checkout remote");
        assert_eq!(head_branch(clone.path()), "feature");
        assert_eq!(
            undo_state_impl(&state).unwrap().undo.as_deref(),
            Some("Create branch feature")
        );
        undo_impl(&state).expect("undo");
        assert_eq!(head_branch(clone.path()), main);
        assert!(
            !branch_names(clone.path()).contains(&"feature".to_string()),
            "the local branch the checkout created is gone again"
        );

        // Switching to a local branch that already exists is a plain switch.
        git(clone.path(), &["branch", "feature", "origin/feature"]);
        checkout_remote_impl(&state, "origin/feature".into()).unwrap();
        assert_eq!(
            undo_state_impl(&state).unwrap().undo.as_deref(),
            Some("Checkout origin/feature")
        );
    }

    fn undo_label(state: &RepoState) -> Option<String> {
        undo_state_impl(state).unwrap().undo
    }

    /// A staged edit, an unstaged edit and a new file.
    fn dirty(dir: &Path, state: &RepoState) {
        std::fs::write(dir.join("f.txt"), "staged\n").unwrap();
        stage_impl(state, "f.txt".into()).unwrap();
        std::fs::write(dir.join("f.txt"), "staged then edited\n").unwrap();
        std::fs::write(dir.join("new.txt"), "new\n").unwrap();
    }

    #[test]
    fn a_stash_is_undone_by_popping_it_back_and_redone() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = open(dir.path());
        dirty(dir.path(), &state);
        let status = git_out(dir.path(), &["status", "--porcelain"]);

        let head = head_branch(dir.path());
        stash_impl(&state, Some("wip".into()), false, true).expect("stash");
        assert_eq!(git_out(dir.path(), &["status", "--porcelain"]), "");
        assert_eq!(undo_label(&state).as_deref(), Some("Stash"));

        undo_impl(&state).expect("undo stash");
        assert_eq!(
            git_out(dir.path(), &["status", "--porcelain"]),
            status,
            "same split as before"
        );
        assert_eq!(git_out(dir.path(), &["stash", "list"]), "");
        assert_eq!(
            undo_state_impl(&state).unwrap().redo.as_deref(),
            Some("Stash")
        );

        redo_impl(&state).expect("redo stash");
        assert_eq!(git_out(dir.path(), &["status", "--porcelain"]), "");
        assert_eq!(
            git_out(dir.path(), &["stash", "list", "--format=%gs"]),
            format!("On {head}: wip")
        );
        // The record followed the re-made entry: it can be undone again.
        undo_impl(&state).expect("undo again");
        assert_eq!(git_out(dir.path(), &["status", "--porcelain"]), status);
    }

    #[test]
    fn a_stash_that_saved_nothing_leaves_the_slot_alone() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = open(dir.path());
        std::fs::write(dir.path().join("f.txt"), "two\n").unwrap();
        stage_impl(&state, "f.txt".into()).unwrap();
        commit_changes_impl(&state, "c2".into(), String::new(), false, None, false).unwrap();
        assert_eq!(undo_label(&state).as_deref(), Some("Commit"));
        stash_impl(&state, None, false, true).expect("nothing to stash is not an error");
        assert_eq!(undo_label(&state).as_deref(), Some("Commit"));
    }

    #[test]
    fn popping_a_stash_onto_a_clean_tree_is_undone_by_stashing_it_again() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = open(dir.path());
        let head = head_branch(dir.path());
        dirty(dir.path(), &state);
        stash_impl(&state, Some("wip".into()), false, true).unwrap();

        stash_pop_impl(&state).expect("pop");
        assert_eq!(undo_label(&state).as_deref(), Some("Pop stash"));
        assert!(dir.path().join("new.txt").exists());
        undo_impl(&state).expect("undo pop");
        assert_eq!(git_out(dir.path(), &["status", "--porcelain"]), "");
        assert_eq!(
            git_out(dir.path(), &["stash", "list", "--format=%gs"]),
            format!("On {head}: wip")
        );
        redo_impl(&state).expect("redo pop");
        assert!(dir.path().join("new.txt").exists());
        assert_eq!(git_out(dir.path(), &["stash", "list"]), "");

        // An apply (entry kept) onto a tree with changes of its own mixes in:
        // not recorded, and the previous action is dropped.
        stash_impl(&state, None, false, true).unwrap();
        std::fs::write(dir.path().join("other.txt"), "mine\n").unwrap();
        stash_apply_impl(&state, 0, false).expect("apply");
        assert_eq!(undo_label(&state), None);
    }

    #[test]
    fn renaming_a_stash_is_undone_to_the_old_text() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = open(dir.path());
        std::fs::write(dir.path().join("f.txt"), "x\n").unwrap();
        stash_impl(&state, None, false, true).unwrap();
        let before = git_out(dir.path(), &["stash", "list", "--format=%gs"]);
        stash_rename_impl(&state, 0, "named".into()).expect("rename");
        assert_eq!(
            git_out(dir.path(), &["stash", "list", "--format=%gs"]),
            "named"
        );
        assert_eq!(undo_label(&state).as_deref(), Some("Rename stash"));
        undo_impl(&state).expect("undo rename");
        assert_eq!(
            git_out(dir.path(), &["stash", "list", "--format=%gs"]),
            before
        );
        redo_impl(&state).expect("redo rename");
        assert_eq!(
            git_out(dir.path(), &["stash", "list", "--format=%gs"]),
            "named"
        );
    }

    #[test]
    fn stashing_some_files_is_undone_like_a_full_stash() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = open(dir.path());
        std::fs::write(dir.path().join("f.txt"), "x\n").unwrap();
        std::fs::write(dir.path().join("keep.txt"), "k\n").unwrap();
        stash_files_impl(&state, vec!["f.txt".into()]).expect("stash files");
        assert_eq!(undo_label(&state).as_deref(), Some("Stash 1 file"));
        assert_eq!(
            git_out(dir.path(), &["status", "--porcelain"]),
            "?? keep.txt"
        );
        undo_impl(&state).expect("undo");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            "x\n"
        );
        assert!(dir.path().join("keep.txt").exists());
    }

    #[test]
    fn ignoring_and_untracking_a_file_are_both_undoable() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = open(dir.path());
        std::fs::write(dir.path().join(".gitignore"), "*.log\n").unwrap();
        git(dir.path(), &["add", ".gitignore"]);
        git(dir.path(), &["commit", "-q", "-m", "ignore"]);

        assert_eq!(
            add_to_gitignore_impl(&state, vec!["f.txt".into()]).unwrap(),
            1
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(),
            "*.log\nf.txt\n"
        );
        assert_eq!(undo_label(&state).as_deref(), Some("Ignore 1 file"));
        undo_impl(&state).expect("undo ignore");
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(),
            "*.log\n"
        );
        redo_impl(&state).expect("redo ignore");
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(),
            "*.log\nf.txt\n"
        );

        untrack_files_impl(&state, vec!["f.txt".into()]).expect("untrack");
        assert_eq!(
            git_out(dir.path(), &["ls-files", "f.txt"]),
            "",
            "no longer tracked"
        );
        assert!(dir.path().join("f.txt").exists(), "but still on disk");
        assert_eq!(undo_label(&state).as_deref(), Some("Stop tracking"));
        undo_impl(&state).expect("undo untrack");
        assert_eq!(git_out(dir.path(), &["ls-files", "f.txt"]), "f.txt");
        // Only the redone ignore rule is left as a change.
        assert_eq!(
            git_out(dir.path(), &["status", "--porcelain"]),
            "M .gitignore"
        );
    }

    #[test]
    fn applying_a_patch_is_undone_file_by_file() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = open(dir.path());
        std::fs::write(dir.path().join("f.txt"), "patched\n").unwrap();
        std::fs::write(dir.path().join("added.txt"), "added\n").unwrap();
        git(dir.path(), &["add", "-A"]);
        let outside = tempfile::tempdir().unwrap();
        let patch = outside.path().join("change.patch");
        std::fs::write(&patch, git_out(dir.path(), &["diff", "--cached"]) + "\n").unwrap();
        git(dir.path(), &["reset", "-q", "--hard"]);
        let _ = std::fs::remove_file(dir.path().join("added.txt"));
        let original = std::fs::read_to_string(dir.path().join("f.txt")).unwrap();

        apply_patch_impl(&state, patch.to_str().unwrap().into()).expect("apply");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            "patched\n"
        );
        assert!(dir.path().join("added.txt").exists());
        assert_eq!(undo_label(&state).as_deref(), Some("Apply patch"));
        undo_impl(&state).expect("undo patch");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            original
        );
        assert!(!dir.path().join("added.txt").exists());
        assert_eq!(git_out(dir.path(), &["status", "--porcelain"]), "");
        redo_impl(&state).expect("redo patch");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            "patched\n"
        );
    }

    #[test]
    fn a_backup_branch_is_undone_by_deleting_it() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = open(dir.path());
        let head = head_branch(dir.path());
        create_backup_branch_impl(&state, "backup".into()).expect("backup");
        assert!(branch_names(dir.path()).contains(&"backup".to_string()));
        assert_eq!(undo_label(&state).as_deref(), Some("Create branch backup"));
        undo_impl(&state).expect("undo");
        assert!(!branch_names(dir.path()).contains(&"backup".to_string()));
        assert_eq!(head_branch(dir.path()), head, "HEAD never moved");
        redo_impl(&state).expect("redo");
        assert!(branch_names(dir.path()).contains(&"backup".to_string()));
    }

    #[test]
    fn fast_forwarding_another_branch_is_undone_by_pointing_it_back() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1", "c2"]);
        let state = open(dir.path());
        let head = head_branch(dir.path());
        let old = git_out(dir.path(), &["rev-parse", "HEAD~1"]);
        git(dir.path(), &["branch", "side", &old]);

        fast_forward_branch_to_impl(&state, "side".into(), head.clone()).expect("ff");
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "side"]),
            git_out(dir.path(), &["rev-parse", &head])
        );
        assert_eq!(undo_label(&state).as_deref(), Some("Fast-forward"));
        undo_impl(&state).expect("undo");
        assert_eq!(git_out(dir.path(), &["rev-parse", "side"]), old);
        assert_eq!(head_branch(dir.path()), head);
        redo_impl(&state).expect("redo");
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "side"]),
            git_out(dir.path(), &["rev-parse", &head])
        );
    }

    #[test]
    fn remote_changes_are_undoable() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = open(dir.path());
        add_remote_impl(&state, "up".into(), "https://example.com/a.git".into()).expect("add");
        assert_eq!(undo_label(&state).as_deref(), Some("Add remote up"));
        undo_impl(&state).expect("undo add");
        assert_eq!(git_out(dir.path(), &["remote"]), "");
        redo_impl(&state).expect("redo add");
        assert_eq!(
            git_out(dir.path(), &["remote", "get-url", "up"]),
            "https://example.com/a.git"
        );

        set_remote_url_impl(&state, "up".into(), "https://example.com/b.git".into()).expect("url");
        assert_eq!(undo_label(&state).as_deref(), Some("Change URL of up"));
        undo_impl(&state).expect("undo url");
        assert_eq!(
            git_out(dir.path(), &["remote", "get-url", "up"]),
            "https://example.com/a.git"
        );

        rename_remote_impl(&state, "up".into(), "origin".into()).expect("rename");
        assert_eq!(undo_label(&state).as_deref(), Some("Rename remote up"));
        undo_impl(&state).expect("undo rename");
        assert_eq!(git_out(dir.path(), &["remote"]), "up");
        redo_impl(&state).expect("redo rename");
        assert_eq!(git_out(dir.path(), &["remote"]), "origin");
    }
}
