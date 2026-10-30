//! Git Flow: its settings, initialising it, and starting / finishing feature,
//! release and hotfix branches (see gitp-core's `gitflow`).

use gitp_core::{FlowKind, GitFlowConfig};
use tauri::State;

use crate::state::{with_repo, with_repo_clearing_undo, RepoState};
use crate::undo::with_recorded_branch_create;

/// The repo's Git Flow settings, or `None` before it is initialised.
fn gitflow_config_impl(state: &RepoState) -> Result<Option<GitFlowConfig>, String> {
    with_repo(state, |repo| repo.gitflow_config())
}

/// Store the settings and create develop if needed. Moves no HEAD, so nothing
/// recorded for undo is affected.
fn gitflow_init_impl(state: &RepoState, config: GitFlowConfig) -> Result<String, String> {
    with_repo(state, |repo| repo.gitflow_init(&config))
}

/// Start a flow branch: a branch created and checked out, so it is recorded
/// like any other — undo goes back to the previous branch and deletes it.
fn gitflow_start_impl(state: &RepoState, kind: FlowKind, name: String) -> Result<String, String> {
    let (branch, base) = with_repo(state, |repo| repo.gitflow_start_target(kind, &name))?;
    with_recorded_branch_create(state, &branch, Some(&base), |repo| {
        repo.gitflow_start(kind, &name)
    })
}

/// Finish a flow branch. Several merges, a tag and a delete that undo's single
/// slot can't put back as one, so whatever it held is dropped.
fn gitflow_finish_impl(
    state: &RepoState,
    branch: String,
    tag_message: Option<String>,
) -> Result<String, String> {
    with_repo_clearing_undo(state, |repo| {
        repo.gitflow_finish(&branch, tag_message.as_deref())
    })
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn gitflow_config(state: State<RepoState>) -> Result<Option<GitFlowConfig>, String> {
    gitflow_config_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn gitflow_init(
    config: GitFlowConfig,
    state: State<RepoState>,
) -> Result<String, String> {
    gitflow_init_impl(&state, config)
}

#[tauri::command(async)]
pub(crate) fn gitflow_start(
    kind: FlowKind,
    name: String,
    state: State<RepoState>,
) -> Result<String, String> {
    gitflow_start_impl(&state, kind, name)
}

#[tauri::command(async)]
pub(crate) fn gitflow_finish(
    branch: String,
    tag_message: Option<String>,
    state: State<RepoState>,
) -> Result<String, String> {
    gitflow_finish_impl(&state, branch, tag_message)
}

#[cfg(test)]
mod tests {
    use super::{gitflow_init_impl, gitflow_start_impl};
    use crate::state::RepoState;
    use crate::test_support::{branch_names, head_branch, make_repo};
    use crate::undo::{undo_impl, undo_state_impl};
    use crate::workspace::open_repo_impl;
    use gitp_core::{FlowKind, GitFlowConfig};

    #[test]
    fn undoing_a_start_returns_to_the_previous_branch_and_deletes_the_new_one() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let production = head_branch(dir.path());
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");
        let config = GitFlowConfig {
            production: production.clone(),
            develop: "develop".into(),
            feature: "feature/".into(),
            release: "release/".into(),
            hotfix: "hotfix/".into(),
            version_tag: String::new(),
        };
        gitflow_init_impl(&state, config).expect("init");

        gitflow_start_impl(&state, FlowKind::Feature, "login".into()).expect("start");
        assert_eq!(head_branch(dir.path()), "feature/login");
        let undo = undo_state_impl(&state).expect("undo state");
        assert_eq!(undo.undo.as_deref(), Some("Create branch feature/login"));

        undo_impl(&state).expect("undo");
        assert_eq!(head_branch(dir.path()), production);
        assert!(!branch_names(dir.path()).contains(&"feature/login".to_string()));
    }
}
