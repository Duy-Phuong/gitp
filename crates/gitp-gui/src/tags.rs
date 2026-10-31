//! Tags: create, annotate, inspect, push, and delete (locally and on a remote).

use gitp_core::{TagDetail, Undoable};
use tauri::State;

use crate::state::{to_message, with_repo, with_repo_networked, RepoState};
use crate::undo::set_undo;

/// Tag `rev` as `name`: annotated when there is a `message`, lightweight when
/// there isn't. HEAD doesn't move, so the log cache is left intact.
pub(crate) fn create_tag_at_impl(
    state: &RepoState,
    name: String,
    rev: String,
    message: Option<String>,
) -> Result<String, String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let out = match message.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        Some(message) => session.repo.create_annotated_tag_at(&name, &rev, message),
        None => session.repo.create_tag_at(&name, &rev),
    }
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

/// Recreate lightweight tag `name` as an annotated one. Not recorded for undo:
/// no undo action moves a tag in place, and an armed one about this tag (its
/// creation, say) stops being offered on its own once the ref has changed.
fn annotate_tag_impl(state: &RepoState, name: String, message: String) -> Result<String, String> {
    with_repo(state, |repo| repo.annotate_tag(&name, &message))
}

/// Read tag `name`'s metadata for the tag details dialog. Read-only.
fn tag_detail_impl(state: &RepoState, name: String) -> Result<TagDetail, String> {
    with_repo(state, |repo| repo.tag_detail(&name))
}

/// Push tag `name` to `remote`. Nothing local changes.
fn push_tag_impl(state: &RepoState, name: String, remote: String) -> Result<String, String> {
    with_repo_networked(state, "push", |repo| repo.push_tag(&name, &remote), |_| {})
}

/// Delete the local tag `name`. HEAD doesn't move and no commit is lost (the
/// tagged commit stays reachable from whatever else points at it), so the log
/// cache stays valid.
pub(crate) fn delete_tag_impl(state: &RepoState, name: String) -> Result<String, String> {
    let mut guard = state.workspace();
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

/// Delete tag `name` on `remote`.
fn delete_remote_tag_impl(
    state: &RepoState,
    name: String,
    remote: String,
) -> Result<String, String> {
    with_repo_networked(
        state,
        "push",
        |repo| repo.delete_remote_tag(&name, &remote),
        |_| {},
    )
}

/// Whether `remote` has a tag called `name` (live `git ls-remote` probe).
fn remote_tag_exists_impl(state: &RepoState, name: String, remote: String) -> Result<bool, String> {
    with_repo(state, |repo| repo.remote_tag_exists(&name, &remote))
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn create_tag_at(
    name: String,
    rev: String,
    message: Option<String>,
    state: State<RepoState>,
) -> Result<String, String> {
    create_tag_at_impl(&state, name, rev, message)
}

#[tauri::command(async)]
pub(crate) fn annotate_tag(
    name: String,
    message: String,
    state: State<RepoState>,
) -> Result<String, String> {
    annotate_tag_impl(&state, name, message)
}

#[tauri::command(async)]
pub(crate) fn tag_detail(name: String, state: State<RepoState>) -> Result<TagDetail, String> {
    tag_detail_impl(&state, name)
}

#[tauri::command(async)]
pub(crate) fn push_tag(
    name: String,
    remote: String,
    state: State<RepoState>,
) -> Result<String, String> {
    push_tag_impl(&state, name, remote)
}

#[tauri::command(async)]
pub(crate) fn delete_tag(name: String, state: State<RepoState>) -> Result<String, String> {
    delete_tag_impl(&state, name)
}

#[tauri::command(async)]
pub(crate) fn delete_remote_tag(
    name: String,
    remote: String,
    state: State<RepoState>,
) -> Result<String, String> {
    delete_remote_tag_impl(&state, name, remote)
}

#[tauri::command(async)]
pub(crate) fn remote_tag_exists(
    name: String,
    remote: String,
    state: State<RepoState>,
) -> Result<bool, String> {
    remote_tag_exists_impl(&state, name, remote)
}
