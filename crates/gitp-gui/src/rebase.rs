//! Rebasing: plain and interactive, and resuming / skipping / aborting a
//! paused one.

use gitp_core::{HeadMoveMode, RebaseCommit, RebaseStatus, RebaseStep, Repo};
use tauri::State;

use crate::state::{with_repo, with_repo_clearing_undo, RepoState};
use crate::undo::with_recorded_head_move;

/// Rebase the current branch onto `rev`. Invalidates the cached log.
fn rebase_onto_impl(state: &RepoState, rev: String) -> Result<String, String> {
    with_recorded_head_move(state, "Rebase", HeadMoveMode::Keep, |repo| {
        repo.rebase_onto(&rev)
    })
}

/// The commits that a rebase onto `onto` would replay, for the editor UI.
fn get_rebase_todo_impl(state: &RepoState, onto: String) -> Result<Vec<RebaseCommit>, String> {
    with_repo(state, |repo| repo.rebase_todo(&onto))
}

/// Run an interactive rebase onto `onto` following `steps`. Invalidates the log.
pub(crate) fn interactive_rebase_impl(
    state: &RepoState,
    onto: String,
    steps: Vec<RebaseStep>,
    update_refs: bool,
) -> Result<String, String> {
    with_recorded_head_move(state, "Rebase", HeadMoveMode::Keep, |repo| {
        repo.interactive_rebase(&onto, &steps, update_refs)
    })
}

/// Snapshot of an in-progress rebase (for the resume UI), or a not-in-progress
/// status. Does not invalidate the log — it only reads state.
fn rebase_status_impl(state: &RepoState) -> Result<RebaseStatus, String> {
    with_repo(state, Repo::rebase_status)
}

/// Resume / skip / abort a paused rebase. All can move HEAD, so invalidate.
fn rebase_continue_impl(state: &RepoState) -> Result<String, String> {
    with_repo_clearing_undo(state, Repo::rebase_continue)
}

fn rebase_skip_impl(state: &RepoState) -> Result<String, String> {
    with_repo_clearing_undo(state, Repo::rebase_skip)
}

fn rebase_abort_impl(state: &RepoState) -> Result<String, String> {
    with_repo_clearing_undo(state, Repo::rebase_abort)
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn rebase_onto(rev: String, state: State<RepoState>) -> Result<String, String> {
    rebase_onto_impl(&state, rev)
}

#[tauri::command(async)]
pub(crate) fn get_rebase_todo(
    onto: String,
    state: State<RepoState>,
) -> Result<Vec<RebaseCommit>, String> {
    get_rebase_todo_impl(&state, onto)
}

#[tauri::command(async)]
pub(crate) fn interactive_rebase(
    onto: String,
    steps: Vec<RebaseStep>,
    update_refs: bool,
    state: State<RepoState>,
) -> Result<String, String> {
    interactive_rebase_impl(&state, onto, steps, update_refs)
}

#[tauri::command(async)]
pub(crate) fn rebase_status(state: State<RepoState>) -> Result<RebaseStatus, String> {
    rebase_status_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn rebase_continue(state: State<RepoState>) -> Result<String, String> {
    rebase_continue_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn rebase_skip(state: State<RepoState>) -> Result<String, String> {
    rebase_skip_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn rebase_abort(state: State<RepoState>) -> Result<String, String> {
    rebase_abort_impl(&state)
}
