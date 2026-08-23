//! Merge/rebase conflict resolution driven by the conflict-resolver view:
//! report the in-progress conflict session, read the three sides of a
//! conflicted file, mark files resolved, and finish (commit the merge / continue
//! the rebase) or abort. Everything shells out through `run_git` so git's own
//! conflict handling and messages apply as-is.

use serde::Serialize;

use crate::error::Result;
use crate::repo::Repo;

/// A snapshot of the current conflict session, for the resolver UI.
#[derive(Debug, Clone, Serialize)]
pub struct ConflictStatus {
    /// `"merge"`, `"rebase"`, or `"none"` when nothing is in progress.
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
    /// Report the in-progress conflict session (merge or rebase), if any.
    pub fn conflict_status(&self) -> Result<ConflictStatus> {
        let git_dir = self.inner.path();
        let merging = git_dir.join("MERGE_HEAD").exists();
        let rebasing = git_dir.join("rebase-merge").is_dir() || git_dir.join("rebase-apply").is_dir();

        if !merging && !rebasing {
            return Ok(ConflictStatus {
                kind: "none".into(),
                summary: String::new(),
                conflicted: Vec::new(),
                message: String::new(),
            });
        }

        let conflicted = self.unmerged_paths()?;

        if merging {
            let message = std::fs::read_to_string(git_dir.join("MERGE_MSG")).unwrap_or_default();
            let into = self.current_branch_label();
            // MERGE_MSG's first line is git's own "Merge …" summary.
            let summary = message
                .lines()
                .next()
                .map(str::to_string)
                .unwrap_or_else(|| format!("Merging into {into}"));
            Ok(ConflictStatus { kind: "merge".into(), summary, conflicted, message })
        } else {
            let into = self.current_branch_label();
            Ok(ConflictStatus {
                kind: "rebase".into(),
                summary: format!("Rebasing {into}"),
                conflicted,
                message: String::new(),
            })
        }
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

    /// Abort the in-progress merge or rebase, restoring the pre-op state.
    pub fn abort_conflict(&self) -> Result<String> {
        if self.inner.path().join("MERGE_HEAD").exists() {
            self.run_git(&["merge", "--abort"])
        } else {
            self.run_git(&["rebase", "--abort"])
        }
    }

    /// Finish the conflict session once every file is resolved: commit the merge
    /// with `message`, or continue the rebase (which reuses its own message).
    pub fn finish_conflict(&self, message: &str) -> Result<String> {
        if self.inner.path().join("MERGE_HEAD").exists() {
            self.run_git_stdin(&["commit", "-F", "-"], message)
        } else {
            self.run_git(&["rebase", "--continue"])
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
