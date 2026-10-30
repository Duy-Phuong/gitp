//! The workspace of open repository tabs, and the one-round-trip snapshot the
//! frontend refreshes after every action.

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use gitp_core::{BisectStatus, ConflictStatus, RebaseStatus, Refs, Repo, StatusLists};
use serde::Serialize;
use tauri::State;

use crate::state::{ensure_refs, ensure_status, to_message, RepoState, Session, WorkspaceView};
use crate::undo::{clear_undo, undo_view, UndoView};
use crate::watch::watch_worktree;

/// A tab label like `mideal (Documents)`: the repo folder plus its parent.
fn display_name(path: &str) -> String {
    let p = Path::new(path);
    let base = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string();
    match p
        .parent()
        .and_then(Path::file_name)
        .and_then(|s| s.to_str())
    {
        Some(parent) if !parent.is_empty() => format!("{base} ({parent})"),
        _ => base,
    }
}

/// Open `path` as a new tab (or switch to it if already open) and make it active.
pub(crate) fn open_repo_impl(state: &RepoState, path: String) -> Result<WorkspaceView, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    if let Some(i) = guard.sessions.iter().position(|s| s.path == path) {
        guard.set_active(Some(i));
        return Ok(guard.view());
    }
    let repo = Repo::open(&path).map_err(to_message)?;
    // Index snapshots from a previous run that didn't get to clean up after itself.
    repo.remove_index_snapshots();
    let name = display_name(&path);
    let live = Arc::new(AtomicBool::new(false));
    let (dirty, watcher) = watch_worktree(
        repo.workdir(),
        path.clone(),
        guard.on_change.clone(),
        Arc::clone(&live),
    );
    guard.sessions.push(Session {
        path,
        name,
        repo,
        log: None,
        log_sig: 0,
        refs_cache: None,
        status_cache: None,
        worktree_dirty: dirty,
        _watcher: watcher,
        watch_live: live,
        undo: None,
        redo: None,
    });
    let last = guard.sessions.len() - 1;
    guard.set_active(Some(last));
    Ok(guard.view())
}

/// `git init` a new repository at `path`, with an optional `.gitignore` body
/// and README (see `gitp_core::init_repo`). The frontend opens it afterwards
/// the way it opens any folder, so this doesn't touch the workspace.
fn init_repository_impl(
    path: String,
    gitignore: Option<String>,
    readme: bool,
) -> Result<(), String> {
    gitp_core::init_repo(Path::new(&path), gitignore.as_deref(), readme).map_err(to_message)
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
    guard.set_active(Some(i));
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
    clear_undo(&mut guard.sessions[i]); // removes its index snapshot files
    guard.sessions.remove(i);
    let active = match guard.active {
        _ if guard.sessions.is_empty() => None,
        Some(a) if i < a => Some(a - 1),
        Some(a) => Some(a.min(guard.sessions.len() - 1)),
        None => None,
    };
    guard.set_active(active);
    Ok(guard.view())
}

/// Everything the frontend refreshes after any action, in one round trip.
///
/// These five used to be five separate commands, each taking the global lock
/// and each a separate IPC hop. Worse, the sidebar's change count and the
/// staging area's file lists both ran `git status` — the single most expensive
/// read on a large repo — so it ran twice per action. Here it runs once and
/// the count is derived from the same lists.
#[derive(Serialize)]
pub(crate) struct WorkspaceSnapshot {
    pub(crate) refs: Refs,
    /// Distinct changed paths, for the sidebar badge (derived from `status`).
    local_changes: usize,
    /// The staging area (summaries only, no hunks) — also feeds Local Changes.
    pub(crate) status: StatusLists,
    rebase: RebaseStatus,
    conflict: ConflictStatus,
    undo: UndoView,
    /// The in-progress bisect, if any — it detaches HEAD, so the log and
    /// banner need to know.
    pub(crate) bisect: Option<BisectStatus>,
}

