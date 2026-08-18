//! gitp desktop backend. Thin Tauri adapter over `gitp-core`, plus an embedded
//! PTY terminal. All git logic lives in `gitp-core`; this crate only translates
//! IPC calls and streams the terminal.
//!
//! Each command delegates to a plain `*_impl` function that takes `&RepoState`,
//! so the open→log→detail flow (including repo switching) is unit-testable
//! without a Tauri runtime.

pub mod terminal;

use std::path::Path;
use std::sync::Mutex;

use gitp_core::{
    BlameLine, CommitDetail, CommitRow, ConfigEntry, ConfigScope, FileCommit, FileDiff, LogOptions,
    RebaseCommit, RebaseStep, Refs, Repo, ResetMode, StatusLists,
};
use serde::Serialize;
use tauri::State;

use terminal::TerminalState;

/// An open repository plus its lazily-computed, cached full log. The log is
/// computed once (the expensive walk) so pages can be served cheaply and with
/// globally-consistent graph lanes.
struct Session {
    path: String,
    name: String,
    repo: Repo,
    log: Option<Vec<CommitRow>>,
}

/// All open repositories plus which one is active. Commands that read a repo
/// (log, detail, config) operate on the active session.
#[derive(Default)]
struct Workspace {
    sessions: Vec<Session>,
    active: Option<usize>,
}

impl Workspace {
    fn view(&self) -> WorkspaceView {
        WorkspaceView {
            repos: self
                .sessions
                .iter()
                .map(|s| RepoTab {
                    path: s.path.clone(),
                    name: s.name.clone(),
                })
                .collect(),
            active: self.active,
        }
    }
}

/// The set of open repositories (a workspace of tabs).
#[derive(Default)]
pub struct RepoState(Mutex<Workspace>);

/// One open repository as shown in the tab bar.
#[derive(Serialize, Clone)]
pub struct RepoTab {
    path: String,
    name: String,
}

/// The open repos and the active index — the frontend renders its tab bar from this.
#[derive(Serialize)]
pub struct WorkspaceView {
    repos: Vec<RepoTab>,
    active: Option<usize>,
}

/// A page of log rows plus the total count, so the frontend knows when to stop.
#[derive(Serialize)]
pub struct LogPage {
    rows: Vec<CommitRow>,
    total: usize,
}

fn to_message<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

/// A tab label like `mideal (Documents)`: the repo folder plus its parent.
fn display_name(path: &str) -> String {
    let p = Path::new(path);
    let base = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string();
    match p.parent().and_then(Path::file_name).and_then(|s| s.to_str()) {
        Some(parent) if !parent.is_empty() => format!("{base} ({parent})"),
        _ => base,
    }
}

/// Run `f` against the active repo, or return an error string if none is open.
fn with_repo<T>(
    state: &RepoState,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
) -> Result<T, String> {
    let guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    f(&guard.sessions[idx].repo).map_err(to_message)
}

// --- Command logic (runtime-agnostic, unit-testable) -----------------------

/// Open `path` as a new tab (or switch to it if already open) and make it active.
fn open_repo_impl(state: &RepoState, path: String) -> Result<WorkspaceView, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    if let Some(i) = guard.sessions.iter().position(|s| s.path == path) {
        guard.active = Some(i);
        return Ok(guard.view());
    }
    let repo = Repo::open(&path).map_err(to_message)?;
    let name = display_name(&path);
    guard.sessions.push(Session {
        path,
        name,
        repo,
        log: None,
    });
    guard.active = Some(guard.sessions.len() - 1);
    Ok(guard.view())
}

fn list_repos_impl(state: &RepoState) -> Result<WorkspaceView, String> {
    Ok(state.0.lock().map_err(to_message)?.view())
}

/// Switch the active tab to the open repo at `path`.
fn activate_repo_impl(state: &RepoState, path: String) -> Result<WorkspaceView, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let i = guard
        .sessions
        .iter()
        .position(|s| s.path == path)
        .ok_or("repository is not open")?;
    guard.active = Some(i);
    Ok(guard.view())
}

