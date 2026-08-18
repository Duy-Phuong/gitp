//! Interactive rebase: list the commits that would be replayed when rebasing
//! the current branch onto a target, and run a rebase from an edited plan
//! (reorder / pick / reword / squash / drop).
//!
//! Rather than opening an editor, the plan is fed to `git rebase -i` through
//! `GIT_SEQUENCE_EDITOR` (a `cp` of our todo file over git's) with
//! `GIT_EDITOR=true`. Rewords are applied as `exec git commit --amend -F <file>`
//! lines, so no interactive message editing is ever needed.

use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::repo::Repo;

/// Distinguishes concurrent rebases' scratch dirs so their todo/message files
/// never collide (the process id alone is shared across threads).
static REBASE_SEQ: AtomicU64 = AtomicU64::new(0);

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
    /// Keep the commit but pause the rebase after applying it so the working
    /// tree can be amended (git `edit`).
    Edit,
    /// Replace the commit's message with `message` (applied headlessly via an
    /// `exec git commit --amend`).
    Reword,
    /// Meld into the previous commit, combining both messages (git `squash`).
    Squash,
    /// Meld into the previous commit, discarding this commit's message
    /// (git `fixup`).
    Fixup,
    Drop,
}

/// One planned step: a commit sha, its action, and (for reword) the new message.
#[derive(Debug, Clone, Deserialize)]
pub struct RebaseStep {
    pub sha: String,
    pub action: RebaseAction,
    pub message: Option<String>,
}

