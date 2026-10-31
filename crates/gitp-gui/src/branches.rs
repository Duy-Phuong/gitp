//! Local branches: checkout, create, rename, delete (singly or in bulk),
//! merge (with its options), fast-forward, and upstream tracking.

use std::collections::HashSet;

use gitp_core::{DeletedBranch, HeadMoveMode, MergeMode, Repo, StashSwitch, Undoable};
use serde::Serialize;
use tauri::State;

use crate::state::{
    ensure_refs, to_message, with_repo, with_repo_clearing_undo, with_repo_networked, RepoState,
};
use crate::undo::{
    clear_undo, set_undo, with_recorded_branch_create, with_recorded_checkout,
    with_recorded_head_move, with_recorded_upstream,
};

/// Check out `name` on the active repo. Invalidates the cached log because HEAD
/// moves, so the next `get_log_page` recomputes the walk from the new HEAD.
fn checkout_branch_impl(state: &RepoState, name: String) -> Result<(), String> {
    with_recorded_checkout(
        state,
        || format!("Checkout {name}"),
        |repo| repo.checkout_branch(&name),
    )
}

/// Stash & Switch: check out `target` — a local branch (`kind` "branch"), a
/// remote-tracking branch ("remote") or a commit, detached ("commit") — with
/// the uncommitted work stashed across the switch and popped there. Clears
/// undo rather than recording the switch: undoing it would carry the popped
/// work back as it stands, not reverse the stash.
fn stash_and_switch_impl(
    state: &RepoState,
    kind: String,
    target: String,
) -> Result<StashSwitch, String> {
    with_repo_clearing_undo(state, |repo| {
        repo.stash_and_switch(&target, |r| match kind.as_str() {
            "branch" => r
                .checkout_branch(&target)
                .map(|()| format!("Switched to {target}")),
            "remote" => r.checkout_remote(&target),
            "commit" => r.checkout_commit(&target),
            _ => Err(gitp_core::Error::Message(format!(
                "unknown checkout kind {kind}"
            ))),
        })
    })
}

/// Check out a remote-tracking branch (creating a local tracking branch if
/// needed). Invalidates the cached log because HEAD moves.
///
/// Recorded as a branch creation when a local branch was created, so undo
/// removes it again rather than leaving it behind; as a plain switch otherwise.
pub(crate) fn checkout_remote_impl(state: &RepoState, name: String) -> Result<String, String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let before = session.repo.head_ref_name().ok();
    // Which local branches existed: the only way to tell afterwards whether
    // the one we land on is new. The sidebar's cached ref tree is free here.
    let existed: HashSet<String> = ensure_refs(session)?
        .branches
        .into_iter()
        .map(|b| b.name)
        .collect();
    let out = session.repo.checkout_remote(&name).map_err(to_message)?;
    let after = session.repo.head_ref_name().map_err(to_message)?;
    let Some(before) = before else { return Ok(out) };
    if !existed.contains(&after) {
        let at = session.repo.head_commit_id().map_err(to_message)?;
        set_undo(
            session,
            Undoable::BranchCreated {
                label: format!("Create branch {after}"),
                name: after,
                at,
                prev: before,
            },
        );
    } else if before != after {
        set_undo(
            session,
            Undoable::Switched {
                label: format!("Checkout {name}"),
                before,
                after,
            },
        );
    }
    Ok(out)
}

/// Create branch `name` from the current HEAD and check it out. Invalidates the
/// cached log because HEAD moves to the new branch.
fn create_branch_impl(state: &RepoState, name: String) -> Result<(), String> {
    with_recorded_branch_create(state, &name, None, |repo| {
        repo.create_branch(&name).map(|()| String::new())
    })
    .map(|_| ())
}

/// Create branch `name` at `rev` and check it out. Invalidates the cached log.
pub(crate) fn create_branch_at_impl(
    state: &RepoState,
    name: String,
    rev: String,
) -> Result<String, String> {
    with_recorded_branch_create(state, &name, Some(&rev), |repo| {
        repo.create_branch_at(&name, &rev)
    })
}

/// Rename branch `old` to `new`. Invalidates the cached log (HEAD's branch name
/// may change).
fn rename_branch_impl(state: &RepoState, old: String, new: String) -> Result<String, String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let out = session.repo.rename_branch(&old, &new).map_err(to_message)?;
    set_undo(
        session,
        Undoable::BranchRenamed {
            label: format!("Rename branch {old} → {new}"),
            old: old.clone(),
            new: new.clone(),
        },
    );
    Ok(out)
}

/// Rename branch `new`'s remote counterpart (run after the local rename).
fn rename_remote_branch_impl(state: &RepoState, new: String) -> Result<String, String> {
    with_repo_networked(
        state,
        "push",
        |repo| repo.rename_remote_branch(&new),
        |_| {},
    )
}

