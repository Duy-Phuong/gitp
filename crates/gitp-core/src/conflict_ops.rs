//! Conflict resolution driven by the conflict-resolver view, for every git
//! operation that can stop mid-way with conflict markers: merge, rebase,
//! cherry-pick, and revert. Reports the in-progress session, reads the three
//! sides of a conflicted file, marks files resolved, and finishes (commit /
//! continue) or aborts. Everything shells out through `run_git` so git's own
//! conflict handling and messages apply as-is.

use serde::Serialize;

use crate::error::{Error, Result};
use crate::repo::Repo;

/// A snapshot of the current conflict session, for the resolver UI.
#[derive(Debug, Clone, Serialize)]
pub struct ConflictStatus {
    /// `"merge"`, `"rebase"`, `"cherry-pick"`, `"revert"`, or `"none"` when
    /// nothing is in progress.
    pub kind: String,
    /// Human summary, e.g. `Merging origin/x into dev` or `Rebasing dev`.
    pub summary: String,
    /// Working-tree paths still unmerged (`git diff --diff-filter=U`).
    pub conflicted: Vec<String>,
    /// The default commit message (merge only; empty for rebase/none).
    pub message: String,
}

/// The three staged versions plus the working-tree text of a conflicted file.
#[derive(Debug, Clone, Serialize)]
pub struct ConflictSides {
    /// Stage 2 (ours / current branch); `None` if our side deleted the file.
    pub ours: Option<String>,
    /// Stage 3 (theirs / incoming); `None` if their side deleted the file.
    pub theirs: Option<String>,
    /// Stage 1 (common ancestor); `None` for add/add conflicts.
    pub base: Option<String>,
    /// The current working-tree file, with conflict markers.
    pub working: String,
    /// Any side is binary (or the working file contains a NUL byte).
    pub binary: bool,
}

impl Repo {
    /// Report the in-progress conflict session (merge, rebase, cherry-pick, or
    /// revert), if any.
    pub fn conflict_status(&self) -> Result<ConflictStatus> {
        let git_dir = self.inner.path();
        let merging = git_dir.join("MERGE_HEAD").exists();
        let rebasing = git_dir.join("rebase-merge").is_dir() || git_dir.join("rebase-apply").is_dir();
        let cherry_picking = git_dir.join("CHERRY_PICK_HEAD").exists();
        let reverting = git_dir.join("REVERT_HEAD").exists();

        if !merging && !rebasing && !cherry_picking && !reverting {
            return Ok(ConflictStatus {
                kind: "none".into(),
                summary: String::new(),
                conflicted: Vec::new(),
                message: String::new(),
            });
        }

        let conflicted = self.unmerged_paths()?;

        if rebasing {
            let into = self.current_branch_label();
            return Ok(ConflictStatus {
                kind: "rebase".into(),
                summary: format!("Rebasing {into}"),
                conflicted,
                message: String::new(),
            });
        }

        // Merge, cherry-pick, and revert all stage their pending commit message
        // in MERGE_MSG the same way, so they share this summary logic.
        let kind = if merging { "merge" } else if cherry_picking { "cherry-pick" } else { "revert" };
        let message = std::fs::read_to_string(git_dir.join("MERGE_MSG")).unwrap_or_default();
        let into = self.current_branch_label();
        let default_summary = match kind {
            "cherry-pick" => format!("Cherry-picking onto {into}"),
            "revert" => format!("Reverting on {into}"),
            _ => format!("Merging into {into}"),
        };
        // MERGE_MSG's first line is git's own summary (e.g. "Merge …").
        let summary = message.lines().next().map(str::to_string).unwrap_or(default_summary);
        Ok(ConflictStatus { kind: kind.into(), summary, conflicted, message })
    }

