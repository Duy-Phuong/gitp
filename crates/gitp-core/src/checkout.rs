//! Branch checkout — the first operation that mutates the working tree.

use crate::error::Result;
use crate::repo::Repo;

impl Repo {
    /// Check out `name` (a branch or any revision), updating the working tree and
    /// HEAD. A *safe* checkout: it errors rather than clobbering uncommitted local
    /// modifications, so a dirty tree surfaces as an error instead of data loss.
    pub fn checkout_branch(&self, name: &str) -> Result<()> {
        let (object, reference) = self.inner.revparse_ext(name)?;

        let mut checkout = git2::build::CheckoutBuilder::new();
        checkout.safe();
        self.inner.checkout_tree(&object, Some(&mut checkout))?;

        // Point HEAD at the branch ref when there is one; otherwise detach.
        match reference.as_ref().and_then(git2::Reference::name) {
            Some(refname) => self.inner.set_head(refname)?,
            None => self.inner.set_head_detached(object.id())?,
        }
        Ok(())
    }
}
