//! Network operations — pull, push, fetch — plus opening a pull request.

use gitp_core::{PullMode, Repo};
use tauri::State;

use crate::os::open_in_browser;
use crate::state::{with_repo, with_repo_networked, with_repo_networked_prepared, RepoState};
use crate::undo::{clear_undo, record_pull};

/// `git pull` the active repo using `mode`. Invalidates the cached log because
/// pulling can bring in new commits. Returns git's output for display. Runs
/// unlocked (see `with_repo_networked`) so the UI stays responsive.
fn pull_impl(state: &RepoState, mode: PullMode) -> Result<String, String> {
    // HEAD is captured under the same lock that picks the repo: by the time the
    // pull runs it has already moved, and a separate lock could pair another
    // tab's HEAD with this repo if the user switched in between.
    with_repo_networked_prepared(
        state,
        |session| session.repo.head_commit_id().ok(),
        |repo| repo.pull(mode),
        // A pull moves HEAD, and moving it back is a plain reset.
        record_pull,
    )
}

/// `git push` the active repo's current branch. Returns git's output. Nothing
/// local changes, so no cache is invalidated.
fn push_impl(state: &RepoState) -> Result<String, String> {
    with_repo_networked(state, Repo::push, |_| {})
}

/// Force-push the active repo's current branch (see `Repo::push_force`).
fn push_force_impl(state: &RepoState) -> Result<String, String> {
    with_repo_networked(state, Repo::push_force, |_| ())
}

/// Push branch `name` to origin. No local change to the log.
fn push_branch_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_repo(state, |repo| repo.push_branch(&name))
}

/// Fetch `name`'s remote. Updates remote-tracking refs only, so the local log
/// (which walks from HEAD) is unchanged.
fn fetch_branch_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_repo_networked(state, |repo| repo.fetch_branch(&name), |_| {})
}

/// Fetch all remotes. Only updates remote-tracking refs, so the cached log
/// (which walks from HEAD) is unchanged.
fn fetch_all_impl(state: &RepoState) -> Result<String, String> {
    with_repo_networked(state, Repo::fetch_all, |_| {})
}

/// Fetch one named remote, for repos with more than one.
fn fetch_remote_impl(state: &RepoState, remote: String) -> Result<String, String> {
    with_repo_networked(state, |repo| repo.fetch_remote(&remote), |_| {})
}

/// Fetch and fast-forward `name`. Invalidates the cached log because the branch
/// (possibly the current one) advances.
fn fetch_and_update_branch_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_repo_networked(
        state,
        |repo| repo.fetch_and_update_branch(&name),
        // The fast-forward advanced a local branch (ensure_log notices); an
        // older recorded action may now be stale, so it is dropped.
        clear_undo,
    )
}

/// Compute the pull/merge-request URL for `branch` and open it in the default
/// browser. Returns the URL for display.
fn create_pull_request_impl(state: &RepoState, branch: String) -> Result<String, String> {
    let url = with_repo(state, |repo| repo.pull_request_url(&branch))?;
    open_in_browser(&url).map_err(|e| e.to_string())?;
    Ok(url)
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn pull(mode: PullMode, state: State<RepoState>) -> Result<String, String> {
    pull_impl(&state, mode)
}

#[tauri::command(async)]
pub(crate) fn push(state: State<RepoState>) -> Result<String, String> {
    push_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn push_force(state: State<RepoState>) -> Result<String, String> {
    push_force_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn push_branch(name: String, state: State<RepoState>) -> Result<String, String> {
    push_branch_impl(&state, name)
}

#[tauri::command(async)]
pub(crate) fn fetch_branch(name: String, state: State<RepoState>) -> Result<String, String> {
    fetch_branch_impl(&state, name)
}

#[tauri::command(async)]
pub(crate) fn fetch_all(state: State<RepoState>) -> Result<String, String> {
    fetch_all_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn fetch_remote(remote: String, state: State<RepoState>) -> Result<String, String> {
    fetch_remote_impl(&state, remote)
}

#[tauri::command(async)]
pub(crate) fn fetch_and_update_branch(
    name: String,
    state: State<RepoState>,
) -> Result<String, String> {
    fetch_and_update_branch_impl(&state, name)
}

#[tauri::command(async)]
pub(crate) fn create_pull_request(
    branch: String,
    state: State<RepoState>,
) -> Result<String, String> {
    create_pull_request_impl(&state, branch)
}
