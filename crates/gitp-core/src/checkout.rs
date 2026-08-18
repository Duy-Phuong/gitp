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
        match reference.as_ref().and_then(git2::Reference::name) {
            Some(refname) => self.inner.set_head(refname)?,
            None => self.inner.set_head_detached(object.id())?,
        }
        Ok(())
    }

    /// Create a branch named `name` at the current HEAD commit and check it out.
    /// Errors if the branch already exists.
    pub fn create_branch(&self, name: &str) -> Result<()> {
        let head = self.inner.head()?.peel_to_commit()?;
        self.inner.branch(name, &head, false)?;
        self.checkout_branch(name)
    }
}