/// Create branch `name` at HEAD without checking it out (e.g. a rebase backup).
pub(crate) fn create_backup_branch_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_repo_clearing_undo(state, |repo| repo.create_branch_here(&name))
}

/// Delete branch `name` (force = `-D`). Doesn't move HEAD, so the log stays.
fn delete_branch_impl(state: &RepoState, name: String, force: bool) -> Result<String, String> {
    let label = format!("Delete branch {name}");
    delete_branches_recorded(state, &[name], force, label).map(|(out, _)| out)
}

/// Outcome of a bulk branch delete: git's output plus the branches that
/// resisted deletion, so the caller can name them rather than say "some failed".
#[derive(Serialize)]
pub(crate) struct DeleteBranchesResult {
    output: String,
    failed: Vec<String>,
}

/// Delete several branches as ONE undoable action.
///
/// Deleting them one call at a time would record one `BranchesDeleted` per
/// branch, and undo is single-level — so a Clean up that removed twenty
/// branches would bring back exactly one. Returns git's output and the names
/// that could not be deleted.
fn delete_branches_impl(
    state: &RepoState,
    names: Vec<String>,
    force: bool,
) -> Result<DeleteBranchesResult, String> {
    let n = names.len();
    let label = if n == 1 {
        format!("Delete branch {}", names[0])
    } else {
        format!("Delete {n} branches")
    };
    let (out, failed) = delete_branches_recorded(state, &names, force, label)?;
    Ok(DeleteBranchesResult {
        output: out,
        failed,
    })
}

/// Shared body: capture each branch's tip and upstream, delete them, and record
/// the whole set as a single undo entry.
///
/// A branch that fails to delete is reported rather than aborting the batch —
/// one protected branch shouldn't strand the other nineteen — and only the ones
/// that actually went are recorded, so undo restores exactly what was lost.
fn delete_branches_recorded(
    state: &RepoState,
    names: &[String],
    force: bool,
    label: String,
) -> Result<(String, Vec<String>), String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];

    let mut deleted: Vec<DeletedBranch> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    let mut outputs: Vec<String> = Vec::new();
    let mut first_error: Option<String> = None;

    for name in names {
        // Capture before deleting — afterwards there is nothing left to read.
        let oid = match session.repo.branch_commit_id(name) {
            Ok(oid) => oid,
            Err(e) => {
                first_error.get_or_insert_with(|| e.to_string());
                failed.push(name.clone());
                continue;
            }
        };
        let upstream = session.repo.branch_upstream(name).ok().flatten();
        match session.repo.delete_branch(name, force) {
            Ok(out) => {
                if !out.is_empty() {
                    outputs.push(out);
                }
                deleted.push(DeletedBranch {
                    name: name.clone(),
                    oid,
                    upstream,
                });
            }
            Err(e) => {
                first_error.get_or_insert_with(|| e.to_string());
                failed.push(name.clone());
            }
        }
    }

    // A single delete that failed is an error, as it always was. In a batch,
    // partial failure is reported through `failed` instead.
    if deleted.is_empty() {
        if let Some(e) = first_error {
            return Err(e);
        }
    }
    if !deleted.is_empty() {
        set_undo(
            session,
            Undoable::BranchesDeleted {
                label,
                branches: deleted,
            },
        );
    }
    Ok((outputs.join("\n"), failed))
}

fn delete_remote_branch_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_repo_networked(
        state,
        "push",
        |repo| repo.delete_remote_branch(&name),
        |_| {},
    )
}

fn remote_branch_exists_impl(state: &RepoState, name: String) -> Result<Option<String>, String> {
    with_repo(state, |repo| repo.remote_branch_exists(&name))
}

/// Merge `name` into the current branch as `mode` says. Invalidates the
/// cached log.
fn merge_branch_impl(state: &RepoState, name: String, mode: MergeMode) -> Result<String, String> {
    if let MergeMode::Squash = mode {
        // A squash moves no ref, only the index and working tree — under any
        // stored undo, which is therefore dropped, conflicts or not.
        let mut guard = state.workspace();
        let idx = guard.active.ok_or("no repository is open")?;
        let session = &mut guard.sessions[idx];
        let out = session.repo.merge_branch(&name, mode);
        clear_undo(session);
        return out.map_err(to_message);
    }
    with_recorded_head_move(
        state,
        &format!("Merge {name}"),
        HeadMoveMode::Keep,
        |repo| repo.merge_branch(&name, mode),
    )
}

/// The message a squash merge left for its commit, if one is pending.
fn squash_message_impl(state: &RepoState) -> Result<Option<String>, String> {
    with_repo(state, |repo| Ok(repo.squash_message()))
}