    /// Read the ours/theirs/base staged versions and the working text of `path`.
    pub fn conflict_sides(&self, path: &str) -> Result<ConflictSides> {
        let stage = |n: u8| -> Option<Vec<u8>> {
            self.run_git_raw(&["show", &format!(":{n}:{path}")]).ok()
        };
        let base = stage(1);
        let ours = stage(2);
        let theirs = stage(3);
        let working = std::fs::read(self.workdir_path()?.join(path)).unwrap_or_default();

        let has_nul = |b: &[u8]| b.contains(&0);
        let binary = has_nul(&working)
            || [&base, &ours, &theirs].iter().flat_map(|o| o.iter()).any(|b| has_nul(b));

        let to_text = |o: Option<Vec<u8>>| o.map(|b| String::from_utf8_lossy(&b).into_owned());
        Ok(ConflictSides {
            ours: to_text(ours),
            theirs: to_text(theirs),
            base: to_text(base),
            working: String::from_utf8_lossy(&working).into_owned(),
            binary,
        })
    }

    /// Write the resolved `content` for `path` and stage it (`git add`), which
    /// marks the conflict resolved.
    pub fn resolve_conflict(&self, path: &str, content: &str) -> Result<()> {
        std::fs::write(self.workdir_path()?.join(path), content)
            .map_err(|e| crate::error::Error::Message(format!("can't write {path}: {e}")))?;
        self.run_git(&["add", "--", path]).map(|_| ())
    }

    /// Resolve `path` by taking one whole side — `git checkout --ours/--theirs`
    /// then `git add`. Used for binary conflicts (no text merge is possible) and
    /// whole-file "take" actions.
    pub fn resolve_conflict_side(&self, path: &str, ours: bool) -> Result<()> {
        let side = if ours { "--ours" } else { "--theirs" };
        self.run_git(&["checkout", side, "--", path])?;
        self.run_git(&["add", "--", path]).map(|_| ())
    }

    /// Abort the in-progress merge, rebase, cherry-pick, or revert, restoring
    /// the pre-op state.
    pub fn abort_conflict(&self) -> Result<String> {
        let git_dir = self.inner.path();
        if git_dir.join("MERGE_HEAD").exists() {
            self.run_git(&["merge", "--abort"])
        } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
            self.run_git(&["cherry-pick", "--abort"])
        } else if git_dir.join("REVERT_HEAD").exists() {
            self.run_git(&["revert", "--abort"])
        } else {
            self.run_git(&["rebase", "--abort"])
        }
    }

    /// Finish the conflict session once every file is resolved: commit the
    /// merge with `message`, or continue the rebase/cherry-pick/revert (each of
    /// which reuses its own pending message).
    pub fn finish_conflict(&self, message: &str) -> Result<String> {
        let git_dir = self.inner.path();
        if git_dir.join("MERGE_HEAD").exists() {
            self.run_git_stdin(&["commit", "-F", "-"], message)
        } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
            self.continue_without_editor(&["cherry-pick", "--continue"])
        } else if git_dir.join("REVERT_HEAD").exists() {
            self.continue_without_editor(&["revert", "--continue"])
        } else {
            self.run_git(&["rebase", "--continue"])
        }
    }

    /// Run a `--continue` that would otherwise pop an editor to confirm the
    /// pending commit message (cherry-pick and revert both reuse the original
    /// commit's message by default). There's no TTY here, so GIT_EDITOR=true
    /// auto-accepts it — same fix as the interactive-rebase reword handling.
    fn continue_without_editor(&self, args: &[&str]) -> Result<String> {
        let workdir = self.workdir_path()?;
        let output = std::process::Command::new("git")
            .current_dir(workdir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_EDITOR", "true")
            .args(args)
            .output()
            .map_err(|e| Error::Message(format!("failed to run git: {e}")))?;
        let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
        combined.push_str(&String::from_utf8_lossy(&output.stderr));
        let combined = combined.trim().to_string();
        if output.status.success() {
            Ok(combined)
        } else {
            Err(Error::Message(combined))
        }
    }

    /// Working-tree paths with unresolved conflicts.
    fn unmerged_paths(&self) -> Result<Vec<String>> {
        Ok(self
            .run_git(&["diff", "--name-only", "--diff-filter=U"])?
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(str::to_string)
            .collect())
    }

    /// Short name of the checked-out branch, or `HEAD` when detached.
    fn current_branch_label(&self) -> String {
        self.inner
            .head()
            .ok()
            .and_then(|h| h.shorthand().map(str::to_string))
            .unwrap_or_else(|| "HEAD".into())
    }
}