/// Close the tab for `path`, keeping the active selection sensible.
fn close_repo_impl(state: &RepoState, path: String) -> Result<WorkspaceView, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let i = guard
        .sessions
        .iter()
        .position(|s| s.path == path)
        .ok_or("repository is not open")?;
    guard.sessions.remove(i);
    guard.active = match guard.active {
        _ if guard.sessions.is_empty() => None,
        Some(a) if i < a => Some(a - 1),
        Some(a) => Some(a.min(guard.sessions.len() - 1)),
        None => None,
    };
    Ok(guard.view())
}

/// Return the `[offset, offset+limit)` slice of the active repo's log, computing
/// and caching the full log on first use so lanes are consistent across pages.
fn get_log_page_impl(state: &RepoState, offset: usize, limit: usize) -> Result<LogPage, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    if session.log.is_none() {
        let rows = session
            .repo
            .log(LogOptions::default())
            .map_err(to_message)?;
        session.log = Some(rows);
    }
    let log = session.log.as_ref().unwrap();
    let total = log.len();
    let end = offset.saturating_add(limit).min(total);
    let rows = log.get(offset..end).map(<[_]>::to_vec).unwrap_or_default();
    Ok(LogPage { rows, total })
}

fn get_commit_detail_impl(state: &RepoState, rev: String) -> Result<CommitDetail, String> {
    with_repo(state, |repo| repo.commit_detail(&rev))
}

fn get_refs_impl(state: &RepoState) -> Result<Refs, String> {
    with_repo(state, Repo::refs)
}

fn get_local_change_count_impl(state: &RepoState) -> Result<usize, String> {
    with_repo(state, Repo::local_change_count)
}

fn get_working_changes_impl(state: &RepoState) -> Result<Vec<FileDiff>, String> {
    with_repo(state, Repo::working_changes)
}

fn get_status_impl(state: &RepoState) -> Result<StatusLists, String> {
    with_repo(state, Repo::status_lists)
}

fn get_status_summary_impl(state: &RepoState) -> Result<StatusLists, String> {
    with_repo(state, Repo::status_summary)
}

fn get_file_diff_impl(
    state: &RepoState,
    path: String,
    staged: bool,
) -> Result<Option<FileDiff>, String> {
    with_repo(state, |repo| repo.file_diff(&path, staged))
}

fn stage_impl(state: &RepoState, path: String) -> Result<(), String> {
    with_repo(state, |repo| repo.stage(&path))
}

fn unstage_impl(state: &RepoState, path: String) -> Result<(), String> {
    with_repo(state, |repo| repo.unstage(&path))
}

fn stage_hunk_impl(state: &RepoState, path: String, hunk_index: usize) -> Result<(), String> {
    with_repo(state, |repo| repo.stage_hunk(&path, hunk_index))
}

fn unstage_hunk_impl(state: &RepoState, path: String, hunk_index: usize) -> Result<(), String> {
    with_repo(state, |repo| repo.unstage_hunk(&path, hunk_index))
}

fn discard_hunk_impl(state: &RepoState, path: String, hunk_index: usize) -> Result<(), String> {
    with_repo(state, |repo| repo.discard_hunk(&path, hunk_index))
}

fn stage_all_impl(state: &RepoState) -> Result<(), String> {
    with_repo(state, Repo::stage_all)
}

fn unstage_all_impl(state: &RepoState) -> Result<(), String> {
    with_repo(state, Repo::unstage_all)
}

/// Commit the staged changes. Invalidates the cached log because HEAD moves.
fn commit_changes_impl(
    state: &RepoState,
    subject: String,
    body: String,
    amend: bool,
) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let output = session.repo.commit(&subject, &body, amend).map_err(to_message)?;
    session.log = None;
    Ok(output)
}

/// Check out `name` on the active repo. Invalidates the cached log because HEAD
/// moves, so the next `get_log_page` recomputes the walk from the new HEAD.
fn checkout_branch_impl(state: &RepoState, name: String) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    session.repo.checkout_branch(&name).map_err(to_message)?;
    session.log = None;
    Ok(())
}

/// Create branch `name` from the current HEAD and check it out. Invalidates the
/// cached log because HEAD moves to the new branch.
fn create_branch_impl(state: &RepoState, name: String) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    session.repo.create_branch(&name).map_err(to_message)?;
    session.log = None;
    Ok(())
}

