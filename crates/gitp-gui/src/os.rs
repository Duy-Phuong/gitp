//! Handing files and URLs to the OS: the file manager, an editor, the browser.

use tauri::State;

use crate::state::{to_message, with_repo, RepoState};

/// Reveal the repo-relative `path` in the OS file manager, selecting the file.
fn reveal_path_impl(state: &RepoState, path: String) -> Result<(), String> {
    let full = with_repo(state, |repo| Ok(repo.workdir_path()?.join(&path)))?;
    reveal_in_file_manager(&full)
}

/// Open the repo-relative `path` for editing: prefer VS Code (the `code` CLI)
/// when it's on PATH, since the OS's registered default app for a file type
/// is often not an editor at all (e.g. a terminal app claiming shell scripts).
/// Falls back to the OS default application otherwise.
fn open_in_editor_impl(state: &RepoState, path: String) -> Result<(), String> {
    let full = with_repo(state, |repo| Ok(repo.workdir_path()?.join(&path)))?;
    if std::process::Command::new("code")
        .arg(&full)
        .spawn()
        .is_ok()
    {
        return Ok(());
    }
    open_in_default_app(&full)
}

/// Open `url` in the OS default browser.
pub(crate) fn open_in_browser(url: &str) -> std::io::Result<()> {
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

/// Open the OS file manager with `full` selected (macOS Finder / Windows
/// Explorer), falling back to opening its parent directory elsewhere.
fn reveal_in_file_manager(full: &std::path::Path) -> Result<(), String> {
    use std::process::Command;
    let spawn = |mut cmd: Command| cmd.spawn().map(|_| ()).map_err(to_message);
    if cfg!(target_os = "macos") {
        let mut cmd = Command::new("open");
        cmd.arg("-R").arg(full);
        spawn(cmd)
    } else if cfg!(target_os = "windows") {
        let mut cmd = Command::new("explorer");
        cmd.arg(format!("/select,{}", full.display()));
        spawn(cmd)
    } else {
        let dir = full.parent().unwrap_or(full);
        let mut cmd = Command::new("xdg-open");
        cmd.arg(dir);
        spawn(cmd)
    }
}

/// Open `full` with the OS default application for its file type.
fn open_in_default_app(full: &std::path::Path) -> Result<(), String> {
    use std::process::Command;
    let spawn = |mut cmd: Command| cmd.spawn().map(|_| ()).map_err(to_message);
    if cfg!(target_os = "macos") {
        let mut cmd = Command::new("open");
        cmd.arg(full);
        spawn(cmd)
    } else if cfg!(target_os = "windows") {
        let mut cmd = Command::new("explorer");
        cmd.arg(full);
        spawn(cmd)
    } else {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(full);
        spawn(cmd)
    }
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn reveal_path(path: String, state: State<RepoState>) -> Result<(), String> {
    reveal_path_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn open_in_editor(path: String, state: State<RepoState>) -> Result<(), String> {
    open_in_editor_impl(&state, path)
}
