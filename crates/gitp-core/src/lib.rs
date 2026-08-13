//! gitp-core: all git logic for gitp (repo, log graph, diffs, config).
//!
//! Frontend-agnostic. No UI, no CLI concerns. Returns plain data structures.

mod checkout;
mod config;
mod diff;
mod error;
mod graph;
mod log;
mod refs;
mod repo;
mod status;

pub use config::{ConfigEntry, ConfigScope};
pub use diff::{ChangeKind, CommitDetail, DiffHunk, DiffLine, FileDiff};
pub use error::{Error, Result};
pub use log::{CommitRow, LogOptions};
pub use refs::{BranchRef, Refs, RemoteBranch, StashRef, TagRef};
pub use repo::Repo;
