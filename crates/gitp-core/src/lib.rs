//! gitp-core: all git logic for gitp (repo, log graph, diffs, config).
//!
//! Frontend-agnostic. No UI, no CLI concerns. Returns plain data structures.

mod activity;
mod bisect;
mod blame;
mod branch_ops;
mod checkout;
mod commit_ops;
mod compare;
mod config;
mod conflict_ops;
mod create;
mod diff;
mod encoding;
mod error;
mod external_tool;
mod file_content;
mod file_edit;
mod file_ops;
mod filelog;
mod gh;
mod git_bin;
mod gitflow;
mod graph;
mod hunk;
mod identity;
mod lfs;
mod line_staging;
mod log;
mod pick_plan;
mod progress;
mod rebase;
mod reflog;
mod refs;
mod remote;
mod remote_config;
mod repo;
mod search;
mod signature;
mod stash_ops;
mod status;
mod submodule_ops;
mod tag_ops;
mod tree;
mod undo;
mod worktree_ops;

pub use activity::ActivityEntry;
pub use bisect::{BisectMark, BisectStatus};
pub use blame::BlameLine;
pub use branch_ops::MergeMode;
pub use checkout::StashSwitch;
pub use commit_ops::ResetMode;
pub use compare::{CompareEnd, Comparison, EMPTY_REV, WORKDIR_REV};
pub use config::{ConfigEntry, ConfigScope};
pub use conflict_ops::{ConflictSides, ConflictStatus};
pub use create::{clone_repo, init_repo, CloneOptions};
pub use diff::{
    ChangeKind, CommitDetail, DiffHunk, DiffLine, FileDiff, DEFAULT_CONTEXT_LINES, MAX_DIFF_LINES,
};
pub use encoding::{TextEncoding, ENCODING_KEY};
pub use error::{Error, Result};
pub use external_tool::DiffToolTarget;
pub use file_content::{FileContent, FileSide, PREVIEW_MAX_BYTES};
pub use file_edit::{TextFile, EDIT_MAX_BYTES};
pub use filelog::FileCommit;
pub use gh::{
    DiffSide, Gh, GhAccount, GhLogin, LineComment, PrCheck, PrComment, PrFilter, PrLabel,
    PrReview, PrReviewComment, PullRequest, PullRequestDetail, ReviewVerdict, LOGIN_TIMEOUT,
};
pub use gitflow::{FlowKind, GitFlowConfig};
pub use identity::{global_identity, restore_local_identity, set_global_identity, Identity};
pub use lfs::LfsStatus;
pub use log::{CommitRow, LogCache, LogOptions, LogRefresh, LogScope};
pub use pick_plan::{PickAction, PickPlanOutcome, PickStep};
pub use progress::{NetworkHooks, Progress, ProgressFn};
pub use rebase::{RebaseAction, RebaseCommit, RebaseStatus, RebaseStep};
pub use reflog::ReflogEntry;
pub use refs::{BranchRef, Refs, RemoteBranch, StashRef, TagRef};
pub use remote::PullMode;
pub use remote_config::RemoteInfo;
pub use repo::Repo;
pub use search::LogSearch;
pub use signature::{CommitSignature, SignatureStatus, SigningConfig};
pub use status::StatusLists;
pub use submodule_ops::{Submodule, SubmoduleState};
pub use tag_ops::TagDetail;
pub use undo::{DeletedBranch, FileBlob, HeadMoveMode, Undoable};
pub use worktree_ops::{
    StaleWorktree, Worktree, WorktreeSummary, WorktreeTarget, WorktreeUnsavedWork,
};
