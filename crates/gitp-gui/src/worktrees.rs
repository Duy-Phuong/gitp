//! Linked worktrees: list, add, move, remove, lock / unlock, prune. Opening one is
//! the ordinary `open_repo` — a worktree is a repository folder like any other.

use std::path::Path;

use gitp_core::{StaleWorktree, Worktree, WorktreeSummary, WorktreeTarget, WorktreeUnsavedWork};
use tauri::State;

use crate::state::{with_repo, with_repo_unlocked, RepoState};

/// Every worktree of the active repo, the main one first.
fn list_worktrees_impl(state: &RepoState) -> Result<Vec<Worktree>, String> {
    with_repo(state, |repo| repo.worktrees())
}

/// Each worktree's changed-file count and ahead/behind for the sidebar. One
/// `git status` per worktree, so off the workspace lock: a big worktree's
/// status must not stall every other command.
fn worktree_summaries_impl(state: &RepoState) -> Result<Vec<WorktreeSummary>, String> {
    with_repo_unlocked(state, |repo| repo.worktree_summaries())
}

/// What removing the worktree at `path` would lose, asked before the remove.
fn worktree_unsaved_work_impl(
    state: &RepoState,
    path: String,
) -> Result<WorktreeUnsavedWork, String> {
    with_repo_unlocked(state, |repo| repo.worktree_unsaved_work(Path::new(&path)))
}

/// Add a worktree at `path` checking out `target`; returns its absolute path
/// so the frontend can open it. A new branch shows up through the refs
/// fingerprint; this worktree's own HEAD and files are untouched.
fn add_worktree_impl(
    state: &RepoState,
    path: String,
    target: WorktreeTarget,
) -> Result<String, String> {
    with_repo(state, |repo| repo.add_worktree(&path, &target))
        .map(|p| p.to_string_lossy().into_owned())
}

/// Move the worktree at `path` to `to`; returns its new absolute path, so the
/// frontend can reopen a tab that had it open.
fn move_worktree_impl(state: &RepoState, path: String, to: String) -> Result<String, String> {
    with_repo(state, |repo| repo.move_worktree(Path::new(&path), &to))
        .map(|p| p.to_string_lossy().into_owned())
}

fn remove_worktree_impl(state: &RepoState, path: String, force: bool) -> Result<String, String> {
    with_repo(state, |repo| repo.remove_worktree(Path::new(&path), force))
}

fn lock_worktree_impl(state: &RepoState, path: String, reason: String) -> Result<String, String> {
    with_repo(state, |repo| repo.lock_worktree(Path::new(&path), &reason))
}

fn unlock_worktree_impl(state: &RepoState, path: String) -> Result<String, String> {
    with_repo(state, |repo| repo.unlock_worktree(Path::new(&path)))
}

fn prune_worktrees_impl(state: &RepoState) -> Result<String, String> {
    with_repo(state, |repo| repo.prune_worktrees())
}

fn stale_worktrees_impl(state: &RepoState) -> Result<Vec<StaleWorktree>, String> {
    with_repo(state, |repo| repo.stale_worktrees())
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn list_worktrees(state: State<RepoState>) -> Result<Vec<Worktree>, String> {
    list_worktrees_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn worktree_summaries(state: State<RepoState>) -> Result<Vec<WorktreeSummary>, String> {
    worktree_summaries_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn worktree_unsaved_work(
    path: String,
    state: State<RepoState>,
) -> Result<WorktreeUnsavedWork, String> {
    worktree_unsaved_work_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn add_worktree(
    path: String,
    target: WorktreeTarget,
    state: State<RepoState>,
) -> Result<String, String> {
    add_worktree_impl(&state, path, target)
}

#[tauri::command(async)]
pub(crate) fn move_worktree(
    path: String,
    to: String,
    state: State<RepoState>,
) -> Result<String, String> {
    move_worktree_impl(&state, path, to)
}

#[tauri::command(async)]
pub(crate) fn remove_worktree(
    path: String,
    force: bool,
    state: State<RepoState>,
) -> Result<String, String> {
    remove_worktree_impl(&state, path, force)
}

#[tauri::command(async)]
pub(crate) fn lock_worktree(
    path: String,
    reason: String,
    state: State<RepoState>,
) -> Result<String, String> {
    lock_worktree_impl(&state, path, reason)
}

#[tauri::command(async)]
pub(crate) fn unlock_worktree(path: String, state: State<RepoState>) -> Result<String, String> {
    unlock_worktree_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn prune_worktrees(state: State<RepoState>) -> Result<String, String> {
    prune_worktrees_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn stale_worktrees(state: State<RepoState>) -> Result<Vec<StaleWorktree>, String> {
    stale_worktrees_impl(&state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{head_branch, make_repo};
    use crate::workspace::open_repo_impl;

    #[test]
    fn adds_lists_and_removes_a_worktree_of_the_active_repo() {
        let root = tempfile::tempdir().unwrap();
        let main = root.path().join("main");
        std::fs::create_dir(&main).unwrap();
        make_repo(&main, &["one"]);
        let state = RepoState::default();
        open_repo_impl(&state, main.to_str().unwrap().into()).unwrap();

        let target = WorktreeTarget::NewBranch {
            name: "side".into(),
            start: head_branch(&main),
        };
        let added = add_worktree_impl(&state, "../side".into(), target).unwrap();
        assert!(Path::new(&added).join("f.txt").exists());

        let list = list_worktrees_impl(&state).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].branch.as_deref(), Some("side"));

        std::fs::write(Path::new(&added).join("new.txt"), "x").unwrap();
        let summaries = worktree_summaries_impl(&state).unwrap();
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[1].changed, 1);
        let unsaved = worktree_unsaved_work_impl(&state, added.clone()).unwrap();
        assert_eq!(unsaved.changed, vec!["new.txt".to_string()]);
        std::fs::remove_file(Path::new(&added).join("new.txt")).unwrap();

        let moved = move_worktree_impl(&state, added, "../side-moved".into()).unwrap();
        assert!(Path::new(&moved).join("f.txt").exists());
        assert!(stale_worktrees_impl(&state).unwrap().is_empty());

        remove_worktree_impl(&state, moved, false).unwrap();
        assert_eq!(list_worktrees_impl(&state).unwrap().len(), 1);
    }
}
