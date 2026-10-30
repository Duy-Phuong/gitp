//! Actions on a single commit in the graph: check it out, cherry-pick,
//! revert, or reset the current branch to it — or save commits as a patch.

use gitp_core::ResetMode;
use tauri::State;

use crate::state::{with_repo, RepoState};
use crate::undo::{with_recorded_checkout, with_recorded_head_move};

/// Detach HEAD onto `rev`. Invalidates the cached log because HEAD moves.
pub(crate) fn checkout_commit_impl(state: &RepoState, rev: String) -> Result<String, String> {
    with_recorded_checkout(
        state,
        || format!("Checkout {}", short_rev(&rev)),
        |repo| repo.checkout_commit(&rev),
    )
}

/// A short display form of a revision for undo labels (12-char id, or the name).
fn short_rev(rev: &str) -> String {
    if rev.len() > 12 && rev.bytes().all(|b| b.is_ascii_hexdigit()) {
        rev[..12].to_string()
    } else {
        rev.to_string()
    }
}

/// Cherry-pick `rev` onto the current branch. Invalidates the cached log.
fn cherry_pick_impl(state: &RepoState, rev: String) -> Result<String, String> {
    with_recorded_head_move(state, "Cherry-pick", false, |repo| repo.cherry_pick(&rev))
}

/// Revert `rev` on the current branch. Invalidates the cached log.
fn revert_impl(state: &RepoState, rev: String) -> Result<String, String> {
    with_recorded_head_move(state, "Revert", false, |repo| repo.revert(&rev))
}

/// Reset the current branch to `rev`. Invalidates the cached log.
pub(crate) fn reset_impl(
    state: &RepoState,
    rev: String,
    mode: ResetMode,
) -> Result<String, String> {
    // A soft reset leaves the index as it was, so its undo must too: a `--keep`
    // undo would refuse (or, for a staged-new file, drop it back to untracked).
    let soft = matches!(mode, ResetMode::Soft);
    with_recorded_head_move(state, "Reset", soft, |repo| repo.reset(&rev, mode))
}

/// Write `revs` (in that order) to `path` as one patch file.
fn save_commits_patch_impl(
    state: &RepoState,
    revs: Vec<String>,
    path: String,
) -> Result<String, String> {
    with_repo(state, |repo| repo.save_commits_patch(&revs, path.as_ref()))
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn checkout_commit(rev: String, state: State<RepoState>) -> Result<String, String> {
    checkout_commit_impl(&state, rev)
}

#[tauri::command(async)]
pub(crate) fn cherry_pick(rev: String, state: State<RepoState>) -> Result<String, String> {
    cherry_pick_impl(&state, rev)
}

#[tauri::command(async)]
pub(crate) fn revert(rev: String, state: State<RepoState>) -> Result<String, String> {
    revert_impl(&state, rev)
}

#[tauri::command(async)]
pub(crate) fn save_commits_patch(
    revs: Vec<String>,
    path: String,
    state: State<RepoState>,
) -> Result<String, String> {
    save_commits_patch_impl(&state, revs, path)
}

#[tauri::command(async)]
pub(crate) fn reset(
    rev: String,
    mode: ResetMode,
    state: State<RepoState>,
) -> Result<String, String> {
    reset_impl(&state, rev, mode)
}