/// Fast-forward `name` to its upstream. Invalidates the cached log (it may be
/// the current branch).
fn fast_forward_branch_impl(state: &RepoState, name: String) -> Result<String, String> {
    // Recorded as a HEAD move when it is the current branch that advances;
    // undoing is then a plain reset back to the old tip.
    with_recorded_head_move(state, "Fast-forward", HeadMoveMode::Keep, |repo| {
        repo.fast_forward_branch(&name)
    })
}

/// Fast-forward `name` to `to` (a branch dropped on another in the graph).
/// Recorded like `fast_forward_branch`, as a HEAD move when it is the current
/// branch that advances.
fn fast_forward_branch_to_impl(
    state: &RepoState,
    name: String,
    to: String,
) -> Result<String, String> {
    with_recorded_head_move(state, "Fast-forward", HeadMoveMode::Keep, |repo| {
        repo.fast_forward_branch_to(&name, &to)
    })
}

/// Local branches whose upstream was deleted (see `Repo::gone_branches`) — the
/// candidates Quick Launch's Clean up offers to remove.
fn gone_branches_impl(state: &RepoState) -> Result<Vec<String>, String> {
    with_repo(state, Repo::gone_branches)
}

/// Set `branch`'s upstream. No commit change, so the log stays.
fn set_upstream_impl(
    state: &RepoState,
    branch: String,
    upstream: String,
) -> Result<String, String> {
    with_recorded_upstream(state, branch, "Set upstream".to_string(), |repo, b| {
        repo.set_upstream(b, &upstream)
    })
}

