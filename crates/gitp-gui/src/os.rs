//! Handing files and URLs to the OS: the file manager, an editor, the browser,
//! and the user's external diff / merge tools.

use std::path::{Component, Path, PathBuf};

use gitp_core::DiffToolTarget;
use serde::Serialize;
use tauri::State;

use crate::state::{to_message, with_repo, with_repo_unlocked, RepoState};

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

/// An editor or IDE the repository can be opened in (Quick Launch's "Open in
/// …"), as the frontend sees it: `id` goes back to `open_repo_in_editor`.
#[derive(Serialize)]
pub(crate) struct Editor {
    id: &'static str,
    name: &'static str,
}

/// An editor gitp knows how to find: its app bundles on macOS (several names
/// where editions differ) and its command-line launcher.
struct KnownEditor {
    id: &'static str,
    name: &'static str,
    bundles: &'static [&'static str],
    cli: &'static str,
}

/// One line per editor in `KNOWN_EDITORS`.
const fn editor(
    id: &'static str,
    name: &'static str,
    bundles: &'static [&'static str],
    cli: &'static str,
) -> KnownEditor {
    KnownEditor {
        id,
        name,
        bundles,
        cli,
    }
}

const KNOWN_EDITORS: &[KnownEditor] = &[
    editor(
        "vscode",
        "Visual Studio Code",
        &["Visual Studio Code.app"],
        "code",
    ),
    editor("cursor", "Cursor", &["Cursor.app"], "cursor"),
    editor("windsurf", "Windsurf", &["Windsurf.app"], "windsurf"),
    editor("vscodium", "VSCodium", &["VSCodium.app"], "codium"),
    editor("zed", "Zed", &["Zed.app"], "zed"),
    editor("sublime", "Sublime Text", &["Sublime Text.app"], "subl"),
    editor(
        "intellij",
        "IntelliJ IDEA",
        &[
            "IntelliJ IDEA.app",
            "IntelliJ IDEA Ultimate.app",
            "IntelliJ IDEA CE.app",
        ],
        "idea",
    ),
    editor("webstorm", "WebStorm", &["WebStorm.app"], "webstorm"),
    editor(
        "pycharm",
        "PyCharm",
        &[
            "PyCharm.app",
            "PyCharm Professional Edition.app",
            "PyCharm CE.app",
            "PyCharm Community Edition.app",
        ],
        "pycharm",
    ),
    editor("rustrover", "RustRover", &["RustRover.app"], "rustrover"),
    editor("goland", "GoLand", &["GoLand.app"], "goland"),
    editor("xcode", "Xcode", &["Xcode.app"], "xed"),
];

/// How to start an installed editor: through its app bundle (macOS) or its
/// command-line launcher.
#[derive(Debug, PartialEq)]
enum Launcher {
    Bundle(PathBuf),
    Cli(PathBuf),
}

/// Where apps are installed (`/Applications`, `~/Applications`; none off
/// macOS) and the PATH directories.
fn search_dirs() -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut apps = Vec::new();
    if cfg!(target_os = "macos") {
        apps.push(PathBuf::from("/Applications"));
        if let Some(home) = std::env::var_os("HOME") {
            apps.push(Path::new(&home).join("Applications"));
        }
    }
    let path = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    (apps, path)
}

/// `editor`'s launcher if it is installed: an app bundle in one of `app_dirs`
/// first, else its CLI in one of `path_dirs`. Only existence checks, so
/// listing every editor costs a few dozen `stat`s. A GUI app on macOS starts
/// with a bare PATH, which is why the bundles come first there.
fn find_editor(
    editor: &KnownEditor,
    app_dirs: &[PathBuf],
    path_dirs: &[PathBuf],
) -> Option<Launcher> {
    let bundle = app_dirs
        .iter()
        .flat_map(|dir| editor.bundles.iter().map(move |b| dir.join(b)))
        .find(|p| p.is_dir());
    if let Some(bundle) = bundle {
        return Some(Launcher::Bundle(bundle));
    }
    path_dirs
        .iter()
        .map(|dir| dir.join(editor.cli))
        .find(|p| p.is_file())
        .map(Launcher::Cli)
}