/// `git pull` the active repo. Invalidates the cached log because pulling can
/// bring in new commits. Returns git's output for display.
fn pull_impl(state: &RepoState) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let output = session.repo.pull().map_err(to_message)?;
    session.log = None;
    Ok(output)
}

/// `git push` the active repo's current branch. Returns git's output.
fn push_impl(state: &RepoState) -> Result<String, String> {
    with_repo(state, Repo::push)
}

/// `git stash` the active repo's local changes. Returns git's output.
fn stash_impl(state: &RepoState) -> Result<String, String> {
    with_repo(state, Repo::stash)
}

/// `git stash pop` on the active repo. Returns git's output.
fn stash_pop_impl(state: &RepoState) -> Result<String, String> {
    with_repo(state, Repo::stash_pop)
}

/// Every file path in `rev`'s tree, for the File Tree view.
fn get_commit_tree_impl(state: &RepoState, rev: String) -> Result<Vec<String>, String> {
    with_repo(state, |repo| repo.commit_tree(&rev))
}

/// Per-line blame for `path` as of `rev`.
fn get_blame_impl(state: &RepoState, rev: String, path: String) -> Result<Vec<BlameLine>, String> {
    with_repo(state, |repo| repo.blame(&rev, &path))
}

/// Commits that changed `path`, up to `rev`.
fn get_file_history_impl(
    state: &RepoState,
    rev: String,
    path: String,
) -> Result<Vec<FileCommit>, String> {
    with_repo(state, |repo| repo.file_history(&rev, &path))
}

fn get_config_impl(state: &RepoState) -> Result<Vec<ConfigEntry>, String> {
    with_repo(state, |repo| repo.read_config())
}

fn set_config_impl(
    state: &RepoState,
    scope: ConfigScope,
    name: String,
    value: String,
) -> Result<(), String> {
    with_repo(state, |repo| repo.set_config(scope, &name, &value))
}

/// Run `f` against the active repo and then invalidate its cached log, for
/// operations that move HEAD or rewrite history (so the next `get_log_page`
/// recomputes the walk). Errors if no repository is open.
fn with_active_repo_invalidating<T>(
    state: &RepoState,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let out = f(&session.repo).map_err(to_message)?;
    session.log = None;
    Ok(out)
}

/// Detach HEAD onto `rev`. Invalidates the cached log because HEAD moves.
fn checkout_commit_impl(state: &RepoState, rev: String) -> Result<String, String> {
    with_active_repo_invalidating(state, |repo| repo.checkout_commit(&rev))
}

/// Create branch `name` at `rev` and check it out. Invalidates the cached log.
fn create_branch_at_impl(state: &RepoState, name: String, rev: String) -> Result<String, String> {
    with_active_repo_invalidating(state, |repo| repo.create_branch_at(&name, &rev))
}

/// Tag `rev` as `name`. HEAD doesn't move, so the log cache is left intact.
fn create_tag_at_impl(state: &RepoState, name: String, rev: String) -> Result<String, String> {
    with_repo(state, |repo| repo.create_tag_at(&name, &rev))
}

/// Cherry-pick `rev` onto the current branch. Invalidates the cached log.
fn cherry_pick_impl(state: &RepoState, rev: String) -> Result<String, String> {
    with_active_repo_invalidating(state, |repo| repo.cherry_pick(&rev))
}

/// Revert `rev` on the current branch. Invalidates the cached log.
fn revert_impl(state: &RepoState, rev: String) -> Result<String, String> {
    with_active_repo_invalidating(state, |repo| repo.revert(&rev))
}

/// Reset the current branch to `rev`. Invalidates the cached log.
fn reset_impl(state: &RepoState, rev: String, mode: ResetMode) -> Result<String, String> {
    with_active_repo_invalidating(state, |repo| repo.reset(&rev, mode))
}

/// Rebase the current branch onto `rev`. Invalidates the cached log.
fn rebase_onto_impl(state: &RepoState, rev: String) -> Result<String, String> {
    with_active_repo_invalidating(state, |repo| repo.rebase_onto(&rev))
}

/// Rename branch `old` to `new`. Invalidates the cached log (HEAD's branch name
/// may change).
fn rename_branch_impl(state: &RepoState, old: String, new: String) -> Result<String, String> {
    with_active_repo_invalidating(state, |repo| repo.rename_branch(&old, &new))
}

