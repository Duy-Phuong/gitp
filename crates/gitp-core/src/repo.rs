//! Repository handle — the entry point for all read operations.

use std::path::Path;

use crate::error::Result;

/// An opened git repository. Wraps a `git2::Repository` and exposes gitp-core's
/// frontend-agnostic operations (log, commit detail, config).
pub struct Repo {
    pub(crate) inner: git2::Repository,
}

impl Repo {
    /// Open the repository at `path` (or any parent — respects the git discovery
    /// rules). Errors if `path` is not inside a git working tree.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let inner = git2::Repository::discover(path)?;
        Ok(Self { inner })
    }
}
