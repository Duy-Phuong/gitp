//! The Clean Up Storage dialog's reads: merged branches, build folders, and
//! how big a folder is. Removing worktrees and deleting branches go through
//! their own commands (worktrees.rs, branches.rs), with their checks and Undo.

use gitp_core::{MergedBranches, Repo};
use tauri::State;

use crate::state::{to_message, with_repo_unlocked, RepoState};

#[tauri::command(async)]
pub(crate) fn merged_branches(state: State<RepoState>) -> Result<MergedBranches, String> {
    with_repo_unlocked(&state, Repo::merged_branches)
}

#[tauri::command(async)]
pub(crate) fn build_folders(state: State<RepoState>) -> Result<Vec<String>, String> {
    with_repo_unlocked(&state, |repo| {
        Ok(repo
            .build_folders()?
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect())
    })
}

/// The size of `path` in bytes; it can take a while on a big build folder,
/// so each row asks on its own.
#[tauri::command(async)]
pub(crate) fn disk_usage(path: String) -> Result<u64, String> {
    gitp_core::disk_usage(std::path::Path::new(&path)).map_err(to_message)
}
