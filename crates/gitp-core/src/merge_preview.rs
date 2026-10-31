//! Would a merge conflict? `git merge-tree --write-tree` (git 2.38+) does the
//! three-way merge in memory and names the files it couldn't combine, without
//! touching the index, the working tree or any ref — so the answer can be
//! shown before the user commits to a merge or a rebase. A rebase replays
//! commits one at a time, so for it this is a close prediction, not a
//! promise: the same files are the ones that will get in the way.

use serde::Serialize;

use crate::activity;
use crate::error::{Error, Result};
use crate::git_bin::git_command;
use crate::remote::ref_arg;
use crate::repo::Repo;

/// What merging `other` into `base` would come to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MergePreview {
    /// No conflicts: the merge would complete on its own.
    pub clean: bool,
    /// The paths that would conflict, as git names them; empty when clean.
    pub conflicts: Vec<String>,
}

impl Repo {
    /// The outcome of merging `other` into `base`, without doing it.
    pub fn merge_preview(&self, base: &str, other: &str) -> Result<MergePreview> {
        let workdir = self
            .inner
            .workdir()
            .ok_or_else(|| Error::Message("repository has no working directory".into()))?;
        // `-z`: a conflicting path can hold anything, including a newline.
        // `--no-messages`: the conflict notices would follow the names.
        let output = activity::output(
            git_command()
                .current_dir(workdir)
                .env("GIT_TERMINAL_PROMPT", "0")
                .args([
                    "merge-tree",
                    "--write-tree",
                    "--name-only",
                    "--no-messages",
                    "-z",
                ])
                .args([ref_arg(base)?, ref_arg(other)?]),
        )
        .map_err(|e| Error::Message(format!("failed to run git: {e}")))?;

        // 0: merged cleanly; 1 with a tree: conflicts. Anything else is an
        // error — an unknown revision is also exit 1 ("not something we can
        // merge"), but with nothing on stdout; a git too old for
        // --write-tree exits 129.
        match output.status.code() {
            Some(0) => Ok(MergePreview {
                clean: true,
                conflicts: Vec::new(),
            }),
            Some(1) if !output.stdout.is_empty() => Ok(MergePreview {
                clean: false,
                conflicts: conflicted_paths(&output.stdout),
            }),
            _ => Err(Error::Message(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            )),
        }
    }
}

/// The paths in merge-tree's `-z` output: the tree id first, then one entry
/// per conflicted file, NUL-terminated.
fn conflicted_paths(stdout: &[u8]) -> Vec<String> {
    stdout
        .split(|&b| b == 0)
        .skip(1)
        .filter(|entry| !entry.is_empty())
        .map(|entry| String::from_utf8_lossy(entry).into_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::conflicted_paths;

    #[test]
    fn parses_the_tree_id_then_the_paths() {
        let out = b"906d48fd4b48987208ed8e4dcfddcb9434b503c5\0src/a.rs\0dir with space/b\n.txt\0";
        assert_eq!(
            conflicted_paths(out),
            vec!["src/a.rs", "dir with space/b\n.txt"]
        );
        assert!(conflicted_paths(b"906d48fd\0").is_empty());
        assert!(conflicted_paths(b"").is_empty());
    }
}
