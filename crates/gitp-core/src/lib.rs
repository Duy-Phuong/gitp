//! gitp-core: all git logic for gitp (repo, log graph, diffs, config).
//!
//! Frontend-agnostic. No UI, no CLI concerns. Returns plain data structures.

mod config;
mod diff;
mod error;
mod graph;
mod log;
mod repo;

pub use config::{ConfigEntry, ConfigScope};
pub use diff::{ChangeKind, CommitDetail, DiffHunk, DiffLine, FileDiff};
pub use error::{Error, Result};
pub use log::{CommitRow, LogOptions};
pub use repo::Repo;
