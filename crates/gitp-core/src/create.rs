//! Making a repository that doesn't exist yet: `git init` into a folder, or
//! `git clone` one from a remote.
//!
//! Free functions rather than `Repo` methods — there is no repository to open
//! until they've run.

use std::path::Path;

use crate::error::{Error, Result};
use crate::git_bin::git_command;
use crate::progress::{run_progress, NetworkHooks};
use crate::remote::ref_arg;

/// `git init` the folder at `path` (created if missing, parents too), then
/// write a `.gitignore` with `gitignore` and a `README.md` headed with the
/// folder's name when asked. No commit is made.
///
/// The folder may already hold a project — that's the usual reason to init —
/// so neither file overwrites one already there: that is refused before
/// anything is written. `path` must be absolute; a relative one would land
/// wherever the app happened to be started.
pub fn init_repo(path: &Path, gitignore: Option<&str>, readme: bool) -> Result<()> {
    if !path.is_absolute() {
        return Err(Error::Message(format!(
            "{} is not an absolute path",
            path.display()
        )));
    }
    for (name, wanted) in [(".gitignore", gitignore.is_some()), ("README.md", readme)] {
        if wanted && path.join(name).exists() {
            return Err(Error::Message(format!(
                "{name} already exists in {} — leave it unticked to keep it",
                path.display()
            )));
        }
    }

    let output = git_command()
        .args(["init", "--"])
        .arg(path)
        .output()
        .map_err(|e| Error::Message(format!("failed to run git: {e}")))?;
    if !output.status.success() {
        return Err(Error::Message(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }

    let write = |name: &str, body: &str| {
        std::fs::write(path.join(name), body)
            .map_err(|e| Error::Message(format!("failed to write {name}: {e}")))
    };
    if let Some(body) = gitignore {
        write(".gitignore", body)?;
    }
    if readme {
        let title = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        write("README.md", &format!("# {title}\n"))?;
    }
    Ok(())
}

/// `git clone` `url` into `dest`, a folder that doesn't exist yet (or is
/// empty) inside one that does. Runs like a fetch: progress and Cancel through
/// `hooks`, and its askpass for credentials. Returns git's output.
///
/// A cancelled clone leaves nothing behind: git deletes the half-made folder
/// on the SIGTERM Cancel sends.
pub fn clone_repo(url: &str, dest: &Path, hooks: &NetworkHooks) -> Result<String> {
    // After `--` git couldn't read it as an option anyway; refusing it here
    // says so, rather than leaving git to fail on a "repository" called
    // `--upload-pack=…`.
    let url = ref_arg(url.trim())?;
    if url.is_empty() {
        return Err(Error::Message("no repository URL given".into()));
    }
    let parent = dest
        .parent()
        .filter(|_| dest.is_absolute())
        .ok_or_else(|| Error::Message(format!("{} is not an absolute path", dest.display())))?;
    if !parent.is_dir() {
        return Err(Error::Message(format!(
            "{} is not an existing folder",
            parent.display()
        )));
    }
    let dest = dest
        .to_str()
        .ok_or_else(|| Error::Message(format!("unsupported path: {}", dest.display())))?;
    run_progress(
        parent,
        &["clone", "--progress", "--", url, dest],
        hooks,
        own_askpass(),
    )
}

/// Whether the user's global config sets `core.askPass`, which ours must not
/// override (there's no repository config to look in yet).
fn own_askpass() -> bool {
    git2::Config::open_default()
        .and_then(|c| c.get_string("core.askPass"))
        .is_ok_and(|v| !v.is_empty())
}
