//! The Activity view: the git commands gitp ran for the active repository,
//! newest first (see `gitp_core::ActivityEntry`). The view polls while open,
//! asking only for what's newer than the last entry it has.

use gitp_core::ActivityEntry;
use tauri::State;

use crate::state::{with_repo, RepoState};

fn get_activity_log_impl(
    state: &RepoState,
    since: Option<u64>,
) -> Result<Vec<ActivityEntry>, String> {
    with_repo(state, |repo| Ok(repo.activity_log(since)))
}

fn clear_activity_log_impl(state: &RepoState) -> Result<(), String> {
    with_repo(state, |repo| {
        repo.clear_activity_log();
        Ok(())
    })
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn get_activity_log(
    since: Option<u64>,
    state: State<RepoState>,
) -> Result<Vec<ActivityEntry>, String> {
    get_activity_log_impl(&state, since)
}

#[tauri::command(async)]
pub(crate) fn clear_activity_log(state: State<RepoState>) -> Result<(), String> {
    clear_activity_log_impl(&state)
}

#[cfg(test)]
mod tests {
    use super::{clear_activity_log_impl, get_activity_log_impl};
    use crate::staging::stage_impl;
    use crate::state::RepoState;
    use crate::test_support::make_repo;
    use crate::workspace::open_repo_impl;

    #[test]
    fn lists_the_active_repos_commands_and_what_is_new_since_a_poll() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        std::fs::write(dir.path().join("new.txt"), "n\n").unwrap();
        stage_impl(&state, "new.txt".into()).unwrap();
        let log = get_activity_log_impl(&state, None).unwrap();
        let add = log
            .iter()
            .find(|e| e.command == "git add -- :(literal)new.txt")
            .expect("the stage is logged");
        assert!(add.success && !add.quiet);

        let newest = log[0].id;
        assert!(get_activity_log_impl(&state, Some(newest))
            .unwrap()
            .is_empty());

        clear_activity_log_impl(&state).unwrap();
        assert!(get_activity_log_impl(&state, None).unwrap().is_empty());
    }
}
