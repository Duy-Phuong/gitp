//! The stash: push (all or some files), pop / apply, drop, rename, and save
//! as a patch.

use gitp_core::Undoable;
use tauri::State;

use crate::state::{to_message, with_repo, with_repo_clearing_undo, RepoState};
use crate::undo::{clear_undo, set_undo};

/// `git stash push` the active repo's local changes, with the Stash dialog's
/// options (a blank message counts as none). Returns git's output.
fn stash_impl(
    state: &RepoState,
    message: Option<String>,
    staged: bool,
    include_untracked: bool,
) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let message = message.as_deref().map(str::trim).filter(|m| !m.is_empty());
    let out = session
        .repo
        .stash_push(message, staged, include_untracked)
        .map_err(to_message)?;
    clear_undo(session); // the working tree changed under any stored undo
    Ok(out)
}

/// `git stash pop` on the active repo. Returns git's output.
fn stash_pop_impl(state: &RepoState) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let out = session.repo.stash_pop().map_err(to_message)?;
    clear_undo(session);
    Ok(out)
}

/// Apply stash `index`. `drop` pops (apply + remove) instead of leaving it.
fn stash_apply_impl(state: &RepoState, index: usize, drop: bool) -> Result<String, String> {
    with_repo_clearing_undo(state, |repo| repo.stash_apply(index, drop))
}

/// Drop stash `index` from the stack.
fn stash_drop_impl(state: &RepoState, index: usize) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    // The entry's commit and message, before dropping loses the reference to
    // them. The commit itself survives until gc, which is what makes this
    // recoverable at all.
    let oid = session.repo.stash_commit_id(index).map_err(to_message)?;
    let message = session
        .repo
        .stash_message(index)
        .unwrap_or_else(|_| format!("stash@{{{index}}}"));
    let out = session.repo.stash_drop(index).map_err(to_message)?;
    set_undo(
        session,
        Undoable::StashDropped {
            label: "Drop stash".into(),
            oid,
            message,
        },
    );
    Ok(out)
}

/// Re-message stash `index`.
fn stash_rename_impl(state: &RepoState, index: usize, message: String) -> Result<String, String> {
    with_repo_clearing_undo(state, |repo| repo.stash_rename(index, &message))
}

/// Write stash `index`'s diff to `path` as a patch file.
fn save_stash_patch_impl(state: &RepoState, index: usize, path: String) -> Result<String, String> {
    with_repo(state, |repo| repo.save_stash_patch(index, path.as_ref()))
}

/// Stash only `paths` away (`git stash push -u -- <paths>`).
fn stash_files_impl(state: &RepoState, paths: Vec<String>) -> Result<String, String> {
    with_repo_clearing_undo(state, |repo| repo.stash_files(&paths))
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn stash(
    message: Option<String>,
    staged: bool,
    include_untracked: bool,
    state: State<RepoState>,
) -> Result<String, String> {
    stash_impl(&state, message, staged, include_untracked)
}

#[tauri::command(async)]
pub(crate) fn stash_pop(state: State<RepoState>) -> Result<String, String> {
    stash_pop_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn stash_apply(
    index: usize,
    drop: bool,
    state: State<RepoState>,
) -> Result<String, String> {
    stash_apply_impl(&state, index, drop)
}

#[tauri::command(async)]
pub(crate) fn stash_drop(index: usize, state: State<RepoState>) -> Result<String, String> {
    stash_drop_impl(&state, index)
}

#[tauri::command(async)]
pub(crate) fn stash_rename(
    index: usize,
    message: String,
    state: State<RepoState>,
) -> Result<String, String> {
    stash_rename_impl(&state, index, message)
}

#[tauri::command(async)]
pub(crate) fn save_stash_patch(
    index: usize,
    path: String,
    state: State<RepoState>,
) -> Result<String, String> {
    save_stash_patch_impl(&state, index, path)
}

#[tauri::command(async)]
pub(crate) fn stash_files(paths: Vec<String>, state: State<RepoState>) -> Result<String, String> {
    stash_files_impl(&state, paths)
}
