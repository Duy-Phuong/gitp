//! Merge / rebase conflict resolution.

use gitp_core::{ConflictSides, ConflictStatus, HeadMoveMode, Repo};
use tauri::State;

use crate::state::{with_repo, with_repo_clearing_undo, RepoState};
use crate::undo::with_recorded_head_move;

/// The in-progress conflict session (merge or rebase), if any.
fn conflict_status_impl(state: &RepoState) -> Result<ConflictStatus, String> {
    with_repo(state, Repo::conflict_status)
}

/// The ours/theirs/base/working versions of a conflicted file.
fn conflict_sides_impl(state: &RepoState, path: String) -> Result<ConflictSides, String> {
    with_repo(state, |repo| repo.conflict_sides(&path))
}

/// Write the resolved content for `path` and stage it (marks it resolved).
fn resolve_conflict_impl(state: &RepoState, path: String, content: String) -> Result<(), String> {
    with_repo_clearing_undo(state, |repo| repo.resolve_conflict(&path, &content))
}

/// Resolve `path` by taking one whole side (ours/theirs), for binary conflicts.
fn resolve_conflict_side_impl(state: &RepoState, path: String, ours: bool) -> Result<(), String> {
    with_repo_clearing_undo(state, |repo| repo.resolve_conflict_side(&path, ours))
}

/// Abort the in-progress merge/rebase. Invalidates the cached log (HEAD/tree).
fn abort_conflict_impl(state: &RepoState) -> Result<String, String> {
    with_repo_clearing_undo(state, Repo::abort_conflict)
}

/// Commit the merge / continue the rebase. Invalidates the cached log.
///
/// Finishing a merge, cherry-pick or revert is an ordinary HEAD move from the
/// branch tip to the new commit, so it is recorded like one. A rebase is not:
/// while paused its HEAD is detached on an intermediate commit, so "before"
/// would be a commit the branch never pointed at — the slot is cleared instead.
fn finish_conflict_impl(state: &RepoState, message: String) -> Result<String, String> {
    let kind = with_repo(state, Repo::conflict_status)?.kind;
    let label = match kind.as_str() {
        "merge" => "Merge",
        "cherry-pick" => "Cherry-pick",
        "revert" => "Revert",
        _ => return with_repo_clearing_undo(state, |repo| repo.finish_conflict(&message)),
    };
    with_recorded_head_move(state, label, HeadMoveMode::Keep, |repo| {
        repo.finish_conflict(&message)
    })
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn conflict_status(state: State<RepoState>) -> Result<ConflictStatus, String> {
    conflict_status_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn conflict_sides(
    path: String,
    state: State<RepoState>,
) -> Result<ConflictSides, String> {
    conflict_sides_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn resolve_conflict(
    path: String,
    content: String,
    state: State<RepoState>,
) -> Result<(), String> {
    resolve_conflict_impl(&state, path, content)
}

#[tauri::command(async)]
pub(crate) fn resolve_conflict_side(
    path: String,
    ours: bool,
    state: State<RepoState>,
) -> Result<(), String> {
    resolve_conflict_side_impl(&state, path, ours)
}

#[tauri::command(async)]
pub(crate) fn abort_conflict(state: State<RepoState>) -> Result<String, String> {
    abort_conflict_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn finish_conflict(message: String, state: State<RepoState>) -> Result<String, String> {
    finish_conflict_impl(&state, message)
}
