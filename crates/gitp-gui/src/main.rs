// Prevent a console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! gitp desktop backend. Thin Tauri adapter over `gitp-core`, plus an embedded
//! PTY terminal. All git logic lives in `gitp-core`; this file only translates
//! IPC calls and streams the terminal.

mod terminal;

use std::sync::Mutex;

use gitp_core::{CommitDetail, CommitRow, ConfigEntry, ConfigScope, LogOptions, Repo};
use tauri::State;

use terminal::TerminalState;

/// The currently-open repository (if any).
#[derive(Default)]
struct RepoState(Mutex<Option<Repo>>);

fn to_message<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

/// Run `f` against the open repo, or return an error string if none is open.
fn with_repo<T>(state: &RepoState, f: impl FnOnce(&Repo) -> gitp_core::Result<T>) -> Result<T, String> {
    let guard = state.0.lock().map_err(to_message)?;
    let repo = guard.as_ref().ok_or("no repository is open")?;
    f(repo).map_err(to_message)
}

#[tauri::command]
fn open_repo(path: String, state: State<RepoState>) -> Result<String, String> {
    let repo = Repo::open(&path).map_err(to_message)?;
    *state.0.lock().map_err(to_message)? = Some(repo);
    Ok(path)
}

#[tauri::command]
fn get_log(max_count: Option<usize>, state: State<RepoState>) -> Result<Vec<CommitRow>, String> {
    with_repo(&state, |repo| repo.log(LogOptions { max_count }))
}

#[tauri::command]
fn get_commit_detail(rev: String, state: State<RepoState>) -> Result<CommitDetail, String> {
    with_repo(&state, |repo| repo.commit_detail(&rev))
}

#[tauri::command]
fn get_config(state: State<RepoState>) -> Result<Vec<ConfigEntry>, String> {
    with_repo(&state, |repo| repo.read_config())
}

#[tauri::command]
fn set_config(
    scope: ConfigScope,
    name: String,
    value: String,
    state: State<RepoState>,
) -> Result<(), String> {
    with_repo(&state, |repo| repo.set_config(scope, &name, &value))
}

fn main() {
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
