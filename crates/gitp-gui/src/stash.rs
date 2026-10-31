//! The stash: push (all or some files), pop / apply, drop, rename, and save
//! as a patch.

use gitp_core::{Repo, Undoable};
use tauri::State;

use crate::state::{invalidate_status, to_message, with_repo, RepoState};
use crate::undo::{clear_undo, set_undo};

/// `git stash push` the active repo's local changes, with the Stash dialog's
/// options (a blank message counts as none). Returns git's output. Recorded
/// so undo pops the entry back (see `record_stash_push`).
pub(crate) fn stash_impl(
    state: &RepoState,
    message: Option<String>,
    staged: bool,
    include_untracked: bool,
) -> Result<String, String> {
    let message = message.as_deref().map(str::trim).filter(|m| !m.is_empty());
    record_stash_push(
        state,
        "Stash",
        message.map(str::to_string),
        staged,
        include_untracked,
        Vec::new(),
        |repo| repo.stash_push(message, staged, include_untracked),
    )
}

/// Run a `git stash push` and record it as a `StashSaved`, with the status
/// fingerprints that let undo and redo check the tree is as they left it. A
/// push that saved nothing ("No local changes to save") records nothing.
fn record_stash_push(
    state: &RepoState,
    label: &str,
    message: Option<String>,
    staged: bool,
    include_untracked: bool,
    paths: Vec<String>,
    f: impl FnOnce(&Repo) -> gitp_core::Result<String>,
) -> Result<String, String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let top_before = session.repo.stash_commit_id(0).ok();
    let status_before = session.repo.status_fingerprint();
    let out = f(&session.repo);
    invalidate_status(session);
    let out = out.map_err(to_message)?;
    let top_after = session.repo.stash_commit_id(0).ok();
    match (top_after, status_before, session.repo.status_fingerprint()) {
        (Some(oid), Some(status_before), Some(status_after))
            if Some(&oid) != top_before.as_ref() =>
        {
            set_undo(
                session,
                Undoable::StashSaved {
                    label: label.into(),
                    oid,
                    message,
                    staged,
                    include_untracked,
                    paths,
                    status_before,
                    status_after,
                },
            );
        }
        // Nothing was stashed, so nothing changed under the stored action.
        _ => {}
    }
    Ok(out)
}

/// `git stash pop` on the active repo. Returns git's output.
pub(crate) fn stash_pop_impl(state: &RepoState) -> Result<String, String> {
    record_stash_apply(state, 0, true)
}

/// Apply stash `index`. `drop` pops (apply + remove) instead of leaving it.
pub(crate) fn stash_apply_impl(
    state: &RepoState,
    index: usize,
    drop: bool,
) -> Result<String, String> {
    record_stash_apply(state, index, drop)
}

/// Apply or pop stash `index`, recording it when the working tree was clean
/// — then "undo" has one meaning: stash everything again. Onto a tree with
/// changes of its own the apply mixes in, and the slot is cleared instead.
fn record_stash_apply(state: &RepoState, index: usize, drop: bool) -> Result<String, String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let oid = session.repo.stash_commit_id(index).ok();
    let clean = session.repo.status_fingerprint().as_deref() == Some("");
    let out = session.repo.stash_apply(index, drop);
    invalidate_status(session);
    let out = out.map_err(|e| {
        clear_undo(session); // a conflicted apply has changed the tree part-way
        to_message(e)
    })?;
    match (oid, clean, session.repo.status_fingerprint()) {
        (Some(oid), true, Some(status_after)) => {
            let message = session
                .repo
                .stash_reflog_message(&oid)
                .or_else(|| {
                    // Popped: the entry is gone from the reflog, but `stash pop`
                    // names it in its output ("Dropped refs/stash@{0} (<id>)")
                    // only by id — the commit's subject is the same text.
                    session.repo.stash_message_of(&oid).ok()
                })
                .as_deref()
                .and_then(Repo::stash_user_message);
            set_undo(
                session,
                Undoable::StashApplied {
                    label: if drop { "Pop stash" } else { "Apply stash" }.into(),
                    oid,
                    message,
                    dropped: drop,
                    status_after,
                },
            );
        }
        _ => clear_undo(session),
    }
    Ok(out)
}

/// Drop stash `index` from the stack.
fn stash_drop_impl(state: &RepoState, index: usize) -> Result<String, String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    // The entry's commit and message, before dropping loses the reference to
    // them. The commit itself survives until gc, which is what makes this
    // recoverable at all.
    let oid = session.repo.stash_commit_id(index).map_err(to_message)?;
    let message = session
        .repo
        .stash_message(index)
        .unwrap_or_else(|_| format!("stash@{{{index}}}"));
    let out = session.repo.stash_drop(index).map_err(to_message)?;
    set_undo(
        session,
        Undoable::StashDropped {
            label: "Drop stash".into(),
            oid,
            message,
        },
    );
    Ok(out)
}

/// Re-message stash `index`. Recorded with both texts, so undo puts the old
/// one back exactly.
pub(crate) fn stash_rename_impl(
    state: &RepoState,
    index: usize,
    message: String,
) -> Result<String, String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let oid = session.repo.stash_commit_id(index).map_err(to_message)?;
    let before = session.repo.stash_reflog_message(&oid);
    let out = session
        .repo
        .stash_rename(index, &message)
        .map_err(to_message)?;
    match before {
        Some(before) => set_undo(
            session,
            Undoable::StashRenamed {
                label: "Rename stash".into(),
                oid,
                before,
                after: message,
            },
        ),
        None => clear_undo(session),
    }
    Ok(out)
}

/// Write stash `index`'s diff to `path` as a patch file.
fn save_stash_patch_impl(state: &RepoState, index: usize, path: String) -> Result<String, String> {
    with_repo(state, |repo| repo.save_stash_patch(index, path.as_ref()))
}

/// Stash only `paths` away (`git stash push -u -- <paths>`).
pub(crate) fn stash_files_impl(state: &RepoState, paths: Vec<String>) -> Result<String, String> {
    let n = paths.len();
    let label = format!("Stash {n} file{}", if n == 1 { "" } else { "s" });
    record_stash_push(state, &label, None, false, true, paths.clone(), |repo| {
        repo.stash_files(&paths)
    })
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn stash(
    message: Option<String>,
    staged: bool,
    include_untracked: bool,
    state: State<RepoState>,
) -> Result<String, String> {
    stash_impl(&state, message, staged, include_untracked)
}

#[tauri::command(async)]
pub(crate) fn stash_pop(state: State<RepoState>) -> Result<String, String> {
    stash_pop_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn stash_apply(
    index: usize,
    drop: bool,
    state: State<RepoState>,
) -> Result<String, String> {
    stash_apply_impl(&state, index, drop)
}

#[tauri::command(async)]
pub(crate) fn stash_drop(index: usize, state: State<RepoState>) -> Result<String, String> {
    stash_drop_impl(&state, index)
}

#[tauri::command(async)]
pub(crate) fn stash_rename(
    index: usize,
    message: String,
    state: State<RepoState>,
) -> Result<String, String> {
    stash_rename_impl(&state, index, message)
}

#[tauri::command(async)]
pub(crate) fn save_stash_patch(
    index: usize,
    path: String,
    state: State<RepoState>,
) -> Result<String, String> {
    save_stash_patch_impl(&state, index, path)
}

#[tauri::command(async)]
pub(crate) fn stash_files(paths: Vec<String>, state: State<RepoState>) -> Result<String, String> {
    stash_files_impl(&state, paths)
}