/// The editors installed here, in `KNOWN_EDITORS` order.
fn list_editors_impl() -> Vec<Editor> {
    let (apps, path) = search_dirs();
    KNOWN_EDITORS
        .iter()
        .filter(|e| find_editor(e, &apps, &path).is_some())
        .map(|e| Editor {
            id: e.id,
            name: e.name,
        })
        .collect()
}

/// Open the active repository's folder in the editor `id`. The path goes to
/// the launcher as its own argument — no shell — and is absolute, so neither
/// `open` nor the CLI can read it as an option.
fn open_repo_in_editor_impl(state: &RepoState, id: String) -> Result<(), String> {
    let editor = KNOWN_EDITORS
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("unknown editor: {id}"))?;
    let (apps, path) = search_dirs();
    let launcher = find_editor(editor, &apps, &path)
        .ok_or_else(|| format!("{} isn't installed", editor.name))?;
    let dir = with_repo(state, |repo| repo.workdir_path())?;
    let mut cmd = match launcher {
        Launcher::Bundle(app) => {
            let mut cmd = std::process::Command::new("open");
            cmd.arg("-a").arg(app);
            cmd
        }
        Launcher::Cli(cli) => std::process::Command::new(cli),
    };
    cmd.arg(&dir).spawn().map(|_| ()).map_err(to_message)
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

/// Open `paths` of `target` in the user's `git difftool`. `false` when no diff
/// tool is configured. Unlocked: it watches the tool start for a moment (see
/// gitp-core's `launch_git`), which must not stall other commands.
fn open_difftool_impl(
    state: &RepoState,
    target: DiffToolTarget,
    paths: Vec<String>,
) -> Result<bool, String> {
    with_repo_unlocked(state, |repo| repo.open_difftool(&target, &paths))
}

/// Open the conflicted `path` in the user's `git mergetool`. `false` when no
/// merge tool is configured.
fn open_mergetool_impl(state: &RepoState, path: String) -> Result<bool, String> {
    with_repo_unlocked(state, |repo| repo.open_mergetool(&path))
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

#[tauri::command(async)]
pub(crate) fn list_editors() -> Vec<Editor> {
    list_editors_impl()
}

#[tauri::command(async)]
pub(crate) fn open_repo_in_editor(id: String, state: State<RepoState>) -> Result<(), String> {
    open_repo_in_editor_impl(&state, id)
}

#[tauri::command(async)]
pub(crate) fn open_difftool(
    target: DiffToolTarget,
    paths: Vec<String>,
    state: State<RepoState>,
) -> Result<bool, String> {
    open_difftool_impl(&state, target, paths)
}

#[tauri::command(async)]
pub(crate) fn open_mergetool(path: String, state: State<RepoState>) -> Result<bool, String> {
    open_mergetool_impl(&state, path)
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
    fn an_editor_is_found_by_its_app_bundle_first_then_its_cli() {
        let apps = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        let (app_dirs, path_dirs) = (
            vec![apps.path().to_path_buf()],
            vec![bin.path().to_path_buf()],
        );
        let editor = |id: &str| KNOWN_EDITORS.iter().find(|e| e.id == id).unwrap();

        assert_eq!(find_editor(editor("zed"), &app_dirs, &path_dirs), None);

        // Any edition's bundle counts.
        std::fs::create_dir(apps.path().join("IntelliJ IDEA CE.app")).unwrap();
        assert_eq!(
            find_editor(editor("intellij"), &app_dirs, &path_dirs),
            Some(Launcher::Bundle(apps.path().join("IntelliJ IDEA CE.app")))
        );

        std::fs::write(bin.path().join("zed"), "").unwrap();
        assert_eq!(
            find_editor(editor("zed"), &app_dirs, &path_dirs),
            Some(Launcher::Cli(bin.path().join("zed")))
        );
        std::fs::create_dir(apps.path().join("Zed.app")).unwrap();
        assert_eq!(
            find_editor(editor("zed"), &app_dirs, &path_dirs),
            Some(Launcher::Bundle(apps.path().join("Zed.app"))),
            "the bundle wins over the CLI"
        );
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