/// Delete branch `name` (force = `-D`). Doesn't move HEAD, so the log stays.
fn delete_branch_impl(state: &RepoState, name: String, force: bool) -> Result<String, String> {
    with_repo(state, |repo| repo.delete_branch(&name, force))
}

/// Merge `name` into the current branch. Invalidates the cached log.
fn merge_branch_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_active_repo_invalidating(state, |repo| repo.merge_branch(&name))
}

/// Push branch `name` to origin. No local change to the log.
fn push_branch_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_repo(state, |repo| repo.push_branch(&name))
}

/// Fast-forward `name` to its upstream. Invalidates the cached log (it may be
/// the current branch).
fn fast_forward_branch_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_active_repo_invalidating(state, |repo| repo.fast_forward_branch(&name))
}

/// Set `branch`'s upstream. No commit change, so the log stays.
fn set_upstream_impl(state: &RepoState, branch: String, upstream: String) -> Result<String, String> {
    with_repo(state, |repo| repo.set_upstream(&branch, &upstream))
}

/// Clear `branch`'s upstream.
fn unset_upstream_impl(state: &RepoState, branch: String) -> Result<String, String> {
    with_repo(state, |repo| repo.unset_upstream(&branch))
}

/// Compute the pull/merge-request URL for `branch` and open it in the default
/// browser. Returns the URL for display.
fn create_pull_request_impl(state: &RepoState, branch: String) -> Result<String, String> {
    let url = with_repo(state, |repo| repo.pull_request_url(&branch))?;
    open_in_browser(&url).map_err(|e| e.to_string())?;
    Ok(url)
}

/// The commits that a rebase onto `onto` would replay, for the editor UI.
fn get_rebase_todo_impl(state: &RepoState, onto: String) -> Result<Vec<RebaseCommit>, String> {
    with_repo(state, |repo| repo.rebase_todo(&onto))
}

/// Run an interactive rebase onto `onto` following `steps`. Invalidates the log.
fn interactive_rebase_impl(
    state: &RepoState,
    onto: String,
    steps: Vec<RebaseStep>,
) -> Result<String, String> {
    with_active_repo_invalidating(state, |repo| repo.interactive_rebase(&onto, &steps))
}

/// Open `url` in the OS default browser.
fn open_in_browser(url: &str) -> std::io::Result<()> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program).arg(url).spawn()?;
    Ok(())
}

// --- Tauri command wrappers -------------------------------------------------

#[tauri::command]
fn open_repo(path: String, state: State<RepoState>) -> Result<WorkspaceView, String> {
    open_repo_impl(&state, path)
}

#[tauri::command]
fn list_repos(state: State<RepoState>) -> Result<WorkspaceView, String> {
    list_repos_impl(&state)
}

#[tauri::command]
fn activate_repo(path: String, state: State<RepoState>) -> Result<WorkspaceView, String> {
    activate_repo_impl(&state, path)
}

#[tauri::command]
fn close_repo(path: String, state: State<RepoState>) -> Result<WorkspaceView, String> {
    close_repo_impl(&state, path)
}

#[tauri::command]
fn get_log_page(offset: usize, limit: usize, state: State<RepoState>) -> Result<LogPage, String> {
    get_log_page_impl(&state, offset, limit)
}

#[tauri::command]
fn get_commit_detail(rev: String, state: State<RepoState>) -> Result<CommitDetail, String> {
    get_commit_detail_impl(&state, rev)
}

#[tauri::command]
fn get_refs(state: State<RepoState>) -> Result<Refs, String> {
    get_refs_impl(&state)
}

#[tauri::command]
fn get_local_change_count(state: State<RepoState>) -> Result<usize, String> {
    get_local_change_count_impl(&state)
}

#[tauri::command]
fn get_working_changes(state: State<RepoState>) -> Result<Vec<FileDiff>, String> {
    get_working_changes_impl(&state)
}

#[tauri::command]
fn get_status(state: State<RepoState>) -> Result<StatusLists, String> {
    get_status_impl(&state)
}

#[tauri::command]
fn get_status_summary(state: State<RepoState>) -> Result<StatusLists, String> {
    get_status_summary_impl(&state)
}

