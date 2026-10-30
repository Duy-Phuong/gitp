//! Local workspaces: named groups of repository folders, and the bulk
//! operations the Workspaces screen runs on them (fetch, pull, a status line
//! per repo). Not to be confused with `workspace.rs`, the set of open tabs.
//!
//! The groups themselves live in the frontend's localStorage, like the recent
//! and favorite repos; the backend only ever sees one folder path at a time.
//! A workspace's repos are mostly *not* open as tabs, so everything here opens
//! its own `Repo` by path and never touches the active session.

use std::path::Path;
use std::sync::Arc;

use gitp_core::{NetworkHooks, Progress, ProgressFn, PullMode, Repo};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::state::{invalidate_status, throttled, to_message, NetworkOps, RepoState, Session};
use crate::undo::clear_undo;

/// The bulk operations in flight, kept apart from the tabs' own (`RepoState`'s
/// `NetworkOps`): the status bar's Cancel stops what runs on the active repo,
/// the Workspaces screen's Cancel stops its batch, and neither reaches the other.
#[derive(Default)]
pub(crate) struct WorkspaceOps(NetworkOps);

/// One repo's line in a workspace's table.
#[derive(Serialize, Default, Debug, PartialEq)]
pub(crate) struct RepoSummary {
    /// The folder is gone — moved or deleted since it was added.
    missing: bool,
    /// The checked-out branch; `None` when HEAD is detached or unborn.
    branch: Option<String>,
    ahead: usize,
    behind: usize,
    has_upstream: bool,
    /// Paths with uncommitted changes.
    changes: usize,
}

/// The `workspace-progress` event payload: git's progress for the repo at `path`.
#[derive(Serialize, Clone)]
struct RowProgress {
    path: String,
    #[serde(flatten)]
    progress: Progress,
}

/// Open the repository whose working tree is exactly `path`. `Repo::open`
/// alone would discover a parent repository for a plain folder inside one,
/// and a bulk pull must never land in a repo the user didn't add.
fn open_at(path: &str) -> Result<Repo, String> {
    let dir = Path::new(path);
    if !dir.is_absolute() || !dir.is_dir() {
        return Err(format!("folder not found: {path}"));
    }
    if !dir.join(".git").exists() {
        return Err(format!("not a git repository: {path}"));
    }
    let repo = Repo::open(dir).map_err(to_message)?;
    // An empty or broken `.git` passes the check above, and discovery walks
    // past it to the enclosing repository.
    let here = std::fs::canonicalize(repo.workdir()).map_err(to_message)?;
    if here != std::fs::canonicalize(dir).map_err(to_message)? {
        return Err(format!("not a git repository: {path}"));
    }
    Ok(repo)
}

/// Branch, ahead/behind and the number of changed paths of the repo at `path`;
/// `missing` instead when the folder no longer exists.
pub(crate) fn workspace_repo_summary_impl(path: &str) -> Result<RepoSummary, String> {
    if !Path::new(path).exists() {
        return Ok(RepoSummary {
            missing: true,
            ..RepoSummary::default()
        });
    }
    let repo = open_at(path)?;
    let refs = repo.refs().map_err(to_message)?;
    let head = refs.branches.iter().find(|b| b.is_head);
    Ok(RepoSummary {
        missing: false,
        branch: refs.head.clone(),
        ahead: head.map_or(0, |b| b.ahead),
        behind: head.map_or(0, |b| b.behind),
        has_upstream: head.is_some_and(|b| b.has_upstream),
        changes: repo.local_change_count().map_err(to_message)?,
    })
}

/// The repositories directly inside `folder` (one level deep, hidden folders
/// skipped), sorted, preceded by `folder` itself when it is one — for "Add
/// every repository in a folder".
pub(crate) fn workspace_scan_folder_impl(folder: &str) -> Result<Vec<String>, String> {
    let dir = Path::new(folder);
    let is_repo = |p: &Path| p.join(".git").exists();
    let mut found: Vec<String> = std::fs::read_dir(dir)
        .map_err(to_message)?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| {
            let hidden = p
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with('.'));
            !hidden && p.is_dir() && is_repo(p)
        })
        .filter_map(|p| p.to_str().map(str::to_string))
        .collect();
    found.sort();
    if is_repo(dir) {
        found.insert(0, folder.to_string());
    }
    Ok(found)
}

