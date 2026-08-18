//! Interactive rebase: list the commits that would be replayed when rebasing
//! the current branch onto a target, and run a rebase from an edited plan
//! (reorder / pick / reword / squash / drop).
//!
//! Rather than opening an editor, the plan is fed to `git rebase -i` through
//! `GIT_SEQUENCE_EDITOR` (a `cp` of our todo file over git's) with
//! `GIT_EDITOR=true`. Rewords are applied as `exec git commit --amend -F <file>`
//! lines, so no interactive message editing is ever needed.

use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::repo::Repo;

/// One commit in a rebase plan, as shown in the editor UI.
#[derive(Debug, Clone, Serialize)]
pub struct RebaseCommit {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
}

/// What to do with a commit in the plan.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RebaseAction {
    Pick,
    Reword,
    /// Meld into the previous commit, keeping the previous message (git `fixup`).
    Squash,
    Drop,
}

/// One planned step: a commit sha, its action, and (for reword) the new message.
#[derive(Debug, Clone, Deserialize)]
pub struct RebaseStep {
    pub sha: String,
    pub action: RebaseAction,
    pub message: Option<String>,
}

impl Repo {
    /// The commits that a `rebase onto` would replay — those reachable from HEAD
    /// but not from `onto` (i.e. `merge-base(HEAD, onto)..HEAD`), oldest first,
    /// matching the top-to-bottom order of a rebase todo.
    pub fn rebase_todo(&self, onto: &str) -> Result<Vec<RebaseCommit>> {
        let range = format!("{onto}..HEAD");
        let out = self.run_git(&["log", "--reverse", "--format=%H%x1f%h%x1f%s", &range])?;
        Ok(out
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| {
                let mut p = l.splitn(3, '\u{1f}');
                RebaseCommit {
                    sha: p.next().unwrap_or_default().to_string(),
                    short_sha: p.next().unwrap_or_default().to_string(),
                    subject: p.next().unwrap_or_default().to_string(),
                }
            })
            .collect())
    }

    /// Run an interactive rebase of the current branch onto `onto` following
    /// `steps` (already in the desired top-to-bottom order). Conflicts leave the
    /// rebase in progress and surface as an error, exactly like the CLI.
    pub fn interactive_rebase(&self, onto: &str, steps: &[RebaseStep]) -> Result<String> {
        // The first applied (non-dropped) step must be a pick/reword — you can't
        // squash into a commit that isn't there yet.
        if let Some(first) = steps.iter().find(|s| !matches!(s.action, RebaseAction::Drop)) {
            if matches!(first.action, RebaseAction::Squash) {
                return Err(Error::Message(
                    "The first commit can't be squashed into a previous one.".into(),
                ));
            }
        }

        let workdir = self
            .inner
            .workdir()
            .ok_or_else(|| Error::Message("repository has no working directory".into()))?;
        let dir = std::env::temp_dir().join(format!("gitp-rebase-{}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(io_err)?;

        let mut todo = String::new();
        for (i, step) in steps.iter().enumerate() {
            match step.action {
                RebaseAction::Drop => todo.push_str(&format!("drop {}\n", step.sha)),
                RebaseAction::Pick => todo.push_str(&format!("pick {}\n", step.sha)),
                RebaseAction::Squash => todo.push_str(&format!("fixup {}\n", step.sha)),
                RebaseAction::Reword => {
                    todo.push_str(&format!("pick {}\n", step.sha));
                    let msg_file = dir.join(format!("msg{i}.txt"));
                    std::fs::write(&msg_file, step.message.clone().unwrap_or_default())
                        .map_err(io_err)?;
                    todo.push_str(&format!(
                        "exec git commit --amend -F {}\n",
                        shell_quote(&msg_file.to_string_lossy())
                    ));
                }
            }
        }

        let todo_path = dir.join("todo");
        std::fs::write(&todo_path, &todo).map_err(io_err)?;

        let seq_editor = format!("cp {}", shell_quote(&todo_path.to_string_lossy()));
        let output = Command::new("git")
            .current_dir(workdir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_SEQUENCE_EDITOR", seq_editor)
            .env("GIT_EDITOR", "true")
            .args(["rebase", "-i", onto])
            .output()
            .map_err(|e| Error::Message(format!("failed to run git: {e}")))?;

        let _ = std::fs::remove_dir_all(&dir);

        let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
        combined.push_str(&String::from_utf8_lossy(&output.stderr));
        let combined = combined.trim().to_string();
        if output.status.success() {
            Ok(combined)
        } else {
            Err(Error::Message(combined))
        }
    }
}

fn io_err(e: std::io::Error) -> Error {
    Error::Message(e.to_string())
}

/// Single-quote a string for a POSIX shell (git runs editors via the shell).
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
