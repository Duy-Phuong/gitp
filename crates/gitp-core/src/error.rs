//! Typed errors for gitp-core. Frontends map these to their own presentation.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("git error: {0}")]
    Git(#[from] git2::Error),

    /// A failure that isn't a libgit2 error — e.g. a shelled-out `git` command
    /// that exited non-zero, carrying its combined output as the message.
    #[error("{0}")]
    Message(String),
}

pub type Result<T> = std::result::Result<T, Error>;