/// Run network operation `f` on the repo at `path` with a handle of its own,
/// cancellable through `ops` and reporting to `on_progress`, then apply `after`
/// to the tab open on that path, if any.
///
/// Credentials are never prompted for: a batch runs several repos at once, and
/// a stack of password dialogs nobody can tell apart is worse than a row that
/// says authentication failed (fetching from the repo's own tab still asks).
fn run_on_path<T>(
    state: &RepoState,
    ops: &WorkspaceOps,
    path: &str,
    on_progress: Option<ProgressFn>,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
    after: impl FnOnce(&mut Session),
) -> Result<T, String> {
    let mut repo = open_at(path)?;
    let cancel = ops.0.begin(path);
    repo.set_network_hooks(NetworkHooks {
        on_progress,
        cancel: Some(Arc::clone(&cancel)),
        askpass: None,
    });
    let out = f(&repo);
    ops.0.end(&cancel);
    // Even a failed pull may have moved HEAD (a merge stopped on conflicts).
    // The tab is matched by its resolved working tree: the workspace and the
    // tab may spell the same folder differently (/tmp vs /private/tmp, a
    // trailing slash).
    let here = std::fs::canonicalize(repo.workdir()).ok();
    let mut guard = state.0.lock().map_err(to_message)?;
    if let Some(session) = guard
        .sessions
        .iter_mut()
        .find(|s| here.is_some() && std::fs::canonicalize(s.repo.workdir()).ok() == here)
    {
        after(session);
    }
    out.map_err(to_message)
}

/// Fetch every remote of the repo at `path`. Remote-tracking refs only; a tab
/// open on it notices through its refs fingerprint.
pub(crate) fn workspace_fetch_impl(
    state: &RepoState,
    ops: &WorkspaceOps,
    path: &str,
    on_progress: Option<ProgressFn>,
) -> Result<String, String> {
    run_on_path(state, ops, path, on_progress, Repo::fetch_all, |_| {})
}

/// Pull the repo at `path` with `mode`. A tab open on it loses its undo — the
/// recorded action may no longer be the last thing that happened there — and
/// its cached status, as the working tree changed under it.
pub(crate) fn workspace_pull_impl(
    state: &RepoState,
    ops: &WorkspaceOps,
    path: &str,
    mode: PullMode,
    on_progress: Option<ProgressFn>,
) -> Result<String, String> {
    run_on_path(
        state,
        ops,
        path,
        on_progress,
        |repo| repo.pull(mode),
        |session| {
            clear_undo(session);
            invalidate_status(session);
        },
    )
}

/// Stop every bulk operation in flight; each rejects with "operation cancelled".
pub(crate) fn cancel_workspace_ops_impl(ops: &WorkspaceOps) {
    ops.0.cancel(|_| true);
}

