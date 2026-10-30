//! Handing files and URLs to the OS: the file manager, an editor, the browser.

use std::path::{Component, Path, PathBuf};

use tauri::State;

use crate::state::{to_message, with_repo, RepoState};

/// The absolute path of the repo-relative `path`, refusing one that would
/// land outside the working tree. `Path::join` replaces the base with an
/// absolute `path`, and `..` climbs out of it; the frontend only ever sends
/// paths from `git status` and the commit trees, so anything else is a bug or
/// an injected value, and not something to hand to the OS.
fn repo_path(state: &RepoState, path: &str) -> Result<PathBuf, String> {
    let rel = Path::new(path);
    let inside = !rel.as_os_str().is_empty()
        && rel
            .components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if !inside {
        return Err(format!("not a path inside the repository: {path}"));
    }
    with_repo(state, |repo| Ok(repo.workdir_path()?.join(rel)))
}

/// Reveal the repo-relative `path` in the OS file manager, selecting the file.
fn reveal_path_impl(state: &RepoState, path: String) -> Result<(), String> {
    let full = repo_path(state, &path)?;
    reveal_in_file_manager(&full)
}

/// Open the repo-relative `path` for editing: prefer VS Code (the `code` CLI)
/// when it's on PATH, since the OS's registered default app for a file type
/// is often not an editor at all (e.g. a terminal app claiming shell scripts).
/// Falls back to the OS default application otherwise.
fn open_in_editor_impl(state: &RepoState, path: String) -> Result<(), String> {
    let full = repo_path(state, &path)?;
    if std::process::Command::new("code")
        .arg(&full)
        .spawn()
        .is_ok()
    {
        return Ok(());
    }
    open_in_default_app(&full)
}

/// Open `url` in the OS default browser. Only web URLs: `open` would just as
/// readily run a `file:` path or any registered scheme, and the URL is derived
/// from the remote's configured URL, which the repo's author chose.
pub(crate) fn open_in_browser(url: &str) -> std::io::Result<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("not a web URL: {url}"),
        ));
    }
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
fn reveal_in_file_manager(full: &Path) -> Result<(), String> {
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
fn open_in_default_app(full: &Path) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::make_repo;
    use crate::workspace::open_repo_impl;

    #[test]
    fn repo_paths_stay_inside_the_working_tree() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).unwrap();

        let inside = repo_path(&state, "src/main.rs").unwrap();
        assert!(inside.is_absolute());
        assert!(inside.ends_with("src/main.rs"), "{}", inside.display());

        for bad in ["", "/etc/passwd", "../outside.txt", "src/../../x", ".."] {
            let err = repo_path(&state, bad).unwrap_err();
            assert!(err.contains("not a path inside"), "{bad}: {err}");
        }
    }

    #[test]
    fn only_web_urls_are_handed_to_the_browser() {
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ssh://host/x",
            "-R",
        ] {
            assert!(open_in_browser(url).is_err(), "{url}");
        }
    }
}
