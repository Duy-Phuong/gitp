//! The reflog view: where HEAD (or one branch) has been, so a lost commit can
//! be found again. Read-only — acting on an entry reuses the commit commands
//! (checkout, create branch, reset), so their undo recording still applies.

use gitp_core::ReflogEntry;
use tauri::State;

use crate::state::{with_repo, RepoState};

/// How many entries the view lists. Covers months of everyday work; older
/// moves are rarely what someone is trying to recover.
const REFLOG_LIMIT: usize = 500;

/// The newest entries of `refname`'s reflog (`HEAD` or `refs/heads/<name>`).
fn get_reflog_impl(state: &RepoState, refname: String) -> Result<Vec<ReflogEntry>, String> {
    with_repo(state, |repo| repo.reflog(&refname, REFLOG_LIMIT))
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn get_reflog(
    refname: String,
    state: State<RepoState>,
) -> Result<Vec<ReflogEntry>, String> {
    get_reflog_impl(&state, refname)
}
