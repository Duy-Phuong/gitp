//! gitp-core: all git logic for gitp (repo, log graph, diffs, config).
//!
//! Frontend-agnostic. No UI, no CLI concerns. Returns plain data structures.

mod bisect;
mod blame;
mod branch_ops;
mod checkout;
mod commit_ops;
mod compare;
mod config;
mod conflict_ops;
mod diff;
mod error;
mod file_ops;
mod filelog;
mod graph;
mod hunk;
mod line_staging;
mod log;
mod progress;
mod rebase;
mod reflog;
mod refs;
mod remote;
mod repo;
mod search;
mod signature;
mod stash_ops;
mod status;
mod tag_ops;
mod tree;
mod undo;

pub use bisect::{BisectMark, BisectStatus};
pub use blame::BlameLine;
pub use commit_ops::ResetMode;
pub use compare::{CompareEnd, Comparison};
pub use config::{ConfigEntry, ConfigScope};
pub use conflict_ops::{ConflictSides, ConflictStatus};
pub use diff::{ChangeKind, CommitDetail, DiffHunk, DiffLine, FileDiff, DEFAULT_CONTEXT_LINES};
pub use error::{Error, Result};
pub use filelog::FileCommit;
pub use log::{CommitRow, LogCache, LogOptions, LogRefresh};
pub use progress::{NetworkHooks, Progress, ProgressFn};
pub use rebase::{RebaseAction, RebaseCommit, RebaseStatus, RebaseStep};
pub use reflog::ReflogEntry;
pub use refs::{BranchRef, Refs, RemoteBranch, StashRef, TagRef};
pub use remote::PullMode;
pub use repo::Repo;
pub use search::LogSearch;
pub use signature::{CommitSignature, SignatureStatus, SigningConfig};
pub use status::StatusLists;
pub use tag_ops::TagDetail;
pub use undo::{DeletedBranch, FileBlob, Undoable};
