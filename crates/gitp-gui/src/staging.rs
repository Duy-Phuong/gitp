//! Local changes: status and diffs of the working tree, staging (whole files,
//! single hunks or selected lines), committing, discarding, and per-file
//! patch / ignore.

use gitp_core::{FileDiff, Repo, SigningConfig, StatusLists};
use tauri::State;

use crate::state::{ensure_status, to_message, with_repo, with_repo_clearing_undo, RepoState};
use crate::undo::{
    with_recorded_discard, with_recorded_files, with_recorded_head_move, with_recorded_index,
};

fn get_working_changes_impl(state: &RepoState) -> Result<Vec<FileDiff>, String> {
    with_repo(state, Repo::working_changes)
}

fn get_status_impl(state: &RepoState) -> Result<StatusLists, String> {
    with_repo(state, Repo::status_lists)
}

fn get_status_summary_impl(state: &RepoState) -> Result<StatusLists, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    ensure_status(&mut guard.sessions[idx])
}

fn get_file_diff_impl(
    state: &RepoState,
    path: String,
    staged: bool,
    context_lines: u32,
    ignore_whitespace: bool,
    full: bool,
) -> Result<Option<FileDiff>, String> {
    with_repo(state, |repo| {
        repo.file_diff_with(
            &path,
            staged,
            context_lines,
            ignore_whitespace,
            diff_cap(full),
        )
    })
}

/// The line cap for a diff the viewer asked for: none once it has asked to
/// see the whole thing, `MAX_DIFF_LINES` otherwise.
pub(crate) fn diff_cap(full: bool) -> Option<usize> {
    (!full).then_some(gitp_core::MAX_DIFF_LINES)
}

pub(crate) fn stage_impl(state: &RepoState, path: String) -> Result<(), String> {
    with_recorded_index(state, "Stage", |repo| repo.stage(&path))
}

pub(crate) fn unstage_impl(state: &RepoState, path: String) -> Result<(), String> {
    with_recorded_index(state, "Unstage", |repo| repo.unstage(&path))
}

// The hunk ops take the context the diff was shown with, so `hunk_index`
// names the same block the user clicked (see gitp-core's hunk.rs).
fn stage_hunk_impl(
    state: &RepoState,
    path: String,
    hunk_index: usize,
    context_lines: u32,
) -> Result<(), String> {
    with_recorded_index(state, "Stage block", |repo| {
        repo.stage_hunk(&path, hunk_index, context_lines)
    })
}

fn unstage_hunk_impl(
    state: &RepoState,
    path: String,
    hunk_index: usize,
    context_lines: u32,
) -> Result<(), String> {
    with_recorded_index(state, "Unstage block", |repo| {
        repo.unstage_hunk(&path, hunk_index, context_lines)
    })
}

fn discard_hunk_impl(
    state: &RepoState,
    path: String,
    hunk_index: usize,
    context_lines: u32,
) -> Result<(), String> {
    // Snapshot the whole file so undo restores the discarded hunk exactly.
    let paths = [path.clone()];
    with_recorded_discard(state, &paths, |repo| {
        repo.discard_hunk(&path, hunk_index, context_lines)
    })
}

// The line ops name each selected line as (block index, line index within the
// block), at the context the diff was shown with — see gitp-core's
// line_staging.rs.
pub(crate) fn stage_lines_impl(
    state: &RepoState,
    path: String,
    lines: Vec<(usize, usize)>,
    context_lines: u32,
) -> Result<(), String> {
    with_recorded_index(state, "Stage lines", |repo| {
        repo.stage_lines(&path, &lines, context_lines)
    })
}

pub(crate) fn unstage_lines_impl(
    state: &RepoState,
    path: String,
    lines: Vec<(usize, usize)>,
    context_lines: u32,
) -> Result<(), String> {
    with_recorded_index(state, "Unstage lines", |repo| {
        repo.unstage_lines(&path, &lines, context_lines)
    })
}

pub(crate) fn discard_lines_impl(
    state: &RepoState,
    path: String,
    lines: Vec<(usize, usize)>,
    context_lines: u32,
) -> Result<(), String> {
    // Snapshot the whole file so undo restores the discarded lines exactly.
    let paths = [path.clone()];
    with_recorded_discard(state, &paths, |repo| {
        repo.discard_lines(&path, &lines, context_lines)
    })
}

