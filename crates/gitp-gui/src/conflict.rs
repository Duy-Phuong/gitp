//! Merge / rebase conflict resolution.

use gitp_core::{ConflictSides, ConflictStatus, HeadMoveMode, Repo, SideCommits};
use tauri::State;

use crate::claude_jobs::{ClaudeJobs, JobKind, NewJob};
use crate::state::{to_message, with_repo, with_repo_clearing_undo, with_repo_unlocked, RepoState};
use crate::undo::with_recorded_head_move;

/// The in-progress conflict session (merge or rebase), if any.
fn conflict_status_impl(state: &RepoState) -> Result<ConflictStatus, String> {
    with_repo(state, Repo::conflict_status)
}

/// The ours/theirs/base/working versions of a conflicted file.
fn conflict_sides_impl(state: &RepoState, path: String) -> Result<ConflictSides, String> {
    with_repo(state, |repo| repo.conflict_sides(&path))
}

/// Write the resolved content for `path` and stage it (marks it resolved).
fn resolve_conflict_impl(state: &RepoState, path: String, content: String) -> Result<(), String> {
    with_repo_clearing_undo(state, |repo| repo.resolve_conflict(&path, &content))
}

/// Resolve `path` by taking one whole side (ours/theirs), for binary conflicts.
fn resolve_conflict_side_impl(state: &RepoState, path: String, ours: bool) -> Result<(), String> {
    with_repo_clearing_undo(state, |repo| repo.resolve_conflict_side(&path, ours))
}

/// Abort the in-progress merge/rebase. Invalidates the cached log (HEAD/tree).
fn abort_conflict_impl(state: &RepoState) -> Result<String, String> {
    with_repo_clearing_undo(state, Repo::abort_conflict)
}

/// Commit the merge / continue the rebase. Invalidates the cached log.
///
/// Finishing a merge, cherry-pick or revert is an ordinary HEAD move from the
/// branch tip to the new commit, so it is recorded like one. A rebase is not:
/// while paused its HEAD is detached on an intermediate commit, so "before"
/// would be a commit the branch never pointed at — the slot is cleared instead.
fn finish_conflict_impl(state: &RepoState, message: String) -> Result<String, String> {
    let kind = with_repo(state, Repo::conflict_status)?.kind;
    let label = match kind.as_str() {
        "merge" => "Merge",
        "cherry-pick" => "Cherry-pick",
        "revert" => "Revert",
        _ => return with_repo_clearing_undo(state, |repo| repo.finish_conflict(&message)),
    };
    with_recorded_head_move(state, label, HeadMoveMode::Keep, |repo| {
        repo.finish_conflict(&message)
    })
}

/// The commits each side made to `path` since the sides split.
fn conflict_side_commits_impl(state: &RepoState, path: String) -> Result<SideCommits, String> {
    with_repo_unlocked(state, |repo| repo.conflict_side_commits(&path))
}

/// Run `command` to suggest resolutions for the conflicts of `path`, with
/// `input` on its stdin: a Claude job, so it shows in the jobs list with its
/// Stop, and holds no lock while the model thinks.
fn suggest_conflict_resolution_impl(
    state: &RepoState,
    jobs: &ClaudeJobs,
    path: String,
    command: String,
    input: String,
) -> Result<String, String> {
    let repo_path = {
        let guard = state.workspace();
        let idx = guard.active.ok_or("no repository is open")?;
        guard.sessions[idx].path.clone()
    };
    let mut repo = Repo::open(&repo_path).map_err(to_message)?;
    let name = path.rsplit('/').next().unwrap_or(&path).to_string();
    let run = jobs.begin(NewJob {
        kind: JobKind::Resolve,
        label: format!("Resolve conflict · {name}"),
        activity: String::new(),
        repo: repo_path.clone(),
        pr: 0,
        thread: None,
        finding: Some(path),
        command: command.clone(),
        stdin_bytes: input.len(),
    })?;
    repo.set_network_hooks(run.hooks());
    let out = repo
        .suggest_conflict_resolution(&command, &input)
        .map_err(to_message);
    run.finish(out.clone(), &[]);
    out
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn conflict_status(state: State<RepoState>) -> Result<ConflictStatus, String> {
    conflict_status_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn conflict_sides(
    path: String,
    state: State<RepoState>,
) -> Result<ConflictSides, String> {
    conflict_sides_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn resolve_conflict(
    path: String,
    content: String,
    state: State<RepoState>,
) -> Result<(), String> {
    resolve_conflict_impl(&state, path, content)
}

#[tauri::command(async)]
pub(crate) fn resolve_conflict_side(
    path: String,
    ours: bool,
    state: State<RepoState>,
) -> Result<(), String> {
    resolve_conflict_side_impl(&state, path, ours)
}

#[tauri::command(async)]
pub(crate) fn abort_conflict(state: State<RepoState>) -> Result<String, String> {
    abort_conflict_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn finish_conflict(message: String, state: State<RepoState>) -> Result<String, String> {
    finish_conflict_impl(&state, message)
}

#[tauri::command(async)]
pub(crate) fn conflict_side_commits(
    path: String,
    state: State<RepoState>,
) -> Result<SideCommits, String> {
    conflict_side_commits_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn suggest_conflict_resolution(
    path: String,
    command: String,
    input: String,
    state: State<RepoState>,
    jobs: State<ClaudeJobs>,
) -> Result<String, String> {
    suggest_conflict_resolution_impl(&state, &jobs, path, command, input)
}
