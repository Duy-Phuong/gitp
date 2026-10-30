//! Which `git` binary every spawn uses, resolved once per process.
//!
//! A macOS app launched from Finder gets launchd's bare PATH, so a plain
//! `git` resolves to `/usr/bin/git` — Apple's xcrun shim, which starts a
//! second process for every call. Under load that doubles the cost of each
//! git command, and a repo switch runs several in a row. So prefer a
//! Homebrew git, else the real binary behind the shim, else plain `git`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

/// A `Command` for the resolved git binary. Every git spawn goes through here.
pub(crate) fn git_command() -> Command {
    static GIT: OnceLock<(PathBuf, Option<OsString>)> = OnceLock::new();
    let (git, path) = GIT.get_or_init(|| {
        let git = resolve();
        let path = search_path(&git);
        (git, path)
    });
    let mut cmd = Command::new(git);
    if let Some(path) = path {
        cmd.env("PATH", path);
    }
    cmd
}

/// PATH with git's own folder and Homebrew's added at the end, or `None` when
/// they are all on it already. git finds the helpers that live outside its
/// exec-path through PATH — `git-lfs` above all, which Homebrew installs there
/// — and launchd's bare PATH has none of them, so from Finder every `git lfs`,
/// and the LFS filter a checkout runs, would fail as "not a git command".
fn search_path(git: &Path) -> Option<OsString> {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&current).collect();
    let extra = git
        .parent()
        .filter(|d| d.is_absolute())
        .into_iter()
        .chain([Path::new("/opt/homebrew/bin"), Path::new("/usr/local/bin")]);
    let mut added = false;
    for dir in extra {
        if dir.is_dir() && !dirs.iter().any(|d| d == dir) {
            dirs.push(dir.to_path_buf());
            added = true;
        }
    }
    added.then(|| std::env::join_paths(dirs).ok()).flatten()
}

fn resolve() -> PathBuf {
    for candidate in ["/opt/homebrew/bin/git", "/usr/local/bin/git"] {
        let path = Path::new(candidate);
        if runs(path) {
            return path.to_path_buf();
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(path) = xcrun_git() {
        return path;
    }
    PathBuf::from("git")
}

/// The real git that the `/usr/bin/git` shim would run, e.g. the one in the
/// Command Line Tools or Xcode.
#[cfg(target_os = "macos")]
fn xcrun_git() -> Option<PathBuf> {
    let output = Command::new("/usr/bin/xcrun")
        .args(["--find", "git"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    runs(&path).then_some(path)
}

fn runs(path: &Path) -> bool {
    path.is_file()
        && Command::new(path)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolved_git_runs() {
        let status = git_command().arg("--version").status().unwrap();
        assert!(status.success());
    }
}
