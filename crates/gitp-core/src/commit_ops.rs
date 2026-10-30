//! Commit-scoped history operations, invoked from the log's right-click menu:
//! checkout, branch/tag creation, cherry-pick, revert, reset, rebase, and
//! saving commits as a patch.
//!
//! All of these shell out through `run_git` (see remote.rs) rather than going
//! through libgit2. Operations like cherry-pick, revert, and rebase are far
//! harder to reimplement correctly with git2, and shelling out means git's own
//! conflict handling, hooks, and error messages apply as-is — matching what the
//! embedded terminal would produce.

use std::fs;
use std::path::Path;

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::remote::ref_arg;
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
    /// Detach HEAD onto `rev` (`git checkout --detach <rev>`). `--detach` so a
    /// `rev` that happens to be a branch name still detaches instead of
    /// switching to that branch. A dirty tree that would be overwritten makes
    /// git error, which surfaces to the caller.
    pub fn checkout_commit(&self, rev: &str) -> Result<String> {
        self.run_git(&["checkout", "--detach", ref_arg(rev)?])
    }

    /// Create branch `name` starting at `rev` and check it out
    /// (`git checkout -b <name> <rev>`). Errors if the branch already exists.
    pub fn create_branch_at(&self, name: &str, rev: &str) -> Result<String> {
        self.run_git(&["checkout", "-b", ref_arg(name)?, ref_arg(rev)?])
    }

    /// Create a lightweight tag `name` pointing at `rev` (`git tag <name> <rev>`).
    /// Non-destructive: HEAD and the working tree are untouched.
    pub fn create_tag_at(&self, name: &str, rev: &str) -> Result<String> {
        self.run_git(&["tag", ref_arg(name)?, ref_arg(rev)?])
    }

    /// Apply `rev` on top of the current branch (`git cherry-pick <rev>`).
    /// Conflicts leave the repo mid-cherry-pick and surface as an error.
    pub fn cherry_pick(&self, rev: &str) -> Result<String> {
        self.run_git(&["cherry-pick", ref_arg(rev)?])
    }

    /// Add a commit that undoes `rev` (`git revert --no-edit <rev>`).
    /// Conflicts leave the repo mid-revert and surface as an error.
    pub fn revert(&self, rev: &str) -> Result<String> {
        self.run_git(&["revert", "--no-edit", ref_arg(rev)?])
    }

    /// Move the current branch to `rev` (`git reset --<mode> <rev>`). `Hard`
    /// discards working-tree and index changes and cannot be undone from the UI.
    pub fn reset(&self, rev: &str, mode: ResetMode) -> Result<String> {
        self.run_git(&["reset", mode.flag(), ref_arg(rev)?])
    }

    /// Rebase the current branch onto `rev` (`git rebase <rev>`). This is a
    /// plain, non-interactive rebase; conflicts stop the rebase and surface as
    /// an error for the user to resolve in the terminal.
    pub fn rebase_onto(&self, rev: &str) -> Result<String> {
        self.run_git(&["rebase", ref_arg(rev)?])
    }

    /// Write `revs` to `dest` as one patch file: each commit's
    /// `git format-patch -1 --stdout`, in the order given, so several make an
    /// mbox that `git am` applies one commit at a time.
    pub fn save_commits_patch(&self, revs: &[String], dest: &Path) -> Result<String> {
        let mut patch = Vec::new();
        for rev in revs {
            patch.extend(self.run_git_raw(&["format-patch", "-1", "--stdout", ref_arg(rev)?])?);
        }
        fs::write(dest, &patch).map_err(|e| Error::Message(format!("can't write patch: {e}")))?;
        Ok(format!("Saved patch to {}", dest.display()))
    }
}
