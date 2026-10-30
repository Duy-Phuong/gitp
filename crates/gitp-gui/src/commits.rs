//! Actions on a single commit in the graph: check it out, cherry-pick,
//! revert, or reset the current branch to it — or save commits as a patch.

use gitp_core::{HeadMoveMode, PickPlanOutcome, PickStep, ResetMode, Undoable};
use tauri::State;

use crate::state::{to_message, with_repo, RepoState};
use crate::undo::{
    clear_undo, set_undo, with_recorded_checkout, with_recorded_hard_reset, with_recorded_head_move,
};

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
    with_recorded_head_move(state, "Cherry-pick", HeadMoveMode::Keep, |repo| {
        repo.cherry_pick(&rev)
    })
}

/// Cherry-pick an edited plan of commits onto the current branch. A plan that
/// runs through is one undo step; one paused on a conflict records nothing
/// (see `with_recorded_head_move`) until its continuation finishes.
pub(crate) fn cherry_pick_plan_impl(
    state: &RepoState,
    steps: Vec<PickStep>,
) -> Result<PickPlanOutcome, String> {
    with_recorded_head_move(state, "Cherry-pick", HeadMoveMode::Keep, |repo| {
        repo.cherry_pick_plan(&steps)
    })
}

/// Resume a plan paused on a conflict. The resolver's own `--continue` was
/// recorded as an undo of just that commit; once the plan finishes the slot
/// is replaced by the whole run, back to the HEAD the plan started from.
pub(crate) fn continue_cherry_pick_plan_impl(state: &RepoState) -> Result<PickPlanOutcome, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let out = session
        .repo
        .continue_cherry_pick_plan()
        .map_err(to_message)?;
    if out.paused || session.repo.operation_in_progress() {
        clear_undo(session);
        return Ok(out);
    }
    let after = session.repo.head_commit_id().map_err(to_message)?;
    if after != out.start_head {
        set_undo(
            session,
            Undoable::HeadMoved {
                label: "Cherry-pick".into(),
                before: out.start_head.clone(),
                after,
                mode: HeadMoveMode::Keep,
                backup: None,
            },
        );
    }
    Ok(out)
}

/// Revert `rev` on the current branch. Invalidates the cached log.
fn revert_impl(state: &RepoState, rev: String) -> Result<String, String> {
    with_recorded_head_move(state, "Revert", HeadMoveMode::Keep, |repo| {
        repo.revert(&rev)
    })
}

/// Reset the current branch to `rev`. Invalidates the cached log.
pub(crate) fn reset_impl(
    state: &RepoState,
    rev: String,
    mode: ResetMode,
) -> Result<String, String> {
    // Undone the way it was done: a soft reset leaves the index as it was, and
    // a mixed one leaves the files it moved past as local edits, so a `--keep`
    // undo would refuse them (or drop a staged-new file back to untracked). A
    // hard reset left a clean tree, so `--keep` is safe — and its uncommitted
    // work is backed up first, for the undo to put back.
    let undo_mode = match mode {
        ResetMode::Soft => HeadMoveMode::Soft,
        ResetMode::Mixed => HeadMoveMode::Mixed,
        ResetMode::Hard => {
            return with_recorded_hard_reset(state, |repo| repo.reset(&rev, mode));
        }
    };
    with_recorded_head_move(state, "Reset", undo_mode, |repo| repo.reset(&rev, mode))
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
pub(crate) fn cherry_pick_plan(
    steps: Vec<PickStep>,
    state: State<RepoState>,
) -> Result<PickPlanOutcome, String> {
    cherry_pick_plan_impl(&state, steps)
}

#[tauri::command(async)]
pub(crate) fn continue_cherry_pick_plan(
    state: State<RepoState>,
) -> Result<PickPlanOutcome, String> {
    continue_cherry_pick_plan_impl(&state)
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
