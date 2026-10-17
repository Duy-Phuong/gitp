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

    /// A network operation stopped by its cancel flag (see `NetworkHooks`).
    /// Frontends match on this text to report a cancel as a cancel, not a
    /// failure — keep it in step with gitp-gui's `isCancelled`.
    #[error("operation cancelled")]
    Cancelled,
}

pub type Result<T> = std::result::Result<T, Error>;
