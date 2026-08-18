//! Branch-scoped operations invoked from the sidebar's right-click menu:
//! rename, delete, merge, push, and fast-forward. All shell out through
//! `run_git` so git's own conflict handling, hooks, and messages apply as-is.
//!
//! Checkout, branch/tag creation, and rebase already live elsewhere
//! (`checkout.rs`, `commit_ops.rs`) and are reused by the menu as-is.

use crate::error::Result;
use crate::repo::Repo;

impl Repo {
    /// Rename branch `old` to `new` (`git branch -m`). Works on the current
    /// branch too. Errors if `new` already exists.
    pub fn rename_branch(&self, old: &str, new: &str) -> Result<String> {
        self.run_git(&["branch", "-m", old, new])
    }

    /// Delete branch `name`. `force` uses `-D` (delete even if unmerged);
    /// otherwise `-d`, which refuses to drop unmerged work.
    pub fn delete_branch(&self, name: &str, force: bool) -> Result<String> {
        let flag = if force { "-D" } else { "-d" };
        self.run_git(&["branch", flag, name])
    }

    /// Merge `name` into the current branch (`git merge`). Conflicts leave the
    /// merge in progress and surface as an error.
    pub fn merge_branch(&self, name: &str) -> Result<String> {
        self.run_git(&["merge", name])
    }

    /// Push branch `name` to `origin` (`git push origin <name>`).
    pub fn push_branch(&self, name: &str) -> Result<String> {
        self.run_git(&["push", "origin", name])
    }

    /// Fast-forward branch `name` to its configured upstream. The current branch
    /// is advanced with `merge --ff-only`; another branch is advanced by a local
    /// fetch into it, which git only allows when it's a true fast-forward.
    pub fn fast_forward_branch(&self, name: &str) -> Result<String> {
        let upstream = self
            .run_git(&["rev-parse", "--abbrev-ref", &format!("{name}@{{upstream}}")])?;
        let current = self
            .inner
            .head()
            .ok()
            .and_then(|h| h.shorthand().map(str::to_string));
        if current.as_deref() == Some(name) {
            self.run_git(&["merge", "--ff-only", &upstream])
        } else {
            self.run_git(&["fetch", ".", &format!("{upstream}:{name}")])
        }
    }
}
