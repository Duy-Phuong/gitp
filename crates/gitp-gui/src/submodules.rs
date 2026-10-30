//! Submodules: their status for the sidebar, `update --init --recursive` (a
//! network operation, with progress and Cancel) and `sync`, and adding,
//! re-pointing and removing one.

use gitp_core::Submodule;
use tauri::State;

use crate::state::{
    invalidate_status, with_repo, with_repo_clearing_undo, with_repo_networked, RepoState,
};

/// Every submodule of the active repo, with where it stands.
fn list_submodules_impl(state: &RepoState) -> Result<Vec<Submodule>, String> {
    with_repo(state, |repo| repo.submodules())
}

/// Update the submodule at `path`, or all of them with `None`. Runs unlocked
/// with progress (see `with_repo_networked`): it may clone or fetch.
fn update_submodules_impl(state: &RepoState, path: Option<String>) -> Result<String, String> {
    with_repo_networked(
        state,
        "update",
        |repo| repo.update_submodules(path.as_deref()),
        // A submodule's new HEAD lives under `.git/modules`, which the watcher
        // ignores — yet it changes the superproject's `git status`.
        invalidate_status,
    )
}

fn sync_submodules_impl(state: &RepoState, path: Option<String>) -> Result<String, String> {
    with_repo(state, |repo| repo.sync_submodules(path.as_deref()))
}

/// Add a submodule: clones `url`, so it runs like `update` (progress, Cancel).
fn add_submodule_impl(
    state: &RepoState,
    url: String,
    path: Option<String>,
) -> Result<String, String> {
    with_repo_networked(
        state,
        "clone",
        |repo| repo.add_submodule(&url, path.as_deref()),
        invalidate_status,
    )
}

fn set_submodule_url_impl(state: &RepoState, path: String, url: String) -> Result<String, String> {
    with_repo(state, |repo| repo.set_submodule_url(&path, &url))
}

/// Remove a submodule, leaving the removal staged. It rewrites the index, so a
/// recorded staging undo would no longer match it.
fn remove_submodule_impl(state: &RepoState, path: String) -> Result<String, String> {
    with_repo_clearing_undo(state, |repo| repo.remove_submodule(&path))
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn list_submodules(state: State<RepoState>) -> Result<Vec<Submodule>, String> {
    list_submodules_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn update_submodules(
    path: Option<String>,
    state: State<RepoState>,
) -> Result<String, String> {
    update_submodules_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn sync_submodules(
    path: Option<String>,
    state: State<RepoState>,
) -> Result<String, String> {
    sync_submodules_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn add_submodule(
    url: String,
    path: Option<String>,
    state: State<RepoState>,
) -> Result<String, String> {
    add_submodule_impl(&state, url, path)
}

#[tauri::command(async)]
pub(crate) fn set_submodule_url(
    path: String,
    url: String,
    state: State<RepoState>,
) -> Result<String, String> {
    set_submodule_url_impl(&state, path, url)
}

#[tauri::command(async)]
pub(crate) fn remove_submodule(path: String, state: State<RepoState>) -> Result<String, String> {
    remove_submodule_impl(&state, path)
}
