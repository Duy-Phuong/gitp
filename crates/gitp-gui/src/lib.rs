//! gitp desktop backend. Thin Tauri adapter over `gitp-core`, plus an embedded
//! PTY terminal. All git logic lives in `gitp-core`; this crate only translates
//! IPC calls and streams the terminal.
//!
//! Each command delegates to a plain `*_impl` function that takes `&RepoState`,
//! so the open→log→detail flow (including repo switching) is unit-testable
//! without a Tauri runtime.

pub mod terminal;

use std::sync::Mutex;

use gitp_core::{CommitDetail, CommitRow, ConfigEntry, ConfigScope, LogOptions, Repo};
use tauri::State;

use terminal::TerminalState;

/// The currently-open repository (if any).
#[derive(Default)]
pub struct RepoState(pub Mutex<Option<Repo>>);

fn to_message<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

/// Run `f` against the open repo, or return an error string if none is open.
fn with_repo<T>(
    state: &RepoState,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
) -> Result<T, String> {
    let guard = state.0.lock().map_err(to_message)?;
    let repo = guard.as_ref().ok_or("no repository is open")?;
    f(repo).map_err(to_message)
}

// --- Command logic (runtime-agnostic, unit-testable) -----------------------

fn open_repo_impl(state: &RepoState, path: String) -> Result<String, String> {
    let repo = Repo::open(&path).map_err(to_message)?;
    *state.0.lock().map_err(to_message)? = Some(repo);
    Ok(path)
}

fn get_log_impl(state: &RepoState, max_count: Option<usize>) -> Result<Vec<CommitRow>, String> {
    with_repo(state, |repo| repo.log(LogOptions { max_count }))
}

fn get_commit_detail_impl(state: &RepoState, rev: String) -> Result<CommitDetail, String> {
    with_repo(state, |repo| repo.commit_detail(&rev))
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

// --- Tauri command wrappers -------------------------------------------------

#[tauri::command]
fn open_repo(path: String, state: State<RepoState>) -> Result<String, String> {
    open_repo_impl(&state, path)
}

#[tauri::command]
fn get_log(max_count: Option<usize>, state: State<RepoState>) -> Result<Vec<CommitRow>, String> {
    get_log_impl(&state, max_count)
}

#[tauri::command]
fn get_commit_detail(rev: String, state: State<RepoState>) -> Result<CommitDetail, String> {
    get_commit_detail_impl(&state, rev)
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
        .manage(RepoState::default())
        .manage(TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            open_repo,
            get_log,
            get_commit_detail,
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
    use super::{get_commit_detail_impl, get_log_impl, open_repo_impl, RepoState};
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
        let log_a = get_log_impl(&state, None).expect("log A");
        assert_eq!(log_a.len(), 3, "repo A has 3 commits");
        let detail_a = get_commit_detail_impl(&state, log_a[0].id.clone()).expect("detail A");
        assert!(!detail_a.files.is_empty(), "A's head commit has changes");

        // The switch that was reported broken.
        open_repo_impl(&state, dir_b.path().to_str().unwrap().to_string()).expect("open B");
        let log_b = get_log_impl(&state, None).expect("log B");
        assert_eq!(log_b.len(), 5, "after switching, log shows repo B's 5 commits");
        let detail_b = get_commit_detail_impl(&state, log_b[0].id.clone()).expect("detail B");
        assert!(
            !detail_b.files.is_empty(),
            "B's head commit changes should show after switching repos"
        );
        assert_eq!(detail_b.summary, "b5");
    }
}