pub(crate) fn stage_all_impl(state: &RepoState) -> Result<(), String> {
    with_recorded_index(state, "Stage all", Repo::stage_all)
}

fn unstage_all_impl(state: &RepoState) -> Result<(), String> {
    with_recorded_index(state, "Unstage all", Repo::unstage_all)
}

/// Commit the staged changes. Invalidates the cached log because HEAD moves.
/// `sign` is the commit box's Sign toggle; `None` leaves it to git's config.
/// `no_verify` is its Skip hooks toggle.
pub(crate) fn commit_changes_impl(
    state: &RepoState,
    subject: String,
    body: String,
    amend: bool,
    sign: Option<bool>,
    no_verify: bool,
) -> Result<String, String> {
    // Recorded soft: undo moves the tip back but keeps the committed changes
    // staged, so a mistaken commit can be reworked rather than lost.
    let label = if amend { "Amend commit" } else { "Commit" };
    with_recorded_head_move(state, label, true, |repo| {
        repo.commit(&subject, &body, amend, sign, no_verify)
    })
}

/// Whether commits can be signed here and whether they are by default — the
/// starting state of the commit box's Sign toggle.
fn get_signing_config_impl(state: &RepoState) -> Result<SigningConfig, String> {
    with_repo(state, Repo::signing_config)
}

/// The raw text of the configured `commit.template`, for pre-filling an empty
/// commit box; `None` when no template is set.
fn get_commit_template_impl(state: &RepoState) -> Result<Option<String>, String> {
    with_repo(state, Repo::commit_template)
}

/// Discard all local changes to `paths` (revert to HEAD; delete new files).
pub(crate) fn discard_files_impl(state: &RepoState, paths: Vec<String>) -> Result<(), String> {
    with_recorded_discard(state, &paths, |repo| repo.discard_files(&paths))
}

/// Restore `paths` as they are in commit `rev` (staged), undoable like a
/// discard.
pub(crate) fn restore_files_from_commit_impl(
    state: &RepoState,
    rev: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let n = paths.len();
    let short = rev.get(..7).unwrap_or(&rev);
    let label = format!(
        "Restore {n} file{} from {short}",
        if n == 1 { "" } else { "s" }
    );
    with_recorded_files(state, label, &paths, |repo| {
        repo.restore_files_from(&rev, &paths)
    })
}

/// Undo one block of commit `rev`'s change to `path` in the working tree,
/// recorded like a discard of that file so Undo restores it exactly.
fn revert_commit_hunk_impl(
    state: &RepoState,
    rev: String,
    path: String,
    old_path: Option<String>,
    hunk_index: usize,
    context_lines: u32,
) -> Result<(), String> {
    let paths = [path.clone()];
    with_recorded_files(state, format!("Revert block of {path}"), &paths, |repo| {
        repo.revert_commit_hunk(&rev, &path, old_path.as_deref(), hunk_index, context_lines)
    })
}

/// Write a patch of `paths` (staged or working-tree direction) to `dest`.
fn save_files_patch_impl(
    state: &RepoState,
    paths: Vec<String>,
    staged: bool,
    dest: String,
) -> Result<String, String> {
    with_repo(state, |repo| {
        repo.save_files_patch(&paths, staged, dest.as_ref())
    })
}

/// Apply the patch file at `path` (`git apply --3way`) to the working tree and
/// index.
fn apply_patch_impl(state: &RepoState, path: String) -> Result<(), String> {
    with_repo_clearing_undo(state, |repo| repo.apply_patch(path.as_ref()))
}

/// Append `paths` to the repo's `.gitignore`; returns the number added.
fn add_to_gitignore_impl(state: &RepoState, paths: Vec<String>) -> Result<usize, String> {
    with_repo_clearing_undo(state, |repo| repo.add_to_gitignore(&paths))
}

