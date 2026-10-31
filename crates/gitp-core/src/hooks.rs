//! Git hooks: which of the scripts git runs (`pre-commit`, `commit-msg`,
//! `pre-push`, …) the repository has in its hooks folder, and switching one
//! off and back on without deleting it.
//!
//! The folder is whatever git uses — `core.hooksPath` when set, else
//! `.git/hooks` — asked of git itself (`rev-parse --git-path hooks`), so a
//! worktree or a shared hooks folder is seen the way git sees it. A hook is
//! disabled by renaming it to `<name>.disabled`, which git ignores and which
//! is easy to recognise and reverse by hand; a script git would skip because
//! it isn't executable is reported as such, and enabling it sets the bit.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{Error, Result};
use crate::repo::Repo;

/// The hooks git runs, in the order of `githooks(5)`.
pub const HOOK_NAMES: [&str; 18] = [
    "applypatch-msg",
    "pre-applypatch",
    "post-applypatch",
    "pre-commit",
    "pre-merge-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "pre-rebase",
    "post-checkout",
    "post-merge",
    "pre-push",
    "pre-auto-gc",
    "post-rewrite",
    "sendemail-validate",
    "fsmonitor-watchman",
    "post-index-change",
    "reference-transaction",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HookState {
    /// The script is there and executable: git runs it.
    Active,
    /// Renamed to `<name>.disabled` (by gitp or by hand): git skips it.
    Disabled,
    /// The script is there but not executable, so git skips it silently.
    NotExecutable,
    /// No script of that name.
    Missing,
}

#[derive(Debug, Clone, Serialize)]
pub struct Hook {
    pub name: String,
    pub state: HookState,
    /// The script's path, or where it would be.
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Hooks {
    /// The folder git reads hooks from.
    pub dir: String,
    /// Every hook git knows, present or not.
    pub hooks: Vec<Hook>,
}

impl Repo {
    /// The folder git reads this repository's hooks from.
    pub fn hooks_dir(&self) -> Result<PathBuf> {
        let out = self.run_git(&["rev-parse", "--git-path", "hooks"])?;
        let path = Path::new(out.trim());
        Ok(if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.workdir_path()?.join(path)
        })
    }

    /// Each hook git knows and its state in this repository.
    pub fn hooks(&self) -> Result<Hooks> {
        let dir = self.hooks_dir()?;
        let hooks = HOOK_NAMES
            .iter()
            .map(|name| {
                let path = dir.join(name);
                let state = if path.is_file() {
                    if is_executable(&path) {
                        HookState::Active
                    } else {
                        HookState::NotExecutable
                    }
                } else if disabled_path(&dir, name).is_file() {
                    HookState::Disabled
                } else {
                    HookState::Missing
                };
                Hook {
                    name: name.to_string(),
                    state,
                    path: path.to_string_lossy().into_owned(),
                }
            })
            .collect();
        Ok(Hooks {
            dir: dir.to_string_lossy().into_owned(),
            hooks,
        })
    }

    /// Switch hook `name` on (rename `<name>.disabled` back, or make the
    /// script executable) or off (rename it to `<name>.disabled`). The script
    /// itself is never changed or deleted.
    pub fn set_hook_enabled(&self, name: &str, enabled: bool) -> Result<()> {
        if !HOOK_NAMES.contains(&name) {
            return Err(Error::Message(format!("{name} is not a git hook")));
        }
        let dir = self.hooks_dir()?;
        let active = dir.join(name);
        let disabled = disabled_path(&dir, name);
        let io = |e: std::io::Error| Error::Message(format!("can't change the {name} hook: {e}"));
        if enabled {
            if !active.is_file() {
                if !disabled.is_file() {
                    return Err(Error::Message(format!("there is no {name} hook to enable")));
                }
                fs::rename(&disabled, &active).map_err(io)?;
            }
            set_executable(&active).map_err(io)
        } else {
            if !active.is_file() {
                return Err(Error::Message(format!(
                    "there is no {name} hook to disable"
                )));
            }
            if disabled.exists() {
                return Err(Error::Message(format!(
                    "{} is already there; remove it first",
                    disabled.display()
                )));
            }
            fs::rename(&active, &disabled).map_err(io)
        }
    }
}

fn disabled_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.disabled"))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(_path: &Path) -> bool {
    true
}

#[cfg(unix)]
fn set_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)?.permissions();
    if perms.mode() & 0o111 == 0 {
        perms.set_mode(perms.mode() | 0o755);
        fs::set_permissions(path, perms)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}