/// A snapshot of an in-progress interactive rebase, for the resume UI.
#[derive(Debug, Clone, Serialize)]
pub struct RebaseStatus {
    /// Whether a rebase is currently in progress at all.
    pub in_progress: bool,
    /// Why it stopped: `"conflict"` (unmerged files to resolve) or `"edit"`
    /// (an `edit` step paused for amending). `None` when not in progress.
    pub paused_for: Option<String>,
    /// The commit the rebase stopped on, if known.
    pub current_sha: Option<String>,
    pub current_subject: Option<String>,
    /// Working-tree paths with merge conflicts (empty unless `paused_for` is
    /// `"conflict"`).
    pub conflicted_files: Vec<String>,
    /// Steps already applied and the total in the plan, for a progress readout.
    pub done: usize,
    pub total: usize,
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
    /// `steps` (already in the desired top-to-bottom order). When `update_refs`
    /// is set, branches pointing into the rebased range move along with it
    /// (`git rebase --update-refs`).
    ///
    /// A rebase that stops part-way — for an `edit` step or a merge conflict —
    /// is *not* an error: it leaves the rebase in progress and returns `Ok` with
    /// git's "Stopped at…" output. Callers should follow up with
    /// [`Repo::rebase_status`] and continue/abort. Only an outright failure to
    /// start (e.g. a bad plan) returns `Err`.
    pub fn interactive_rebase(
        &self,
        onto: &str,
        steps: &[RebaseStep],
        update_refs: bool,
    ) -> Result<String> {
        // The first applied (non-dropped) step must land a commit — you can't
        // squash or fix up into a commit that isn't there yet.
        if let Some(first) = steps.iter().find(|s| !matches!(s.action, RebaseAction::Drop)) {
            if matches!(first.action, RebaseAction::Squash | RebaseAction::Fixup) {
                return Err(Error::Message(
                    "The first commit can't be squashed or fixed up into a previous one.".into(),
                ));
            }
        }

        let workdir = self
            .inner
            .workdir()
            .ok_or_else(|| Error::Message("repository has no working directory".into()))?;
        let seq = REBASE_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("gitp-rebase-{}-{seq}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(io_err)?;

        let mut todo = String::new();
        for (i, step) in steps.iter().enumerate() {
            match step.action {
                RebaseAction::Drop => todo.push_str(&format!("drop {}\n", step.sha)),
                RebaseAction::Pick => todo.push_str(&format!("pick {}\n", step.sha)),
                RebaseAction::Edit => todo.push_str(&format!("edit {}\n", step.sha)),
                RebaseAction::Squash => todo.push_str(&format!("squash {}\n", step.sha)),
                RebaseAction::Fixup => todo.push_str(&format!("fixup {}\n", step.sha)),
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

        // GIT_SEQUENCE_EDITOR replaces git's generated todo with ours; GIT_EDITOR
        // is `true` so squash/reword message editors accept the default combined
        // message without prompting.
        let seq_editor = format!("cp {}", shell_quote(&todo_path.to_string_lossy()));
        let mut args = vec!["rebase", "-i"];
        if update_refs {
            args.push("--update-refs");
        }
        args.push(onto);
        let output = Command::new("git")
            .current_dir(workdir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_SEQUENCE_EDITOR", seq_editor)
            .env("GIT_EDITOR", "true")
            .args(&args)
            .output()
            .map_err(|e| Error::Message(format!("failed to run git: {e}")))?;

        let _ = std::fs::remove_dir_all(&dir);

        let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
        combined.push_str(&String::from_utf8_lossy(&output.stderr));
        let combined = combined.trim().to_string();
        // Success, or a stop that left the rebase in progress (edit/conflict),
        // both return Ok — the caller inspects rebase_status(). Only a failure
        // that left no rebase in progress is a hard error.
        if output.status.success() || self.rebase_in_progress() {
            Ok(combined)
        } else {
            Err(Error::Message(combined))
        }
    }

    /// Whether an interactive rebase is currently paused in this repo.
    fn rebase_in_progress(&self) -> bool {
        let git_dir = self.inner.path();
        git_dir.join("rebase-merge").is_dir() || git_dir.join("rebase-apply").is_dir()
    }

    /// Inspect an in-progress rebase so the UI can offer continue / skip / abort.
    /// Returns `in_progress: false` (and empty fields) when none is running.
    pub fn rebase_status(&self) -> Result<RebaseStatus> {
        if !self.rebase_in_progress() {
            return Ok(RebaseStatus {
                in_progress: false,
                paused_for: None,
                current_sha: None,
                current_subject: None,
                conflicted_files: Vec::new(),
                done: 0,
                total: 0,
            });
        }

        let state = self.inner.path().join("rebase-merge");
        let read = |name: &str| std::fs::read_to_string(state.join(name)).ok();
        // Non-comment, non-blank lines in the done / remaining todo lists.
        let count = |s: &Option<String>| {
            s.as_deref()
                .map(|t| t.lines().filter(|l| !l.trim().is_empty() && !l.starts_with('#')).count())
                .unwrap_or(0)
        };
        let done_list = read("done");
        let todo_list = read("git-rebase-todo");
        let done = count(&done_list);
        let total = done + count(&todo_list);

        let current_sha = read("stopped-sha").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let current_subject = current_sha.as_deref().and_then(|sha| {
            self.run_git(&["log", "-1", "--format=%s", sha]).ok().map(|s| s.trim().to_string())
        });

        // Unmerged paths mean git stopped on a conflict; otherwise it was an
        // `edit` stop waiting for an amend.
        let conflicted_files: Vec<String> = self
            .run_git(&["diff", "--name-only", "--diff-filter=U"])
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(str::to_string)
            .collect();
        let paused_for = Some(if conflicted_files.is_empty() { "edit" } else { "conflict" }.to_string());

        Ok(RebaseStatus {
            in_progress: true,
            paused_for,
            current_sha,
            current_subject,
            conflicted_files,
            done,
            total,
        })
    }

    /// Resume a paused rebase (`git rebase --continue`). Like
    /// [`Repo::interactive_rebase`], a further stop is `Ok`, not an error.
    pub fn rebase_continue(&self) -> Result<String> {
        self.run_rebase_control(&["rebase", "--continue"])
    }

    /// Skip the current commit and resume (`git rebase --skip`).
    pub fn rebase_skip(&self) -> Result<String> {
        self.run_rebase_control(&["rebase", "--skip"])
    }

    /// Abort the rebase, restoring the pre-rebase state (`git rebase --abort`).
    pub fn rebase_abort(&self) -> Result<String> {
        self.run_rebase_control(&["rebase", "--abort"])
    }

    /// Run a `git rebase --continue/--skip/--abort` with editors suppressed,
    /// treating a further edit/conflict stop as success (the caller re-reads
    /// `rebase_status`).
    fn run_rebase_control(&self, args: &[&str]) -> Result<String> {
        let workdir = self
            .inner
            .workdir()
            .ok_or_else(|| Error::Message("repository has no working directory".into()))?;
        let output = Command::new("git")
            .current_dir(workdir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_EDITOR", "true")
            .args(args)
            .output()
            .map_err(|e| Error::Message(format!("failed to run git: {e}")))?;
        let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
        combined.push_str(&String::from_utf8_lossy(&output.stderr));
        let combined = combined.trim().to_string();
        if output.status.success() || self.rebase_in_progress() {
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