/// Stop tracking `paths`, keeping the files (the second half of "Ignore and
/// Stop Tracking").
fn untrack_files_impl(state: &RepoState, paths: Vec<String>) -> Result<(), String> {
    with_repo_clearing_undo(state, |repo| repo.untrack_files(&paths))
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn get_working_changes(state: State<RepoState>) -> Result<Vec<FileDiff>, String> {
    get_working_changes_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn get_status(state: State<RepoState>) -> Result<StatusLists, String> {
    get_status_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn get_status_summary(state: State<RepoState>) -> Result<StatusLists, String> {
    get_status_summary_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn get_file_diff(
    path: String,
    staged: bool,
    context_lines: u32,
    ignore_whitespace: bool,
    full: bool,
    state: State<RepoState>,
) -> Result<Option<FileDiff>, String> {
    get_file_diff_impl(&state, path, staged, context_lines, ignore_whitespace, full)
}

#[tauri::command(async)]
pub(crate) fn stage(path: String, state: State<RepoState>) -> Result<(), String> {
    stage_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn unstage(path: String, state: State<RepoState>) -> Result<(), String> {
    unstage_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn stage_hunk(
    path: String,
    hunk_index: usize,
    context_lines: u32,
    state: State<RepoState>,
) -> Result<(), String> {
    stage_hunk_impl(&state, path, hunk_index, context_lines)
}

#[tauri::command(async)]
pub(crate) fn unstage_hunk(
    path: String,
    hunk_index: usize,
    context_lines: u32,
    state: State<RepoState>,
) -> Result<(), String> {
    unstage_hunk_impl(&state, path, hunk_index, context_lines)
}

#[tauri::command(async)]
pub(crate) fn discard_hunk(
    path: String,
    hunk_index: usize,
    context_lines: u32,
    state: State<RepoState>,
) -> Result<(), String> {
    discard_hunk_impl(&state, path, hunk_index, context_lines)
}

#[tauri::command(async)]
pub(crate) fn stage_lines(
    path: String,
    lines: Vec<(usize, usize)>,
    context_lines: u32,
    state: State<RepoState>,
) -> Result<(), String> {
    stage_lines_impl(&state, path, lines, context_lines)
}

#[tauri::command(async)]
pub(crate) fn unstage_lines(
    path: String,
    lines: Vec<(usize, usize)>,
    context_lines: u32,
    state: State<RepoState>,
) -> Result<(), String> {
    unstage_lines_impl(&state, path, lines, context_lines)
}

#[tauri::command(async)]
pub(crate) fn discard_lines(
    path: String,
    lines: Vec<(usize, usize)>,
    context_lines: u32,
    state: State<RepoState>,
) -> Result<(), String> {
    discard_lines_impl(&state, path, lines, context_lines)
}

#[tauri::command(async)]
pub(crate) fn stage_all(state: State<RepoState>) -> Result<(), String> {
    stage_all_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn unstage_all(state: State<RepoState>) -> Result<(), String> {
    unstage_all_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn commit_changes(
    subject: String,
    body: String,
    amend: bool,
    sign: Option<bool>,
    no_verify: bool,
    state: State<RepoState>,
) -> Result<String, String> {
    commit_changes_impl(&state, subject, body, amend, sign, no_verify)
}

#[tauri::command(async)]
pub(crate) fn get_signing_config(state: State<RepoState>) -> Result<SigningConfig, String> {
    get_signing_config_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn get_commit_template(state: State<RepoState>) -> Result<Option<String>, String> {
    get_commit_template_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn discard_files(paths: Vec<String>, state: State<RepoState>) -> Result<(), String> {
    discard_files_impl(&state, paths)
}

#[tauri::command(async)]
pub(crate) fn restore_files_from_commit(
    rev: String,
    paths: Vec<String>,
    state: State<RepoState>,
) -> Result<(), String> {
    restore_files_from_commit_impl(&state, rev, paths)
}

#[tauri::command(async)]
pub(crate) fn revert_commit_hunk(
    rev: String,
    path: String,
    old_path: Option<String>,
    hunk_index: usize,
    context_lines: u32,
    state: State<RepoState>,
) -> Result<(), String> {
    revert_commit_hunk_impl(&state, rev, path, old_path, hunk_index, context_lines)
}

#[tauri::command(async)]
pub(crate) fn save_files_patch(
    paths: Vec<String>,
    staged: bool,
    path: String,
    state: State<RepoState>,
) -> Result<String, String> {
    save_files_patch_impl(&state, paths, staged, path)
}

#[tauri::command(async)]
pub(crate) fn apply_patch(path: String, state: State<RepoState>) -> Result<(), String> {
    apply_patch_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn add_to_gitignore(
    paths: Vec<String>,
    state: State<RepoState>,
) -> Result<usize, String> {
    add_to_gitignore_impl(&state, paths)
}

#[tauri::command(async)]
pub(crate) fn untrack_files(paths: Vec<String>, state: State<RepoState>) -> Result<(), String> {
    untrack_files_impl(&state, paths)
}
