//! Making a repository that doesn't exist yet: `git init` into a folder.
//!
//! Free functions rather than `Repo` methods — there is no repository to open
//! until they've run.

use std::path::Path;

use crate::error::{Error, Result};
use crate::git_bin::git_command;

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