/// Build the post-action snapshot in one lock acquisition, running `git status`
/// exactly once (see `WorkspaceSnapshot`) — and only when something changed.
pub(crate) fn workspace_snapshot_impl(state: &RepoState) -> Result<WorkspaceSnapshot, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];

    let status = ensure_status(session)?;
    let refs = ensure_refs(session)?;
    // A path can appear in both lists (partially staged); the badge counts it once.
    let local_changes = status
        .staged
        .iter()
        .chain(&status.unstaged)
        .map(|f| f.path.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len();

    Ok(WorkspaceSnapshot {
        refs,
        local_changes,
        status,
        rebase: session.repo.rebase_status().map_err(to_message)?,
        conflict: session.repo.conflict_status().map_err(to_message)?,
        undo: undo_view(session),
        bisect: session.repo.bisect_status().map_err(to_message)?,
    })
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn open_repo(path: String, state: State<RepoState>) -> Result<WorkspaceView, String> {
    open_repo_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn init_repository(
    path: String,
    gitignore: Option<String>,
    readme: bool,
) -> Result<(), String> {
    init_repository_impl(path, gitignore, readme)
}

#[tauri::command(async)]
pub(crate) fn list_repos(state: State<RepoState>) -> Result<WorkspaceView, String> {
    list_repos_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn activate_repo(
    path: String,
    state: State<RepoState>,
) -> Result<WorkspaceView, String> {
    activate_repo_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn close_repo(path: String, state: State<RepoState>) -> Result<WorkspaceView, String> {
    close_repo_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn workspace_snapshot(state: State<RepoState>) -> Result<WorkspaceSnapshot, String> {
    workspace_snapshot_impl(&state)
}

#[cfg(test)]
mod tests {
    use super::{
        activate_repo_impl, close_repo_impl, init_repository_impl, list_repos_impl, open_repo_impl,
        workspace_snapshot_impl,
    };
    use crate::history::{get_commit_detail_impl, get_log_page_impl};
    use crate::state::RepoState;
    use crate::test_support::make_repo;

    #[test]
    fn a_freshly_initialized_repo_opens_with_an_empty_log() {
        // The frontend opens what Init made straight away: an unborn HEAD with
        // no commits must load, not fail the first snapshot.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fresh").to_str().unwrap().to_string();
        init_repository_impl(path.clone(), Some("target/\n".into()), true).expect("init");

        let state = RepoState::default();
        open_repo_impl(&state, path).expect("open");
        assert_eq!(get_log_page_impl(&state, 0, 100, true).unwrap().total, 0);
        let snapshot = workspace_snapshot_impl(&state).expect("snapshot");
        assert_eq!(
            snapshot.status.unstaged.len(),
            2,
            ".gitignore and README.md"
        );
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
        let log_a = get_log_page_impl(&state, 0, 1000, true).expect("log A");
        assert_eq!(log_a.total, 3, "repo A has 3 commits");
        let detail_a = get_commit_detail_impl(&state, log_a.rows[0].id.clone()).expect("detail A");
        assert!(!detail_a.files.is_empty(), "A's head commit has changes");

        // The switch that was reported broken.
        open_repo_impl(&state, dir_b.path().to_str().unwrap().to_string()).expect("open B");
        let log_b = get_log_page_impl(&state, 0, 1000, true).expect("log B");
        assert_eq!(
            log_b.total, 5,
            "after switching, log shows repo B's 5 commits"
        );
        let detail_b = get_commit_detail_impl(&state, log_b.rows[0].id.clone()).expect("detail B");
        assert!(
            !detail_b.files.is_empty(),
            "B's head commit changes should show after switching repos"
        );
        assert_eq!(detail_b.summary, "b5");
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
        assert_eq!(
            get_log_page_impl(&state, 0, 100, true).unwrap().total,
            3,
            "active is B"
        );

        // Re-opening an already-open repo just switches to it (no duplicate tab).
        let ws = open_repo_impl(&state, path_a.clone()).expect("reopen A");
        assert_eq!(ws.repos.len(), 2);
        assert_eq!(ws.active, Some(0));
        assert_eq!(
            get_log_page_impl(&state, 0, 100, true).unwrap().total,
            2,
            "active is A"
        );

        // Switch explicitly, then close the active tab.
        activate_repo_impl(&state, path_b.clone()).expect("activate B");
        assert_eq!(get_log_page_impl(&state, 0, 100, true).unwrap().total, 3);
        let ws = close_repo_impl(&state, path_b).expect("close B");
        assert_eq!(ws.repos.len(), 1);
        assert_eq!(ws.repos[0].path, path_a);
        assert_eq!(
            get_log_page_impl(&state, 0, 100, true).unwrap().total,
            2,
            "fell back to A"
        );

        // Closing the last repo leaves no active tab.
        let ws = close_repo_impl(&state, path_a).expect("close A");
        assert!(ws.repos.is_empty());
        assert_eq!(ws.active, None);
        assert!(list_repos_impl(&state).unwrap().repos.is_empty());
    }
}
