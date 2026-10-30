//! Network operations — pull, push, fetch, clone, and cancelling them — plus
//! opening a pull request.

use std::path::Path;

use gitp_core::{CloneOptions, PullMode, Repo};
use tauri::State;

use crate::os::open_in_browser;
use crate::state::{
    run_networked_unopened, to_message, with_repo, with_repo_networked,
    with_repo_networked_background, with_repo_networked_prepared, RepoState,
};
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
        "pull",
        |session| session.repo.head_commit_id().ok(),
        |repo| repo.pull(mode),
        // A pull moves HEAD, and moving it back is a plain reset.
        record_pull,
    )
}

/// `git push` the active repo's current branch. Returns git's output. Nothing
/// local changes, so no cache is invalidated.
fn push_impl(state: &RepoState) -> Result<String, String> {
    with_repo_networked(state, "push", Repo::push, |_| {})
}

/// Force-push the active repo's current branch (see `Repo::push_force`).
fn push_force_impl(state: &RepoState) -> Result<String, String> {
    with_repo_networked(state, "push", Repo::push_force, |_| ())
}

/// Push branch `name` to origin. No local change to the log.
fn push_branch_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_repo_networked(state, "push", |repo| repo.push_branch(&name), |_| {})
}

/// Fetch `name`'s remote. Updates remote-tracking refs only, so the local log
/// (which walks from HEAD) is unchanged.
fn fetch_branch_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_repo_networked(state, "fetch", |repo| repo.fetch_branch(&name), |_| {})
}

/// Fetch all remotes. Only updates remote-tracking refs, so the cached log
/// (which walks from HEAD) is unchanged. A `background` fetch — the periodic
/// refresh, not one the user asked for — never prompts for credentials.
pub(crate) fn fetch_all_impl(state: &RepoState, background: bool) -> Result<String, String> {
    if background {
        with_repo_networked_background(state, "fetch", Repo::fetch_all, |_| {})
    } else {
        with_repo_networked(state, "fetch", Repo::fetch_all, |_| {})
    }
}

/// Fetch one named remote, for repos with more than one.
fn fetch_remote_impl(state: &RepoState, remote: String) -> Result<String, String> {
    with_repo_networked(state, "fetch", |repo| repo.fetch_remote(&remote), |_| {})
}

/// Fetch and fast-forward `name`. Invalidates the cached log because the branch
/// (possibly the current one) advances.
fn fetch_and_update_branch_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_repo_networked(
        state,
        "fetch",
        |repo| repo.fetch_and_update_branch(&name),
        // The fast-forward advanced a local branch (ensure_log notices); an
        // older recorded action may now be stale, so it is dropped.
        clear_undo,
    )
}

/// Cancel whatever network operation is running on the active repo, and any
/// clone: its `git` is killed and the operation's command returns "operation
/// cancelled". A no-op when nothing is running.
///
/// A clone has no tab of its own — the status bar's Cancel is the only way to
/// stop it, whichever tab is active — so an operation on a path that isn't an
/// open tab is taken to be one.
pub(crate) fn cancel_network_op_impl(state: &RepoState) -> Result<(), String> {
    let (active, open): (Option<String>, Vec<String>) = {
        let guard = state.0.lock().map_err(to_message)?;
        let active = guard.active.map(|i| guard.sessions[i].path.clone());
        (
            active,
            guard.sessions.iter().map(|s| s.path.clone()).collect(),
        )
    };
    state
        .1
        .cancel(|path| active.as_deref() == Some(path) || !open.iter().any(|p| p == path));
    Ok(())
}

/// `git clone` `url` into `dest` as `options` say (see `gitp_core::clone_repo`),
/// reporting progress and offering Cancel like a fetch. The frontend opens the
/// result as a tab the way it opens any folder.
pub(crate) fn clone_repository_impl(
    state: &RepoState,
    url: String,
    dest: String,
    options: CloneOptions,
) -> Result<String, String> {
    run_networked_unopened(state, "clone", &dest, |hooks| {
        gitp_core::clone_repo(&url, Path::new(&dest), &options, hooks)
    })
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
pub(crate) fn fetch_all(
    background: Option<bool>,
    state: State<RepoState>,
) -> Result<String, String> {
    fetch_all_impl(&state, background.unwrap_or(false))
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
pub(crate) fn clone_repository(
    url: String,
    dest: String,
    options: CloneOptions,
    state: State<RepoState>,
) -> Result<String, String> {
    clone_repository_impl(&state, url, dest, options)
}

#[tauri::command(async)]
pub(crate) fn cancel_network_op(state: State<RepoState>) -> Result<(), String> {
    cancel_network_op_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn create_pull_request(
    branch: String,
    state: State<RepoState>,
) -> Result<String, String> {
    create_pull_request_impl(&state, branch)
}
