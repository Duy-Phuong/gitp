//! Commit-scoped history operations, invoked from the log's right-click menu:
//! checkout, branch/tag creation, cherry-pick, revert, reset, and rebase.
//!
//! All of these shell out through `run_git` (see remote.rs) rather than going
//! through libgit2. Operations like cherry-pick, revert, and rebase are far
//! harder to reimplement correctly with git2, and shelling out means git's own
//! conflict handling, hooks, and error messages apply as-is — matching what the
//! embedded terminal would produce.

use serde::Deserialize;

use crate::error::Result;
use crate::repo::Repo;

/// How far a reset moves the branch: `--soft` moves only the ref, `--mixed`
/// also resets the index, `--hard` also resets the working tree (destructive).
#[derive(Debug, Clone, Copy, Deserialize)]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

impl ResetMode {
    fn flag(self) -> &'static str {
        match self {
            ResetMode::Soft => "--soft",
            ResetMode::Mixed => "--mixed",
            ResetMode::Hard => "--hard",
        }
    }
}

impl Repo {
    /// Detach HEAD onto `rev` (`git checkout <rev>`). A dirty tree that would be
    /// overwritten makes git error, which surfaces to the caller.
    pub fn checkout_commit(&self, rev: &str) -> Result<String> {
        self.run_git(&["checkout", rev])
    }

    /// Create branch `name` starting at `rev` and check it out
    /// (`git checkout -b <name> <rev>`). Errors if the branch already exists.
    pub fn create_branch_at(&self, name: &str, rev: &str) -> Result<String> {
        self.run_git(&["checkout", "-b", name, rev])
    }

    /// Create a lightweight tag `name` pointing at `rev` (`git tag <name> <rev>`).
    /// Non-destructive: HEAD and the working tree are untouched.
    pub fn create_tag_at(&self, name: &str, rev: &str) -> Result<String> {
        self.run_git(&["tag", name, rev])
    }

    /// Apply `rev` on top of the current branch (`git cherry-pick <rev>`).
    /// Conflicts leave the repo mid-cherry-pick and surface as an error.
    pub fn cherry_pick(&self, rev: &str) -> Result<String> {
        self.run_git(&["cherry-pick", rev])
    }

    /// Add a commit that undoes `rev` (`git revert --no-edit <rev>`).
    /// Conflicts leave the repo mid-revert and surface as an error.
    pub fn revert(&self, rev: &str) -> Result<String> {
        self.run_git(&["revert", "--no-edit", rev])
    }

    /// Move the current branch to `rev` (`git reset --<mode> <rev>`). `Hard`
    /// discards working-tree and index changes and cannot be undone from the UI.
    pub fn reset(&self, rev: &str, mode: ResetMode) -> Result<String> {
        self.run_git(&["reset", mode.flag(), rev])
    }

    /// Rebase the current branch onto `rev` (`git rebase <rev>`). This is a
    /// plain, non-interactive rebase; conflicts stop the rebase and surface as
    /// an error for the user to resolve in the terminal.
    pub fn rebase_onto(&self, rev: &str) -> Result<String> {
        self.run_git(&["rebase", rev])
    }
}