/// Progress for the repo at `path`, as `workspace-progress` events.
fn row_progress(app: AppHandle, path: String) -> ProgressFn {
    throttled(move |p| {
        let _ = app.emit(
            "workspace-progress",
            RowProgress {
                path: path.clone(),
                progress: p.clone(),
            },
        );
    })
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn workspace_repo_summary(path: String) -> Result<RepoSummary, String> {
    workspace_repo_summary_impl(&path)
}

#[tauri::command(async)]
pub(crate) fn workspace_scan_folder(folder: String) -> Result<Vec<String>, String> {
    workspace_scan_folder_impl(&folder)
}

#[tauri::command(async)]
pub(crate) fn workspace_fetch(
    path: String,
    app: AppHandle,
    state: State<RepoState>,
    ops: State<WorkspaceOps>,
) -> Result<String, String> {
    let progress = row_progress(app, path.clone());
    workspace_fetch_impl(&state, &ops, &path, Some(progress))
}

#[tauri::command(async)]
pub(crate) fn workspace_pull(
    path: String,
    mode: PullMode,
    app: AppHandle,
    state: State<RepoState>,
    ops: State<WorkspaceOps>,
) -> Result<String, String> {
    let progress = row_progress(app, path.clone());
    workspace_pull_impl(&state, &ops, &path, mode, Some(progress))
}

#[tauri::command(async)]
pub(crate) fn cancel_workspace_ops(ops: State<WorkspaceOps>) {
    cancel_workspace_ops_impl(&ops);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{git, head_branch, make_repo};
    use crate::workspace::open_repo_impl;
    use std::sync::atomic::Ordering;

    fn path_of(dir: &Path) -> String {
        dir.to_str().unwrap().to_string()
    }

    fn head(dir: &Path) -> String {
        let out = std::process::Command::new("git")
            .current_dir(dir)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A repo pushed to a local bare remote, plus a second clone of that remote
    /// which has pushed one more commit — so the repo is one behind once it
    /// fetches. Returns (tempdir holding all three, repo path, other clone path).
    fn repo_behind_its_remote() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        let bare = root.path().join("remote.git");
        let other = root.path().join("other");
        std::fs::create_dir(&repo).unwrap();
        make_repo(&repo, &["c1"]);
        git(
            root.path(),
            &["init", "-q", "--bare", bare.to_str().unwrap()],
        );
        let branch = head_branch(&repo);
        git(&repo, &["remote", "add", "origin", bare.to_str().unwrap()]);
        git(&repo, &["push", "-q", "-u", "origin", &branch]);
        git(
            root.path(),
            &[
                "clone",
                "-q",
                bare.to_str().unwrap(),
                other.to_str().unwrap(),
            ],
        );
        git(&other, &["config", "user.email", "t@t.io"]);
        git(&other, &["config", "user.name", "Tester"]);
        std::fs::write(other.join("g.txt"), "new\n").unwrap();
        git(&other, &["add", "g.txt"]);
        git(&other, &["commit", "-q", "-m", "c2"]);
        git(&other, &["push", "-q", "origin", &branch]);
        (root, repo, other)
    }

    #[test]
    fn fetch_then_pull_a_repo_that_is_not_open() {
        let (_root, repo, other) = repo_behind_its_remote();
        let path = path_of(&repo);
        let state = RepoState::default();
        let ops = WorkspaceOps::default();

        let before = workspace_repo_summary_impl(&path).unwrap();
        assert_eq!(before.behind, 0, "nothing fetched yet");
        assert!(before.has_upstream);
        assert_eq!(before.branch.as_deref(), Some(head_branch(&repo).as_str()));

        workspace_fetch_impl(&state, &ops, &path, None).expect("fetch");
        assert_eq!(workspace_repo_summary_impl(&path).unwrap().behind, 1);

        workspace_pull_impl(&state, &ops, &path, PullMode::FastForwardOnly, None).expect("pull");
        assert_eq!(head(&repo), head(&other));
        assert_eq!(workspace_repo_summary_impl(&path).unwrap().behind, 0);
    }

    #[test]
    fn a_bulk_pull_leaves_the_active_tab_alone() {
        let (_root, repo, _other) = repo_behind_its_remote();
        let active = tempfile::tempdir().unwrap();
        make_repo(active.path(), &["a1"]);
        let state = RepoState::default();
        let ops = WorkspaceOps::default();
        // The pulled repo is open as a background tab; another is active.
        open_repo_impl(&state, path_of(&repo)).unwrap();
        open_repo_impl(&state, path_of(active.path())).unwrap();
        let active_head = head(active.path());
        let recorded = || {
            Some(gitp_core::Undoable::HeadMoved {
                label: "Commit".into(),
                before: "a".into(),
                after: "b".into(),
                mode: gitp_core::HeadMoveMode::Soft,
                backup: None,
            })
        };
        {
            let mut guard = state.0.lock().unwrap();
            guard.sessions[0].undo = recorded();
            guard.sessions[1].undo = recorded();
        }

        workspace_pull_impl(&state, &ops, &path_of(&repo), PullMode::FastForward, None)
            .expect("pull");

        let guard = state.0.lock().unwrap();
        assert_eq!(guard.active, Some(1), "the active tab didn't change");
        assert!(
            guard.sessions[0].undo.is_none(),
            "the pulled tab's undo is stale"
        );
        assert!(
            guard.sessions[1].undo.is_some(),
            "the active tab's undo is kept"
        );
        drop(guard);
        assert_eq!(head(active.path()), active_head);
    }

    #[test]
    fn a_bulk_pull_finds_the_tab_under_another_spelling_of_its_path() {
        let (_root, repo, _other) = repo_behind_its_remote();
        let state = RepoState::default();
        let ops = WorkspaceOps::default();
        open_repo_impl(&state, path_of(&repo)).unwrap();
        state.0.lock().unwrap().sessions[0].undo = Some(gitp_core::Undoable::HeadMoved {
            label: "Commit".into(),
            before: "a".into(),
            after: "b".into(),
            mode: gitp_core::HeadMoveMode::Soft,
            backup: None,
        });

        let spelled = format!("{}/", path_of(&repo));
        workspace_pull_impl(&state, &ops, &spelled, PullMode::FastForward, None).expect("pull");

        assert!(state.0.lock().unwrap().sessions[0].undo.is_none());
    }

    #[test]
    fn a_failure_is_reported_for_that_repo_only() {
        let root = tempfile::tempdir().unwrap();
        let state = RepoState::default();
        let ops = WorkspaceOps::default();
        let plain = root.path().join("plain");
        std::fs::create_dir(&plain).unwrap();

        let err = workspace_fetch_impl(&state, &ops, &path_of(&plain), None).unwrap_err();
        assert!(err.contains("not a git repository"), "{err}");
        let gone = path_of(&root.path().join("gone"));
        let err = workspace_fetch_impl(&state, &ops, &gone, None).unwrap_err();
        assert!(err.contains("folder not found"), "{err}");
        assert!(workspace_repo_summary_impl(&gone).unwrap().missing);
    }

    #[test]
    fn a_broken_git_folder_inside_a_repo_does_not_reach_the_parent() {
        let (_root, repo, _other) = repo_behind_its_remote();
        let inner = repo.join("a");
        std::fs::create_dir_all(inner.join(".git")).unwrap();
        let state = RepoState::default();
        let ops = WorkspaceOps::default();
        let before = head(&repo);

        let path = path_of(&inner);
        assert!(workspace_repo_summary_impl(&path).is_err());
        let err = workspace_pull_impl(&state, &ops, &path, PullMode::FastForward, None)
            .unwrap_err();
        assert!(err.contains("not a git repository"), "{err}");
        assert_eq!(head(&repo), before, "the parent repo was pulled");
    }

    #[test]
    fn a_repo_with_local_changes_counts_them() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        std::fs::write(dir.path().join("f.txt"), "edited\n").unwrap();
        std::fs::write(dir.path().join("new.txt"), "new\n").unwrap();
        let summary = workspace_repo_summary_impl(&path_of(dir.path())).unwrap();
        assert_eq!(summary.changes, 2);
        assert!(!summary.has_upstream);
    }

    #[test]
    fn cancel_reaches_bulk_ops_and_not_the_tabs() {
        let state = RepoState::default();
        let ops = WorkspaceOps::default();
        let bulk = ops.0.begin("/repos/a");
        let tab = state.1.begin("/repos/a");
        cancel_workspace_ops_impl(&ops);
        assert!(bulk.load(Ordering::SeqCst));
        assert!(!tab.load(Ordering::SeqCst));
    }

    #[test]
    fn scanning_finds_the_repos_one_level_down() {
        let root = tempfile::tempdir().unwrap();
        for name in ["b", "a", ".hidden"] {
            let dir = root.path().join(name);
            std::fs::create_dir(&dir).unwrap();
            make_repo(&dir, &["c1"]);
        }
        std::fs::create_dir(root.path().join("not-a-repo")).unwrap();
        let nested = root.path().join("not-a-repo").join("deep");
        std::fs::create_dir(&nested).unwrap();
        make_repo(&nested, &["c1"]);

        let found = workspace_scan_folder_impl(&path_of(root.path())).unwrap();
        let names: Vec<_> = found
            .iter()
            .map(|p| Path::new(p).file_name().unwrap().to_str().unwrap())
            .collect();
        assert_eq!(names, ["a", "b"]);
    }
}
