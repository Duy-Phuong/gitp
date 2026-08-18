//! Stash-scoped operations invoked from the sidebar's right-click menu:
//! apply (optionally dropping), drop, rename, and save-as-patch. All shell out
//! through `run_git` so git's own conflict handling and messages apply as-is.
//!
//! Stashes are addressed by stack index (`stash@{N}`, 0 = most recent), the
//! same index carried in `StashRef`. Saving the stash away (`git stash`) and
//! popping the newest (`git stash pop`) already live in `remote.rs`.

use std::fs;
use std::path::Path;

use crate::error::Result;
use crate::repo::Repo;

impl Repo {
    /// Apply stash `index` to the working tree. `drop` chooses `git stash pop`
    /// (apply then remove) over `git stash apply` (leave the entry in place).
    /// Conflicts leave the merge markers and surface as an error.
    pub fn stash_apply(&self, index: usize, drop: bool) -> Result<String> {
        let verb = if drop { "pop" } else { "apply" };
        self.run_git(&["stash", verb, &stash_ref(index)])
    }

    /// Drop stash `index` from the stack (`git stash drop`).
    pub fn stash_drop(&self, index: usize) -> Result<String> {
        self.run_git(&["stash", "drop", &stash_ref(index)])
    }

    /// Give stash `index` a new message. git has no native rename and refuses
    /// to `stash store` a commit already on the stack (it would be a duplicate),
    /// so renaming means drop the entry and re-store it under the new message.
    /// The re-stored entry lands at the top of the stack — the same behavior as
    /// GitKraken and Tower.
    ///
    /// To avoid ever leaving the stash commit unreferenced (recoverable only via
    /// the reflog if the process dies mid-rename), we first pin its SHA under a
    /// temporary ref, and only remove that pin once the re-store succeeds. If a
    /// step fails partway, the temporary ref is intentionally left in place so
    /// the commit stays reachable.
    pub fn stash_rename(&self, index: usize, message: &str) -> Result<String> {
        let sha = self.run_git(&["rev-parse", &stash_ref(index)])?;
        let sha = sha.trim().to_string();
        let pin = "refs/gitp/stash-rename";
        self.run_git(&["update-ref", pin, &sha])?;
        self.run_git(&["stash", "drop", &stash_ref(index)])?;
        self.run_git(&["stash", "store", "-m", message, &sha])?;
        self.run_git(&["update-ref", "-d", pin])?;
        Ok(format!("Renamed stash to \"{message}\""))
    }

    /// Write stash `index`'s full diff (`git stash show -p`) to `path`.
    pub fn save_stash_patch(&self, index: usize, path: &Path) -> Result<String> {
        let patch = self.run_git(&["stash", "show", "-p", &stash_ref(index)])?;
        // `run_git` trims the trailing newline; restore it so the patch ends
        // cleanly the way `git format-patch` output would.
        fs::write(path, format!("{patch}\n"))
            .map_err(|e| crate::error::Error::Message(format!("can't write patch: {e}")))?;
        Ok(format!("Saved patch to {}", path.display()))
    }
}

/// The `stash@{N}` revision string for stack position `index`.
fn stash_ref(index: usize) -> String {
    format!("stash@{{{index}}}")
}
