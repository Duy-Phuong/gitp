//! History of a single file — the commits that changed it, newest first.
//! Shells out to `git log --follow` so renames are tracked and large histories
//! stay fast (git's path-limited walk is far quicker than a git2 diff-per-commit).

use std::process::Command;

use serde::Serialize;

use crate::error::{Error, Result};
use crate::repo::Repo;

/// One commit in a file's history.
#[derive(Debug, Clone, Serialize)]
pub struct FileCommit {
    pub id: String,
    pub short_id: String,
    pub summary: String,
    pub author_name: String,
    /// Author time, seconds since the epoch.
    pub time: i64,
}

// Field separator inside a record; records are newline-separated.
const SEP: char = '\u{1f}';

impl Repo {
    /// Commits reachable from `rev` that changed `path` (up to 200), newest
    /// first, following renames.
    pub fn file_history(&self, rev: &str, path: &str) -> Result<Vec<FileCommit>> {
        let workdir = self
            .inner
            .workdir()
            .ok_or_else(|| Error::Message("repository has no working directory".into()))?;

        let format = format!("--format=%H{SEP}%h{SEP}%an{SEP}%at{SEP}%s");
        let output = Command::new("git")
            .current_dir(workdir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(["log", rev, "--follow", "-n", "200", &format, "--", path])
            .output()
            .map_err(|e| Error::Message(format!("failed to run git: {e}")))?;

        if !output.status.success() {
            return Err(Error::Message(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut commits = Vec::new();
        for line in stdout.lines() {
            let mut f = line.split(SEP);
            let (Some(id), Some(short_id), Some(author_name), Some(time), Some(summary)) =
                (f.next(), f.next(), f.next(), f.next(), f.next())
            else {
                continue;
            };
            commits.push(FileCommit {
                id: id.to_string(),
                short_id: short_id.to_string(),
                summary: summary.to_string(),
                author_name: author_name.to_string(),
                time: time.parse().unwrap_or(0),
            });
        }
        Ok(commits)
    }
}
