//! Tags: create, inspect, push, and delete (locally and on origin).

use gitp_core::{TagDetail, Undoable};
use tauri::State;

use crate::state::{to_message, with_repo, with_repo_networked, RepoState};
use crate::undo::set_undo;

/// Tag `rev` as `name`. HEAD doesn't move, so the log cache is left intact.
pub(crate) fn create_tag_at_impl(
    state: &RepoState,
    name: String,
    rev: String,
) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let out = session
        .repo
        .create_tag_at(&name, &rev)
        .map_err(to_message)?;
    // Read back what the ref actually holds, so redo can recreate it after undo
    // has removed it.
    let target = session.repo.tag_ref_target(&name).map_err(to_message)?;
    set_undo(
        session,
        Undoable::TagCreated {
            label: format!("Tag {name}"),
            name,
            target,
        },
    );
    Ok(out)
}

/// Read tag `name`'s metadata for the tag details dialog. Read-only.
fn tag_detail_impl(state: &RepoState, name: String) -> Result<TagDetail, String> {
    with_repo(state, |repo| repo.tag_detail(&name))
}

/// Push tag `name` to origin. Nothing local changes.
fn push_tag_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_repo_networked(state, "push", |repo| repo.push_tag(&name), |_| {})
}

/// Delete the local tag `name`. HEAD doesn't move and no commit is lost (the
/// tagged commit stays reachable from whatever else points at it), so the log
/// cache stays valid.
pub(crate) fn delete_tag_impl(state: &RepoState, name: String) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    // Captured before the delete: afterwards the ref is gone and with it any way
    // to tell which tag object it named.
    let target = session.repo.tag_ref_target(&name).map_err(to_message)?;
    let out = session.repo.delete_tag(&name).map_err(to_message)?;
    set_undo(
        session,
        Undoable::TagDeleted {
            label: format!("Delete tag {name}"),
            name,
            target,
        },
    );
    Ok(out)
}

/// Delete tag `name` on origin.
fn delete_remote_tag_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_repo_networked(state, "push", |repo| repo.delete_remote_tag(&name), |_| {})
}

/// Whether origin has a tag called `name` (live `git ls-remote` probe).
fn remote_tag_exists_impl(state: &RepoState, name: String) -> Result<bool, String> {
    with_repo(state, |repo| repo.remote_tag_exists(&name))
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn create_tag_at(
    name: String,
    rev: String,
    state: State<RepoState>,
) -> Result<String, String> {
    create_tag_at_impl(&state, name, rev)
}

#[tauri::command(async)]
pub(crate) fn tag_detail(name: String, state: State<RepoState>) -> Result<TagDetail, String> {
    tag_detail_impl(&state, name)
}

#[tauri::command(async)]
pub(crate) fn push_tag(name: String, state: State<RepoState>) -> Result<String, String> {
    push_tag_impl(&state, name)
}

#[tauri::command(async)]
pub(crate) fn delete_tag(name: String, state: State<RepoState>) -> Result<String, String> {
    delete_tag_impl(&state, name)
}

#[tauri::command(async)]
pub(crate) fn delete_remote_tag(name: String, state: State<RepoState>) -> Result<String, String> {
    delete_remote_tag_impl(&state, name)
}

#[tauri::command(async)]
pub(crate) fn remote_tag_exists(name: String, state: State<RepoState>) -> Result<bool, String> {
    remote_tag_exists_impl(&state, name)
}
