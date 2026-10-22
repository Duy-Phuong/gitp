//! Which `git` binary every spawn uses, resolved once per process.
//!
//! A macOS app launched from Finder gets launchd's bare PATH, so a plain
//! `git` resolves to `/usr/bin/git` — Apple's xcrun shim, which starts a
//! second process for every call. Under load that doubles the cost of each
//! git command, and a repo switch runs several in a row. So prefer a
//! Homebrew git, else the real binary behind the shim, else plain `git`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

/// A `Command` for the resolved git binary. Every git spawn goes through here.
pub(crate) fn git_command() -> Command {
    static GIT: OnceLock<PathBuf> = OnceLock::new();
    Command::new(GIT.get_or_init(resolve))
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