/// Clear `branch`'s upstream.
fn unset_upstream_impl(state: &RepoState, branch: String) -> Result<String, String> {
    with_recorded_upstream(state, branch, "Unset upstream".into(), |repo, b| {
        repo.unset_upstream(b)
    })
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn checkout_branch(name: String, state: State<RepoState>) -> Result<(), String> {
    checkout_branch_impl(&state, name)
}

#[tauri::command(async)]
pub(crate) fn checkout_remote(name: String, state: State<RepoState>) -> Result<String, String> {
    checkout_remote_impl(&state, name)
}

#[tauri::command(async)]
pub(crate) fn stash_and_switch(
    kind: String,
    target: String,
    state: State<RepoState>,
) -> Result<StashSwitch, String> {
    stash_and_switch_impl(&state, kind, target)
}

#[tauri::command(async)]
pub(crate) fn create_branch(name: String, state: State<RepoState>) -> Result<(), String> {
    create_branch_impl(&state, name)
}

#[tauri::command(async)]
pub(crate) fn create_branch_at(
    name: String,
    rev: String,
    state: State<RepoState>,
) -> Result<String, String> {
    create_branch_at_impl(&state, name, rev)
}

#[tauri::command(async)]
pub(crate) fn rename_branch(
    old: String,
    new: String,
    state: State<RepoState>,
) -> Result<String, String> {
    rename_branch_impl(&state, old, new)
}

#[tauri::command(async)]
pub(crate) fn rename_remote_branch(new: String, state: State<RepoState>) -> Result<String, String> {
    rename_remote_branch_impl(&state, new)
}

#[tauri::command(async)]
pub(crate) fn create_backup_branch(
    name: String,
    state: State<RepoState>,
) -> Result<String, String> {
    create_backup_branch_impl(&state, name)
}

#[tauri::command(async)]
pub(crate) fn delete_branch(
    name: String,
    force: bool,
    state: State<RepoState>,
) -> Result<String, String> {
    delete_branch_impl(&state, name, force)
}

#[tauri::command(async)]
pub(crate) fn delete_branches(
    names: Vec<String>,
    force: bool,
    state: State<RepoState>,
) -> Result<DeleteBranchesResult, String> {
    delete_branches_impl(&state, names, force)
}

#[tauri::command(async)]
pub(crate) fn delete_remote_branch(
    name: String,
    state: State<RepoState>,
) -> Result<String, String> {
    delete_remote_branch_impl(&state, name)
}

#[tauri::command(async)]
pub(crate) fn remote_branch_exists(
    name: String,
    state: State<RepoState>,
) -> Result<Option<String>, String> {
    remote_branch_exists_impl(&state, name)
}

#[tauri::command(async)]
pub(crate) fn merge_branch(
    name: String,
    mode: MergeMode,
    state: State<RepoState>,
) -> Result<String, String> {
    merge_branch_impl(&state, name, mode)
}

#[tauri::command(async)]
pub(crate) fn squash_message(state: State<RepoState>) -> Result<Option<String>, String> {
    squash_message_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn fast_forward_branch(name: String, state: State<RepoState>) -> Result<String, String> {
    fast_forward_branch_impl(&state, name)
}

#[tauri::command(async)]
pub(crate) fn fast_forward_branch_to(
    name: String,
    to: String,
    state: State<RepoState>,
) -> Result<String, String> {
    fast_forward_branch_to_impl(&state, name, to)
}

#[tauri::command(async)]
pub(crate) fn gone_branches(state: State<RepoState>) -> Result<Vec<String>, String> {
    gone_branches_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn set_upstream(
    branch: String,
    upstream: String,
    state: State<RepoState>,
) -> Result<String, String> {
    set_upstream_impl(&state, branch, upstream)
}

#[tauri::command(async)]
pub(crate) fn unset_upstream(branch: String, state: State<RepoState>) -> Result<String, String> {
    unset_upstream_impl(&state, branch)
}

#[cfg(test)]
mod tests {
    use super::delete_branches_impl;
    use crate::state::RepoState;
    use crate::test_support::{branch_names, git, head_branch, make_repo};
    use crate::undo::{undo_impl, undo_state_impl};
    use crate::workspace::open_repo_impl;
    use std::process::Command;

    // --- undoing a bulk delete ---------------------------------------------
    //
    // Undo is single-level. Clean up can remove dozens of branches at once, so
    // recording them one at a time would leave exactly one recoverable — the
    // more an action destroys, the worse that gets. These pin the batch being
    // one undoable unit.

    #[test]
    fn undo_restores_every_branch_a_bulk_delete_removed() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1", "c2", "c3"]);
        for name in ["gone-a", "gone-b", "gone-c"] {
            git(dir.path(), &["branch", name]);
        }
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        let before = branch_names(dir.path());
        let names = vec![
            "gone-a".to_string(),
            "gone-b".to_string(),
            "gone-c".to_string(),
        ];
        let result = delete_branches_impl(&state, names, true).expect("delete");
        assert!(result.failed.is_empty());
        for name in ["gone-a", "gone-b", "gone-c"] {
            assert!(
                !branch_names(dir.path()).contains(&name.to_string()),
                "{name} deleted"
            );
        }

        // The toolbar's Undo button is driven by this, so it has to be armed and
        // to name the whole batch — not just the last branch.
        let undo = undo_state_impl(&state).expect("undo state");
        assert_eq!(undo.undo.as_deref(), Some("Delete 3 branches"));

        undo_impl(&state).expect("undo");
        assert_eq!(
            branch_names(dir.path()),
            before,
            "all three come back, at their tips"
        );
    }

    #[test]
    fn undo_restores_a_force_deleted_branchs_unmerged_commits() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let head_branch_before = head_branch(dir.path());
        // Work that exists ONLY on this branch — the case where a mistaken
        // forced delete would otherwise be unrecoverable from the branch.
        git(dir.path(), &["checkout", "-q", "-b", "unmerged"]);
        std::fs::write(dir.path().join("only-here.txt"), "precious\n").unwrap();
        git(dir.path(), &["add", "only-here.txt"]);
        git(dir.path(), &["commit", "-q", "-m", "unpushed work"]);
        let base = head_branch_before.clone();
        let tip = String::from_utf8(
            Command::new("git")
                .current_dir(dir.path())
                .args(["rev-parse", "unmerged"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();
        git(dir.path(), &["checkout", "-q", &base]);

        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");
        delete_branches_impl(&state, vec!["unmerged".to_string()], true).expect("force delete");
        assert!(!branch_names(dir.path()).contains(&"unmerged".to_string()));

        undo_impl(&state).expect("undo");
        let restored = String::from_utf8(
            Command::new("git")
                .current_dir(dir.path())
                .args(["rev-parse", "unmerged"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        assert_eq!(
            restored.trim(),
            tip,
            "restored at exactly the commit it pointed at"
        );
    }

    #[test]
    fn a_branch_that_cannot_be_deleted_is_reported_and_the_rest_still_go() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        git(dir.path(), &["branch", "doomed"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        // The checked-out branch is one git refuses to delete; `doomed` should
        // still go. (Asking for the real name matters — a name that simply
        // doesn't exist would also land in `failed`, and the test would pass
        // without ever exercising a refusal.)
        let current = head_branch(dir.path());
        let result =
            delete_branches_impl(&state, vec![current.clone(), "doomed".to_string()], true)
                .expect("batch should not abort on one failure");
        assert_eq!(result.failed, vec![current.clone()]);
        assert!(
            branch_names(dir.path()).contains(&current),
            "and it survives"
        );
        assert!(!branch_names(dir.path()).contains(&"doomed".to_string()));

        // Undo restores only what actually went.
        undo_impl(&state).expect("undo");
        assert!(branch_names(dir.path()).contains(&"doomed".to_string()));
    }
}