#[tauri::command]
fn get_file_diff(
    path: String,
    staged: bool,
    state: State<RepoState>,
) -> Result<Option<FileDiff>, String> {
    get_file_diff_impl(&state, path, staged)
}

#[tauri::command]
fn stage(path: String, state: State<RepoState>) -> Result<(), String> {
    stage_impl(&state, path)
}

#[tauri::command]
fn unstage(path: String, state: State<RepoState>) -> Result<(), String> {
    unstage_impl(&state, path)
}

#[tauri::command]
fn stage_hunk(path: String, hunk_index: usize, state: State<RepoState>) -> Result<(), String> {
    stage_hunk_impl(&state, path, hunk_index)
}

#[tauri::command]
fn unstage_hunk(path: String, hunk_index: usize, state: State<RepoState>) -> Result<(), String> {
    unstage_hunk_impl(&state, path, hunk_index)
}

#[tauri::command]
fn discard_hunk(path: String, hunk_index: usize, state: State<RepoState>) -> Result<(), String> {
    discard_hunk_impl(&state, path, hunk_index)
}

#[tauri::command]
fn stage_all(state: State<RepoState>) -> Result<(), String> {
    stage_all_impl(&state)
}

#[tauri::command]
fn unstage_all(state: State<RepoState>) -> Result<(), String> {
    unstage_all_impl(&state)
}

#[tauri::command]
fn commit_changes(
    subject: String,
    body: String,
    amend: bool,
    state: State<RepoState>,
) -> Result<String, String> {
    commit_changes_impl(&state, subject, body, amend)
}

#[tauri::command]
fn checkout_branch(name: String, state: State<RepoState>) -> Result<(), String> {
    checkout_branch_impl(&state, name)
}

#[tauri::command]
fn create_branch(name: String, state: State<RepoState>) -> Result<(), String> {
    create_branch_impl(&state, name)
}

#[tauri::command]
fn checkout_commit(rev: String, state: State<RepoState>) -> Result<String, String> {
    checkout_commit_impl(&state, rev)
}

#[tauri::command]
fn create_branch_at(name: String, rev: String, state: State<RepoState>) -> Result<String, String> {
    create_branch_at_impl(&state, name, rev)
}

#[tauri::command]
fn create_tag_at(name: String, rev: String, state: State<RepoState>) -> Result<String, String> {
    create_tag_at_impl(&state, name, rev)
}

#[tauri::command]
fn cherry_pick(rev: String, state: State<RepoState>) -> Result<String, String> {
    cherry_pick_impl(&state, rev)
}

#[tauri::command]
fn revert(rev: String, state: State<RepoState>) -> Result<String, String> {
    revert_impl(&state, rev)
}

#[tauri::command]
fn reset(rev: String, mode: ResetMode, state: State<RepoState>) -> Result<String, String> {
    reset_impl(&state, rev, mode)
}

#[tauri::command]
fn rebase_onto(rev: String, state: State<RepoState>) -> Result<String, String> {
    rebase_onto_impl(&state, rev)
}

#[tauri::command]
fn rename_branch(old: String, new: String, state: State<RepoState>) -> Result<String, String> {
    rename_branch_impl(&state, old, new)
}

#[tauri::command]
fn delete_branch(name: String, force: bool, state: State<RepoState>) -> Result<String, String> {
    delete_branch_impl(&state, name, force)
}

#[tauri::command]
fn merge_branch(name: String, state: State<RepoState>) -> Result<String, String> {
    merge_branch_impl(&state, name)
}

#[tauri::command]
fn push_branch(name: String, state: State<RepoState>) -> Result<String, String> {
    push_branch_impl(&state, name)
}

#[tauri::command]
fn fast_forward_branch(name: String, state: State<RepoState>) -> Result<String, String> {
    fast_forward_branch_impl(&state, name)
}

#[tauri::command]
fn set_upstream(branch: String, upstream: String, state: State<RepoState>) -> Result<String, String> {
    set_upstream_impl(&state, branch, upstream)
}

#[tauri::command]
fn unset_upstream(branch: String, state: State<RepoState>) -> Result<String, String> {
    unset_upstream_impl(&state, branch)
}

