//! Branch checkout — the first operation that mutates the working tree.

use crate::error::{Error, Result};
use crate::repo::Repo;

impl Repo {
    /// Check out `name` (a branch or any revision), updating the working tree and
    /// HEAD. A *safe* checkout: it refuses rather than clobbering uncommitted
    /// local modifications. When switching would overwrite conflicting changes,
    /// nothing is touched — HEAD stays put and the working tree is preserved —
    /// and a clear, actionable error is returned instead of git2's cryptic one.
    pub fn checkout_branch(&self, name: &str) -> Result<()> {
        let (object, reference) = self.inner.revparse_ext(name)?;

        let mut checkout = git2::build::CheckoutBuilder::new();
        checkout.safe();
        if let Err(e) = self.inner.checkout_tree(&object, Some(&mut checkout)) {
            // A safe checkout aborts (touching nothing) when local changes would
            // be overwritten. Turn that into a message that says what to do.
            if e.code() == git2::ErrorCode::Conflict {
                return Err(Error::Message(format!(
                    "Can't switch to {name}: you have uncommitted changes that would be \
                     overwritten. Commit or stash them first — nothing was changed."
                )));
            }
            return Err(e.into());
        }

        // Point HEAD at the branch ref when there is one; otherwise detach.
        // Write the same "checkout: moving from A to B" HEAD-reflog message the
        // `git` CLI uses, so switches made here show up in the Recent list
        // (which is read from that reflog). git2's plain set_head wouldn't.
        match reference.as_ref().and_then(git2::Reference::name) {
            Some(refname) => {
                let from = self
                    .inner
                    .head()
                    .ok()
                    .and_then(|h| h.shorthand().map(str::to_string))
                    .unwrap_or_default();
                let to = reference.as_ref().and_then(git2::Reference::shorthand).unwrap_or(name);
                let msg = format!("checkout: moving from {from} to {to}");
                self.inner.reference_symbolic("HEAD", refname, true, &msg)?;
            }
            None => self.inner.set_head_detached(object.id())?,
        }
        Ok(())
    }

    /// Check out a remote-tracking branch (e.g. `origin/draft-develop/3.34.0`).
    /// If a local branch of the corresponding name already exists, just switch
    /// to it; otherwise create a local branch tracking the remote and switch.
    /// Returns git's output for display.
    pub fn checkout_remote(&self, remote_ref: &str) -> Result<String> {
        let local = self.local_name_for_remote(remote_ref);
        if self.inner.find_branch(&local, git2::BranchType::Local).is_ok() {
            self.checkout_branch(&local)?;
            return Ok(format!("Switched to {local}"));
        }
        // Shelling out gives git's DWIM tracking setup, hooks, and reflog.
        self.run_git(&["checkout", "-b", &local, "--track", remote_ref])
    }

    /// The local branch name for a remote-tracking ref: strip the remote name
    /// prefix (`origin/foo/bar` → `foo/bar`). Falls back to dropping the first
    /// path segment when the remote can't be matched.
    fn local_name_for_remote(&self, remote_ref: &str) -> String {
        if let Ok(remotes) = self.inner.remotes() {
            for remote in remotes.iter().flatten() {
                if let Some(rest) = remote_ref.strip_prefix(&format!("{remote}/")) {
                    return rest.to_string();
                }
            }
        }
        remote_ref.split_once('/').map_or(remote_ref, |x| x.1).to_string()
    }

    /// Create a branch named `name` at the current HEAD commit and check it out.
    /// Errors if the branch already exists.
    pub fn create_branch(&self, name: &str) -> Result<()> {
        let head = self.inner.head()?.peel_to_commit()?;
        self.inner.branch(name, &head, false)?;
        self.checkout_branch(name)
    }
}
