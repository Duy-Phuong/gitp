//! Git LFS: the status bar indicator's status, tracking patterns, installing
//! the filters, and LFS fetch / pull (network operations with progress and
//! Cancel, like `git fetch`).

use gitp_core::LfsStatus;
use tauri::State;

use crate::state::{invalidate_status, with_repo, with_repo_networked, RepoState};

fn lfs_status_impl(state: &RepoState) -> Result<LfsStatus, String> {
    with_repo(state, |repo| repo.lfs_status())
}

/// Track / untrack only edit `.gitattributes`, which the watcher reports.
fn lfs_track_impl(state: &RepoState, pattern: String) -> Result<String, String> {
    with_repo(state, |repo| repo.lfs_track(&pattern))
}

fn lfs_untrack_impl(state: &RepoState, pattern: String) -> Result<String, String> {
    with_repo(state, |repo| repo.lfs_untrack(&pattern))
}

fn lfs_install_impl(state: &RepoState) -> Result<String, String> {
    with_repo(state, |repo| repo.lfs_install())
}

fn lfs_fetch_impl(state: &RepoState) -> Result<String, String> {
    with_repo_networked(state, "fetch", |repo| repo.lfs_fetch(), |_| {})
}

/// A pull rewrites pointer files in the working tree with their content.
fn lfs_pull_impl(state: &RepoState) -> Result<String, String> {
    with_repo_networked(state, "pull", |repo| repo.lfs_pull(), invalidate_status)
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn lfs_status(state: State<RepoState>) -> Result<LfsStatus, String> {
    lfs_status_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn lfs_track(pattern: String, state: State<RepoState>) -> Result<String, String> {
    lfs_track_impl(&state, pattern)
}

#[tauri::command(async)]
pub(crate) fn lfs_untrack(pattern: String, state: State<RepoState>) -> Result<String, String> {
    lfs_untrack_impl(&state, pattern)
}

#[tauri::command(async)]
pub(crate) fn lfs_install(state: State<RepoState>) -> Result<String, String> {
    lfs_install_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn lfs_fetch(state: State<RepoState>) -> Result<String, String> {
    lfs_fetch_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn lfs_pull(state: State<RepoState>) -> Result<String, String> {
    lfs_pull_impl(&state)
}