#[tauri::command]
fn create_pull_request(branch: String, state: State<RepoState>) -> Result<String, String> {
    create_pull_request_impl(&state, branch)
}

#[tauri::command]
fn get_rebase_todo(onto: String, state: State<RepoState>) -> Result<Vec<RebaseCommit>, String> {
    get_rebase_todo_impl(&state, onto)
}

#[tauri::command]
fn interactive_rebase(
    onto: String,
    steps: Vec<RebaseStep>,
    state: State<RepoState>,
) -> Result<String, String> {
    interactive_rebase_impl(&state, onto, steps)
}

#[tauri::command]
fn pull(state: State<RepoState>) -> Result<String, String> {
    pull_impl(&state)
}

#[tauri::command]
fn push(state: State<RepoState>) -> Result<String, String> {
    push_impl(&state)
}

#[tauri::command]
fn stash(state: State<RepoState>) -> Result<String, String> {
    stash_impl(&state)
}

#[tauri::command]
fn stash_pop(state: State<RepoState>) -> Result<String, String> {
    stash_pop_impl(&state)
}

#[tauri::command]
fn get_commit_tree(rev: String, state: State<RepoState>) -> Result<Vec<String>, String> {
    get_commit_tree_impl(&state, rev)
}

#[tauri::command]
fn get_blame(rev: String, path: String, state: State<RepoState>) -> Result<Vec<BlameLine>, String> {
    get_blame_impl(&state, rev, path)
}

#[tauri::command]
fn get_file_history(
    rev: String,
    path: String,
    state: State<RepoState>,
) -> Result<Vec<FileCommit>, String> {
    get_file_history_impl(&state, rev, path)
}

#[tauri::command]
fn get_config(state: State<RepoState>) -> Result<Vec<ConfigEntry>, String> {
    get_config_impl(&state)
}

#[tauri::command]
fn set_config(
    scope: ConfigScope,
    name: String,
    value: String,
    state: State<RepoState>,
) -> Result<(), String> {
    set_config_impl(&state, scope, name, value)
}

/// Build and run the desktop app.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(RepoState::default())
        .manage(TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            open_repo,
            list_repos,
            activate_repo,
            close_repo,
            get_log_page,
            get_commit_detail,
            get_refs,
            get_local_change_count,
            get_working_changes,
            get_status,
            get_status_summary,
            get_file_diff,
            stage,
            unstage,
            stage_hunk,
            unstage_hunk,
            discard_hunk,
            stage_all,
            unstage_all,
            commit_changes,
            checkout_branch,
            create_branch,
            checkout_commit,
            create_branch_at,
            create_tag_at,
            cherry_pick,
            revert,
            reset,
            rebase_onto,
            rename_branch,
            delete_branch,
            merge_branch,
            push_branch,
            fast_forward_branch,
            set_upstream,
            unset_upstream,
            create_pull_request,
            get_rebase_todo,
            interactive_rebase,
            pull,
            push,
            stash,
            stash_pop,
            get_commit_tree,
            get_blame,
            get_file_history,
            get_config,
            set_config,
            terminal::terminal_spawn,
            terminal::terminal_write,
            terminal::terminal_resize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running gitp");
}

