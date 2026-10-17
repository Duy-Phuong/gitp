//! Guided bisect: start a session, mark commits good / bad / skip, and reset.

use gitp_core::{BisectMark, BisectStatus, Repo};
use tauri::State;

use crate::state::{with_repo, with_repo_clearing_undo, RepoState};

/// The in-progress bisect, or `None`. Only reads state.
fn bisect_status_impl(state: &RepoState) -> Result<Option<BisectStatus>, String> {
    with_repo(state, Repo::bisect_status)
}

/// Start a bisect. Every step checks out another commit, none of which undo
/// may reverse (see `Repo::operation_in_progress`), so the slots are cleared.
pub(crate) fn bisect_start_impl(
    state: &RepoState,
    bad: Option<String>,
    good: Vec<String>,
) -> Result<String, String> {
    with_repo_clearing_undo(state, |repo| repo.bisect_start(bad.as_deref(), &good))
}

pub(crate) fn bisect_mark_impl(
    state: &RepoState,
    mark: BisectMark,
    rev: Option<String>,
) -> Result<String, String> {
    with_repo_clearing_undo(state, |repo| repo.bisect_mark(mark, rev.as_deref()))
}

pub(crate) fn bisect_reset_impl(state: &RepoState) -> Result<String, String> {
    with_repo_clearing_undo(state, Repo::bisect_reset)
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn bisect_status(state: State<RepoState>) -> Result<Option<BisectStatus>, String> {
    bisect_status_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn bisect_start(
    bad: Option<String>,
    good: Vec<String>,
    state: State<RepoState>,
) -> Result<String, String> {
    bisect_start_impl(&state, bad, good)
}

#[tauri::command(async)]
pub(crate) fn bisect_mark(
    mark: BisectMark,
    rev: Option<String>,
    state: State<RepoState>,
) -> Result<String, String> {
    bisect_mark_impl(&state, mark, rev)
}

#[tauri::command(async)]
pub(crate) fn bisect_reset(state: State<RepoState>) -> Result<String, String> {
    bisect_reset_impl(&state)
}

#[cfg(test)]
mod tests {
    use gitp_core::BisectMark;

    use super::{bisect_mark_impl, bisect_reset_impl, bisect_start_impl};
    use crate::commits::checkout_commit_impl;
    use crate::history::get_log_page_impl;
    use crate::staging::stage_impl;
    use crate::state::RepoState;
    use crate::test_support::{head_branch, make_repo};
    use crate::undo::{undo_impl, undo_state_impl};
    use crate::workspace::{open_repo_impl, workspace_snapshot_impl};

    #[test]
    fn a_bisect_shows_in_the_snapshot_and_never_arms_undo() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1", "c2", "c3", "c4", "c5", "c6"]);
        let branch = head_branch(dir.path());
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");
        assert!(workspace_snapshot_impl(&state).unwrap().bisect.is_none());
        let rows = get_log_page_impl(&state, 0, 10, true).unwrap().rows;
        let (c6, c1) = (rows[0].id.clone(), rows[5].id.clone());

        // Something armed, to see the bisect drop it.
        std::fs::write(dir.path().join("new.txt"), "n\n").unwrap();
        stage_impl(&state, "new.txt".into()).unwrap();
        assert!(undo_state_impl(&state).unwrap().undo.is_some());

        bisect_start_impl(&state, Some("HEAD".into()), vec![c1.clone()]).expect("start");
        let snap = workspace_snapshot_impl(&state).unwrap();
        let bisect = snap.bisect.expect("bisect in the snapshot");
        assert_eq!(bisect.bad.as_deref(), Some(c6.as_str()));
        assert_eq!(bisect.original_ref, branch);
        assert_eq!(undo_state_impl(&state).unwrap().undo, None);

        // A checkout and a mark mid-bisect move HEAD, but neither is undoable.
        checkout_commit_impl(&state, c6.clone()).expect("checkout");
        assert_eq!(undo_state_impl(&state).unwrap().undo, None);
        assert!(undo_impl(&state).is_err());
        bisect_mark_impl(&state, BisectMark::Good, Some(rows[2].id.clone())).expect("mark");
        assert_eq!(undo_state_impl(&state).unwrap().undo, None);

        bisect_reset_impl(&state).expect("reset");
        assert!(workspace_snapshot_impl(&state).unwrap().bisect.is_none());
        assert_eq!(head_branch(dir.path()), branch);
        assert_eq!(undo_state_impl(&state).unwrap().undo, None);
    }
}