#[cfg(test)]
mod tests {
    use super::{
        activate_repo_impl, close_repo_impl, get_commit_detail_impl, get_log_page_impl,
        list_repos_impl, open_repo_impl, RepoState,
    };
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed");
    }

    /// Build a temp repo whose commits each rewrite `f.txt`.
    fn make_repo(dir: &Path, messages: &[&str]) {
        git(dir, &["init", "-q"]);
        git(dir, &["config", "user.email", "t@t.io"]);
        git(dir, &["config", "user.name", "Tester"]);
        for (i, msg) in messages.iter().enumerate() {
            std::fs::write(dir.join("f.txt"), format!("line {i}\n")).unwrap();
            git(dir, &["add", "f.txt"]);
            git(dir, &["commit", "-q", "-m", msg]);
        }
    }

    #[test]
    fn switching_repos_shows_the_new_repos_commits_and_diffs() {
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();
        make_repo(dir_a.path(), &["a1", "a2", "a3"]); // 3 commits
        make_repo(dir_b.path(), &["b1", "b2", "b3", "b4", "b5"]); // 5 commits

        // One long-lived state, like the running app: open A, then switch to B.
        let state = RepoState::default();

        open_repo_impl(&state, dir_a.path().to_str().unwrap().to_string()).expect("open A");
        let log_a = get_log_page_impl(&state, 0, 1000).expect("log A");
        assert_eq!(log_a.total, 3, "repo A has 3 commits");
        let detail_a = get_commit_detail_impl(&state, log_a.rows[0].id.clone()).expect("detail A");
        assert!(!detail_a.files.is_empty(), "A's head commit has changes");

        // The switch that was reported broken.
        open_repo_impl(&state, dir_b.path().to_str().unwrap().to_string()).expect("open B");
        let log_b = get_log_page_impl(&state, 0, 1000).expect("log B");
        assert_eq!(log_b.total, 5, "after switching, log shows repo B's 5 commits");
        let detail_b = get_commit_detail_impl(&state, log_b.rows[0].id.clone()).expect("detail B");
        assert!(
            !detail_b.files.is_empty(),
            "B's head commit changes should show after switching repos"
        );
        assert_eq!(detail_b.summary, "b5");
    }

    #[test]
    fn paging_returns_consistent_slices_over_the_cached_log() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1", "c2", "c3", "c4", "c5"]); // 5 commits, newest c5

        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        let p0 = get_log_page_impl(&state, 0, 2).expect("page 0");
        assert_eq!(p0.total, 5);
        assert_eq!(p0.rows.len(), 2);
        assert_eq!(p0.rows[0].summary, "c5", "newest first");

        let p1 = get_log_page_impl(&state, 2, 2).expect("page 1");
        assert_eq!(p1.rows.len(), 2);
        assert_eq!(p1.rows[0].summary, "c3");

        // Pages are contiguous, non-overlapping slices of one cached walk.
        let p2 = get_log_page_impl(&state, 4, 2).expect("page 2");
        assert_eq!(p2.rows.len(), 1, "last partial page");
        assert_eq!(p2.rows[0].summary, "c1");

        let past_end = get_log_page_impl(&state, 10, 2).expect("past end");
        assert!(past_end.rows.is_empty());
        assert_eq!(past_end.total, 5);
    }

    #[test]
    fn multiple_repos_open_as_tabs_and_can_be_switched_and_closed() {
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();
        make_repo(dir_a.path(), &["a1", "a2"]); // 2 commits
        make_repo(dir_b.path(), &["b1", "b2", "b3"]); // 3 commits
        let path_a = dir_a.path().to_str().unwrap().to_string();
        let path_b = dir_b.path().to_str().unwrap().to_string();

        let state = RepoState::default();
        open_repo_impl(&state, path_a.clone()).expect("open A");
        let ws = open_repo_impl(&state, path_b.clone()).expect("open B");
        // Both repos are open as tabs; the most recently opened is active.
        assert_eq!(ws.repos.len(), 2);
        assert_eq!(ws.active, Some(1));
        assert_eq!(get_log_page_impl(&state, 0, 100).unwrap().total, 3, "active is B");

        // Re-opening an already-open repo just switches to it (no duplicate tab).
        let ws = open_repo_impl(&state, path_a.clone()).expect("reopen A");
        assert_eq!(ws.repos.len(), 2);
        assert_eq!(ws.active, Some(0));
        assert_eq!(get_log_page_impl(&state, 0, 100).unwrap().total, 2, "active is A");

        // Switch explicitly, then close the active tab.
        activate_repo_impl(&state, path_b.clone()).expect("activate B");
        assert_eq!(get_log_page_impl(&state, 0, 100).unwrap().total, 3);
        let ws = close_repo_impl(&state, path_b).expect("close B");
        assert_eq!(ws.repos.len(), 1);
        assert_eq!(ws.repos[0].path, path_a);
        assert_eq!(get_log_page_impl(&state, 0, 100).unwrap().total, 2, "fell back to A");

        // Closing the last repo leaves no active tab.
        let ws = close_repo_impl(&state, path_a).expect("close A");
        assert!(ws.repos.is_empty());
        assert_eq!(ws.active, None);
        assert!(list_repos_impl(&state).unwrap().repos.is_empty());
    }
}
