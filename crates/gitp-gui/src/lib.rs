//! gitp desktop backend. Thin Tauri adapter over `gitp-core`, plus an embedded
//! PTY terminal. All git logic lives in `gitp-core`; this crate only translates
//! IPC calls and streams the terminal.
//!
//! Each command delegates to a plain `*_impl` function that takes `&RepoState`,
//! so the open→log→detail flow (including repo switching) is unit-testable
//! without a Tauri runtime.

pub mod terminal;

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

use gitp_core::{
    BlameLine, CommitDetail, CommitRow, ConfigEntry, ConfigScope, ConflictSides, ConflictStatus,
    DeletedBranch, FileBlob, FileCommit, FileDiff, LogOptions, PullMode, RebaseCommit,
    RebaseStatus, RebaseStep,
    Refs, Repo, ResetMode, StatusLists, TagDetail, Undoable,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use terminal::TerminalState;

/// An open repository plus its lazily-computed, cached reads. The log is
/// computed once (the expensive walk) so pages can be served cheaply and with
/// globally-consistent graph lanes; `refs` is cached alongside it.
///
/// Both caches are keyed on `Repo::state_fingerprint` — a ~4ms hash of every
/// ref, HEAD, and the HEAD reflog — rather than being invalidated by hand at
/// each mutation site. That's one check that can't be forgotten instead of a
/// dozen that can, and it's strictly more precise: a pull or fetch that turns
/// out to bring nothing new leaves the fingerprint alone, so it no longer
/// triggers a ~200ms re-walk of the whole history for no change.
struct Session {
    path: String,
    name: String,
    repo: Repo,
    log: Option<Vec<CommitRow>>,
    /// Which mode the cached `log` was built in (all branches vs HEAD only), so
    /// a toggle change recomputes it.
    log_all: bool,
    /// Fingerprint the cached `log` was built at.
    log_sig: u64,
    /// The sidebar's ref tree, with the fingerprint it was built at.
    refs_cache: Option<(u64, Refs)>,
    /// The last `git status` result, with the `.git/index` stamp it was taken
    /// at. Valid while the watcher is quiet *and* that stamp still holds.
    status_cache: Option<(Option<(u64, std::time::SystemTime)>, StatusLists)>,
    /// Raised by the filesystem watcher on any change under the working tree.
    /// `None` means no watcher could be started — then nothing is cached.
    worktree_dirty: Option<Arc<AtomicBool>>,
    /// Held only to keep the watcher alive for as long as the session is open.
    _watcher: Option<RecommendedWatcher>,
    /// The single most-recent reversible action (GitKraken-style single-level
    /// undo), and the action just undone that Redo would re-apply.
    undo: Option<Undoable>,
    redo: Option<Undoable>,
}

/// All open repositories plus which one is active. Commands that read a repo
/// (log, detail, config) operate on the active session.
#[derive(Default)]
struct Workspace {
    sessions: Vec<Session>,
    active: Option<usize>,
}

impl Workspace {
    fn view(&self) -> WorkspaceView {
        WorkspaceView {
            repos: self
                .sessions
                .iter()
                .map(|s| RepoTab {
                    path: s.path.clone(),
                    name: s.name.clone(),
                })
                .collect(),
            active: self.active,
        }
    }
}

/// The set of open repositories (a workspace of tabs).
#[derive(Default)]
pub struct RepoState(Mutex<Workspace>);

/// One open repository as shown in the tab bar.
#[derive(Serialize, Clone)]
pub struct RepoTab {
    path: String,
    name: String,
}

/// The open repos and the active index — the frontend renders its tab bar from this.
#[derive(Serialize)]
pub struct WorkspaceView {
    repos: Vec<RepoTab>,
    active: Option<usize>,
}

/// Outcome of a bulk branch delete: git's output plus the branches that
/// resisted deletion, so the caller can name them rather than say "some failed".
#[derive(Serialize)]
pub struct DeleteBranchesResult {
    output: String,
    failed: Vec<String>,
}

/// A page of log rows plus the total count, so the frontend knows when to stop.
#[derive(Serialize)]
pub struct LogPage {
    rows: Vec<CommitRow>,
    total: usize,
}

/// Everything the frontend refreshes after any action, in one round trip.
///
/// These five used to be five separate commands, each taking the global lock
/// and each a separate IPC hop. Worse, the sidebar's change count and the
/// staging area's file lists both ran `git status` — the single most expensive
/// read on a large repo — so it ran twice per action. Here it runs once and
/// the count is derived from the same lists.
#[derive(Serialize)]
pub struct WorkspaceSnapshot {
    refs: Refs,
    /// Distinct changed paths, for the sidebar badge (derived from `status`).
    local_changes: usize,
    /// The staging area (summaries only, no hunks) — also feeds Local Changes.
    status: StatusLists,
    rebase: RebaseStatus,
    conflict: ConflictStatus,
    undo: UndoView,
}

/// Watch everything under `dir` (the working tree, `.git` included) and raise a
/// flag on any change, so `ensure_status` knows when a rescan is warranted.
///
/// Returns `(None, None)` if a watcher can't be started — an unreadable
/// directory, or the platform's watch limits being exhausted on a huge tree.
/// That's not an error worth failing the open over: the caller simply doesn't
/// cache, and behaviour falls back to scanning every time.
fn watch_worktree(dir: &Path) -> (Option<Arc<AtomicBool>>, Option<RecommendedWatcher>) {
    let flag = Arc::new(AtomicBool::new(true));
    let signal = Arc::clone(&flag);
    // Any event at all means "rescan"; we deliberately don't inspect paths or
    // kinds. Working out whether a given write could affect `git status` is
    // exactly the work `git status` does, so filtering here would cost more
    // than it saves and risks missing a change.
    let handler = move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            signal.store(true, Ordering::SeqCst);
        }
    };
    let mut watcher = match notify::recommended_watcher(handler) {
        Ok(w) => w,
        Err(_) => return (None, None),
    };
    match watcher.watch(dir, RecursiveMode::Recursive) {
        Ok(()) => (Some(flag), Some(watcher)),
        Err(_) => (None, None),
    }
}

fn to_message<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

/// A tab label like `mideal (Documents)`: the repo folder plus its parent.
fn display_name(path: &str) -> String {
    let p = Path::new(path);
    let base = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string();
    match p.parent().and_then(Path::file_name).and_then(|s| s.to_str()) {
        Some(parent) if !parent.is_empty() => format!("{base} ({parent})"),
        _ => base,
    }
}

/// Run `f` against the active repo, or return an error string if none is open.
fn with_repo<T>(
    state: &RepoState,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
) -> Result<T, String> {
    let guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    f(&guard.sessions[idx].repo).map_err(to_message)
}

// --- Command logic (runtime-agnostic, unit-testable) -----------------------

/// Open `path` as a new tab (or switch to it if already open) and make it active.
fn open_repo_impl(state: &RepoState, path: String) -> Result<WorkspaceView, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    if let Some(i) = guard.sessions.iter().position(|s| s.path == path) {
        guard.active = Some(i);
        return Ok(guard.view());
    }
    let repo = Repo::open(&path).map_err(to_message)?;
    let name = display_name(&path);
    let (dirty, watcher) = watch_worktree(repo.workdir());
    guard.sessions.push(Session {
        path,
        name,
        repo,
        log: None,
        log_all: false,
        log_sig: 0,
        refs_cache: None,
        status_cache: None,
        worktree_dirty: dirty,
        _watcher: watcher,
        undo: None,
        redo: None,
    });
    guard.active = Some(guard.sessions.len() - 1);
    Ok(guard.view())
}

fn list_repos_impl(state: &RepoState) -> Result<WorkspaceView, String> {
    Ok(state.0.lock().map_err(to_message)?.view())
}

/// Switch the active tab to the open repo at `path`.
fn activate_repo_impl(state: &RepoState, path: String) -> Result<WorkspaceView, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let i = guard
        .sessions
        .iter()
        .position(|s| s.path == path)
        .ok_or("repository is not open")?;
    guard.active = Some(i);
    Ok(guard.view())
}

/// Close the tab for `path`, keeping the active selection sensible.
fn close_repo_impl(state: &RepoState, path: String) -> Result<WorkspaceView, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let i = guard
        .sessions
        .iter()
        .position(|s| s.path == path)
        .ok_or("repository is not open")?;
    guard.sessions.remove(i);
    guard.active = match guard.active {
        _ if guard.sessions.is_empty() => None,
        Some(a) if i < a => Some(a - 1),
        Some(a) => Some(a.min(guard.sessions.len() - 1)),
        None => None,
    };
    Ok(guard.view())
}

/// Return the `[offset, offset+limit)` slice of the active repo's log, computing
/// and caching the full log on first use so lanes are consistent across pages.
fn get_log_page_impl(
    state: &RepoState,
    offset: usize,
    limit: usize,
    all_branches: bool,
) -> Result<LogPage, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let log = ensure_log(session, all_branches)?;
    let total = log.len();
    let end = offset.saturating_add(limit).min(total);
    let rows = log.get(offset..end).map(<[_]>::to_vec).unwrap_or_default();
    Ok(LogPage { rows, total })
}

/// A cheap stand-in for "has history changed?", for callers that would
/// otherwise pull a whole page just to compare it.
///
/// This is the same fingerprint `ensure_log` uses to decide whether its own
/// cache is stale, so if it hasn't moved, a page fetch cannot return anything
/// new. Hex rather than the raw u64: JSON numbers are f64, which cannot hold a
/// 64-bit hash without silently rounding two different states together.
fn history_fingerprint_impl(state: &RepoState) -> Result<String, String> {
    with_repo(state, |repo| repo.state_fingerprint().map(|f| format!("{f:x}")))
}

/// The active session's full log, computing and caching it on first use (or when
/// the all-branches toggle flipped since it was built) so lanes stay globally
/// consistent across pages and searches.
fn ensure_log(session: &mut Session, all_branches: bool) -> Result<&[CommitRow], String> {
    let sig = session.repo.state_fingerprint().map_err(to_message)?;
    if session.log.is_none() || session.log_all != all_branches || session.log_sig != sig {
        let rows = session
            .repo
            .log(LogOptions { all_branches, ..Default::default() })
            .map_err(to_message)?;
        session.log = Some(rows);
        session.log_all = all_branches;
        session.log_sig = sig;
    }
    Ok(session.log.as_deref().unwrap())
}

/// The active session's ref tree, cached against the state fingerprint.
///
/// `refs()` walks every branch, tag and remote and runs a `graph_ahead_behind`
/// revwalk per tracked branch — ~40ms on a repo with 838 refs — and it's part
/// of every workspace snapshot, so it ran on every action and every background
/// poll. Nearly all of those leave the refs untouched.
fn ensure_refs(session: &mut Session) -> Result<Refs, String> {
    let sig = session.repo.state_fingerprint().map_err(to_message)?;
    if let Some((cached_sig, refs)) = &session.refs_cache {
        if *cached_sig == sig {
            return Ok(refs.clone());
        }
    }
    let refs = session.repo.refs().map_err(to_message)?;
    session.refs_cache = Some((sig, refs.clone()));
    Ok(refs)
}

/// Where `rev` sits in the active repo's cached log, or `None` when it isn't in
/// it at all (unreachable, or excluded by the all-branches toggle).
///
/// The frontend holds only the first page of the log, so clicking a tag or an
/// older branch in the sidebar used to find nothing to scroll to. This lets it
/// ask how far down the commit is and load exactly that far.
fn log_index_of_impl(
    state: &RepoState,
    rev: String,
    all_branches: bool,
) -> Result<Option<usize>, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let id = session.repo.resolve_commit(&rev).map_err(to_message)?;
    let log = ensure_log(session, all_branches)?;
    Ok(log.iter().position(|row| row.id == id))
}

/// Commits whose summary, author, or id contain `query` (case-insensitive) —
/// GitKraken-style commit search over the full loaded graph. An empty query
/// returns nothing (the frontend shows the normal paged log instead).
fn search_log_impl(
    state: &RepoState,
    query: String,
    all_branches: bool,
) -> Result<Vec<CommitRow>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let log = ensure_log(session, all_branches)?;
    Ok(log.iter().filter(|r| row_matches(r, &q)).cloned().collect())
}

/// Whether a commit matches a lowercased search query, across message subject,
/// author name/email, and full or short id.
fn row_matches(r: &CommitRow, q: &str) -> bool {
    r.summary.to_lowercase().contains(q)
        || r.author_name.to_lowercase().contains(q)
        || r.author_email.to_lowercase().contains(q)
        || r.id.contains(q)
        || r.short_id.contains(q)
}

fn get_commit_detail_impl(state: &RepoState, rev: String) -> Result<CommitDetail, String> {
    with_repo(state, |repo| repo.commit_detail(&rev))
}

fn get_refs_impl(state: &RepoState) -> Result<Refs, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    ensure_refs(&mut guard.sessions[idx])
}

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
) -> Result<Option<FileDiff>, String> {
    with_repo(state, |repo| repo.file_diff(&path, staged))
}

fn stage_impl(state: &RepoState, path: String) -> Result<(), String> {
    with_recorded_index(state, "Stage", |repo| repo.stage(&path))
}

fn unstage_impl(state: &RepoState, path: String) -> Result<(), String> {
    with_recorded_index(state, "Unstage", |repo| repo.unstage(&path))
}

fn stage_hunk_impl(state: &RepoState, path: String, hunk_index: usize) -> Result<(), String> {
    with_recorded_index(state, "Stage block", |repo| repo.stage_hunk(&path, hunk_index))
}

fn unstage_hunk_impl(state: &RepoState, path: String, hunk_index: usize) -> Result<(), String> {
    with_recorded_index(state, "Unstage block", |repo| repo.unstage_hunk(&path, hunk_index))
}

fn discard_hunk_impl(state: &RepoState, path: String, hunk_index: usize) -> Result<(), String> {
    // Snapshot the whole file so undo restores the discarded hunk exactly.
    let paths = [path.clone()];
    with_recorded_discard(state, &paths, |repo| repo.discard_hunk(&path, hunk_index))
}

fn stage_all_impl(state: &RepoState) -> Result<(), String> {
    with_recorded_index(state, "Stage all", Repo::stage_all)
}

fn unstage_all_impl(state: &RepoState) -> Result<(), String> {
    with_recorded_index(state, "Unstage all", Repo::unstage_all)
}

/// Commit the staged changes. Invalidates the cached log because HEAD moves.
fn commit_changes_impl(
    state: &RepoState,
    subject: String,
    body: String,
    amend: bool,
) -> Result<String, String> {
    // Recorded soft: undo moves the tip back but keeps the committed changes
    // staged, so a mistaken commit can be reworked rather than lost.
    let label = if amend { "Amend commit" } else { "Commit" };
    with_recorded_head_move(state, label, true, |repo| repo.commit(&subject, &body, amend))
}

/// Check out `name` on the active repo. Invalidates the cached log because HEAD
/// moves, so the next `get_log_page` recomputes the walk from the new HEAD.
fn checkout_branch_impl(state: &RepoState, name: String) -> Result<(), String> {
    with_recorded_checkout(state, || format!("Checkout {name}"), |repo| repo.checkout_branch(&name))
}

/// Check out a remote-tracking branch (creating a local tracking branch if
/// needed). Invalidates the cached log because HEAD moves.
fn checkout_remote_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_recorded_checkout(state, || format!("Checkout {name}"), |repo| repo.checkout_remote(&name))
}

/// Create branch `name` from the current HEAD and check it out. Invalidates the
/// cached log because HEAD moves to the new branch.
fn create_branch_impl(state: &RepoState, name: String) -> Result<(), String> {
    with_recorded_branch_create(state, &name, None, |repo| repo.create_branch(&name).map(|()| String::new()))
        .map(|_| ())
}

/// `git pull` the active repo using `mode`. Invalidates the cached log because
/// pulling can bring in new commits. Returns git's output for display. Runs
/// unlocked (see `with_repo_networked`) so the UI stays responsive.
fn pull_impl(state: &RepoState, mode: PullMode) -> Result<String, String> {
    // Captured here rather than in the callback: with_repo_networked releases
    // the lock for the round trip, and by the time it runs the pull has already
    // moved HEAD.
    let before = with_repo(state, Repo::head_commit_id).ok();
    with_repo_networked(
        state,
        |repo| repo.pull(mode),
        // A pull moves HEAD, and moving it back is a plain reset.
        move |session| record_pull(session, before),
    )
}

/// `git push` the active repo's current branch. Returns git's output. Nothing
/// local changes, so no cache is invalidated.
fn push_impl(state: &RepoState) -> Result<String, String> {
    with_repo_networked(state, Repo::push, |_| {})
}

/// Force-push the active repo's current branch (see `Repo::push_force`).
fn push_force_impl(state: &RepoState) -> Result<String, String> {
    with_repo_networked(state, Repo::push_force, |_| ())
}

/// `git stash` the active repo's local changes. Returns git's output.
fn stash_impl(state: &RepoState) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let out = session.repo.stash().map_err(to_message)?;
    clear_undo(session); // the working tree changed under any stored undo
    Ok(out)
}

/// `git stash pop` on the active repo. Returns git's output.
fn stash_pop_impl(state: &RepoState) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let out = session.repo.stash_pop().map_err(to_message)?;
    clear_undo(session);
    Ok(out)
}

/// Apply stash `index`. `drop` pops (apply + remove) instead of leaving it.
fn stash_apply_impl(state: &RepoState, index: usize, drop: bool) -> Result<String, String> {
    with_repo_writing(state, |repo| repo.stash_apply(index, drop))
}

/// Drop stash `index` from the stack.
fn stash_drop_impl(state: &RepoState, index: usize) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
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
        Undoable::StashDropped { label: "Drop stash".into(), oid, message },
    );
    Ok(out)
}

/// Re-message stash `index`.
fn stash_rename_impl(state: &RepoState, index: usize, message: String) -> Result<String, String> {
    with_repo(state, |repo| repo.stash_rename(index, &message))
}

/// Write stash `index`'s diff to `path` as a patch file.
fn save_stash_patch_impl(state: &RepoState, index: usize, path: String) -> Result<String, String> {
    with_repo(state, |repo| repo.save_stash_patch(index, path.as_ref()))
}

/// Discard all local changes to `paths` (revert to HEAD; delete new files).
fn discard_files_impl(state: &RepoState, paths: Vec<String>) -> Result<(), String> {
    with_recorded_discard(state, &paths, |repo| repo.discard_files(&paths))
}

/// Stash only `paths` away (`git stash push -u -- <paths>`).
fn stash_files_impl(state: &RepoState, paths: Vec<String>) -> Result<String, String> {
    with_repo_writing(state, |repo| repo.stash_files(&paths))
}

/// Write a patch of `paths` (staged or working-tree direction) to `dest`.
fn save_files_patch_impl(
    state: &RepoState,
    paths: Vec<String>,
    staged: bool,
    dest: String,
) -> Result<String, String> {
    with_repo(state, |repo| repo.save_files_patch(&paths, staged, dest.as_ref()))
}

/// Append `paths` to the repo's `.gitignore`; returns the number added.
fn add_to_gitignore_impl(state: &RepoState, paths: Vec<String>) -> Result<usize, String> {
    with_repo_writing(state, |repo| repo.add_to_gitignore(&paths))
}

/// Reveal the repo-relative `path` in the OS file manager, selecting the file.
fn reveal_path_impl(state: &RepoState, path: String) -> Result<(), String> {
    let full = with_repo(state, |repo| Ok(repo.workdir_path()?.join(&path)))?;
    reveal_in_file_manager(&full)
}

/// Open the repo-relative `path` for editing: prefer VS Code (the `code` CLI)
/// when it's on PATH, since the OS's registered default app for a file type
/// is often not an editor at all (e.g. a terminal app claiming shell scripts).
/// Falls back to the OS default application otherwise.
fn open_in_editor_impl(state: &RepoState, path: String) -> Result<(), String> {
    let full = with_repo(state, |repo| Ok(repo.workdir_path()?.join(&path)))?;
    if std::process::Command::new("code").arg(&full).spawn().is_ok() {
        return Ok(());
    }
    open_in_default_app(&full)
}

// --- User dotfiles (~/.gitconfig, ~/.tigrc) ---------------------------------
// Deliberately scoped to exactly these two named files, resolved server-side
// from $HOME — the frontend picks a `DotfileKind`, never a path. A generic
// "read/write any path" command would let any webview code touch arbitrary
// files on disk; this doesn't need that power, so it doesn't have it. No repo
// needs to be open: these aren't repo-scoped.

/// One of the two dotfiles the Settings "Dotfiles" panel edits.
#[derive(Debug, Clone, Copy, Deserialize)]
enum DotfileKind {
    GitConfig,
    Tigrc,
}

impl DotfileKind {
    fn file_name(self) -> &'static str {
        match self {
            DotfileKind::GitConfig => ".gitconfig",
            DotfileKind::Tigrc => ".tigrc",
        }
    }
}

fn dotfile_path(kind: DotfileKind) -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(Path::new(&home).join(kind.file_name()))
}

/// The file's current content, or an empty string if it doesn't exist yet
/// (Save will create it).
fn read_dotfile_impl(kind: DotfileKind) -> Result<String, String> {
    match std::fs::read_to_string(dotfile_path(kind)?) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Overwrite the file with `content` verbatim — no syntax validation, no
/// backup. The frontend confirms with the user before calling this.
fn write_dotfile_impl(kind: DotfileKind, content: String) -> Result<(), String> {
    std::fs::write(dotfile_path(kind)?, content).map_err(|e| e.to_string())
}

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
    with_repo_writing(state, |repo| repo.resolve_conflict(&path, &content))
}

/// Resolve `path` by taking one whole side (ours/theirs), for binary conflicts.
fn resolve_conflict_side_impl(state: &RepoState, path: String, ours: bool) -> Result<(), String> {
    with_repo_writing(state, |repo| repo.resolve_conflict_side(&path, ours))
}

/// Abort the in-progress merge/rebase. Invalidates the cached log (HEAD/tree).
fn abort_conflict_impl(state: &RepoState) -> Result<String, String> {
    with_active_repo_invalidating(state, Repo::abort_conflict)
}

/// Commit the merge / continue the rebase. Invalidates the cached log.
fn finish_conflict_impl(state: &RepoState, message: String) -> Result<String, String> {
    with_active_repo_invalidating(state, |repo| repo.finish_conflict(&message))
}

/// Every file path in `rev`'s tree, for the File Tree view.
fn get_commit_tree_impl(state: &RepoState, rev: String) -> Result<Vec<String>, String> {
    with_repo(state, |repo| repo.commit_tree(&rev))
}

/// Per-line blame for `path` as of `rev`.
fn get_blame_impl(state: &RepoState, rev: String, path: String) -> Result<Vec<BlameLine>, String> {
    with_repo(state, |repo| repo.blame(&rev, &path))
}

/// Commits that changed `path`, up to `rev`.
fn get_file_history_impl(
    state: &RepoState,
    rev: String,
    path: String,
) -> Result<Vec<FileCommit>, String> {
    with_repo(state, |repo| repo.file_history(&rev, &path))
}

fn get_config_impl(state: &RepoState) -> Result<Vec<ConfigEntry>, String> {
    with_repo(state, |repo| repo.read_config())
}

fn set_config_impl(
    state: &RepoState,
    scope: ConfigScope,
    name: String,
    value: String,
) -> Result<(), String> {
    with_repo(state, |repo| repo.set_config(scope, &name, &value))
}

/// Run `f` against the active repo and then invalidate its cached log, for
/// operations that move HEAD or rewrite history (so the next `get_log_page`
/// recomputes the walk). Errors if no repository is open.
fn with_active_repo_invalidating<T>(
    state: &RepoState,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let out = f(&session.repo).map_err(to_message)?;
    Ok(out)
}

/// Run a **network** git operation (fetch / pull / push) against the active
/// repo *without* holding the workspace lock, then apply `after` to the
/// session under a fresh lock.
///
/// The lock is global and a network round trip can take seconds; holding it
/// across one blocks every other command, so a single background fetch would
/// stall the whole UI (clicking Local Changes would wait on it). These ops all
/// shell out to `git`, which needs only the working directory — so we read the
/// path under the lock, release it, and run against our own `Repo` handle
/// (opening one costs ~1ms).
///
/// `after` re-resolves the session **by path** rather than reusing an index:
/// the user can switch or close tabs during the unlocked window, so the active
/// index may no longer refer to the repo we just operated on.
fn with_repo_networked<T>(
    state: &RepoState,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
    after: impl FnOnce(&mut Session),
) -> Result<T, String> {
    let path = {
        let guard = state.0.lock().map_err(to_message)?;
        let idx = guard.active.ok_or("no repository is open")?;
        guard.sessions[idx].path.clone()
    }; // lock released here — before the network round trip
    let repo = Repo::open(&path).map_err(to_message)?;
    let out = f(&repo).map_err(to_message)?;
    {
        let mut guard = state.0.lock().map_err(to_message)?;
        if let Some(session) = guard.sessions.iter_mut().find(|s| s.path == path) {
            after(session);
        }
    }
    Ok(out)
}

// --- undo/redo -------------------------------------------------------------
// A single supported action is remembered at a time (GitKraken-style). Each
// recording helper captures the git state around an op and stores it as the
// session's undo slot, clearing any pending redo (a new action forks history).

/// Labels of what Undo/Redo would do, for the toolbar buttons (null = disabled).
#[derive(Serialize, Clone, Default)]
pub struct UndoView {
    undo: Option<String>,
    redo: Option<String>,
}

fn undo_view(session: &Session) -> UndoView {
    UndoView {
        undo: session.undo.as_ref().map(|a| a.label().to_string()),
        redo: session.redo.as_ref().map(|a| a.label().to_string()),
    }
}

fn set_undo(session: &mut Session, action: Undoable) {
    session.undo = Some(action);
    session.redo = None;
}

/// Run a HEAD-moving op (commit / reset / merge / cherry-pick / revert /
/// rebase), recording it as an undo only when the branch tip actually moves.
/// `soft` keeps the working tree on undo (commit, so undone changes stay
/// staged); otherwise undo uses a safe `--keep` reset. Invalidates the log.
fn with_recorded_head_move<T>(
    state: &RepoState,
    label: &str,
    soft: bool,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let before = session.repo.head_commit_id().ok(); // None on an unborn HEAD
    let out = f(&session.repo).map_err(to_message)?;
    let after = session.repo.head_commit_id().map_err(to_message)?;
    if let Some(before) = before {
        if before != after {
            set_undo(
                session,
                Undoable::HeadMoved { label: label.into(), before, after, soft },
            );
        }
    }
    Ok(out)
}

/// Where the staging snapshots for undo/redo live, inside `.git`. Fixed names:
/// undo is single-level, so at most one pair exists at a time and each new
/// recording overwrites the last.
const UNDO_INDEX_BEFORE: &str = "gitp-undo-index-before";
const UNDO_INDEX_AFTER: &str = "gitp-undo-index-after";

/// Run an index-changing op (stage / unstage, whole file or one hunk),
/// recording the staging area on each side so undo restores it exactly.
///
/// The tree is captured rather than the list of paths touched: a file can be
/// staged in part, and "unstage all" has to come back to the mixture that was
/// there before rather than to all-or-nothing. Recording is skipped when the
/// tree can't be written (a conflicted index) or when nothing actually moved.
fn with_recorded_index<T>(
    state: &RepoState,
    label: &str,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let before = session.repo.snapshot_index(UNDO_INDEX_BEFORE).ok().flatten();
    let out = f(&session.repo).map_err(to_message)?;
    invalidate_status(session);
    let after = session.repo.snapshot_index(UNDO_INDEX_AFTER).ok().flatten();
    if let (Some(before), Some(after)) = (before, after) {
        // The two paths are fixed, so compare what they hold: an operation that
        // staged nothing must not light up the Undo button.
        let changed = match (std::fs::read(&before), std::fs::read(&after)) {
            (Ok(a), Ok(b)) => a != b,
            _ => false,
        };
        if changed {
            set_undo(
                session,
                Undoable::IndexChanged { label: label.into(), before, after },
            );
        }
    }
    Ok(out)
}

/// Run an upstream change, recording what the branch tracked before.
fn with_recorded_upstream(
    state: &RepoState,
    branch: String,
    label: String,
    f: impl FnOnce(&Repo, &str) -> gitp_core::Result<String>,
) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let before = session.repo.branch_upstream(&branch).ok().flatten();
    let out = f(&session.repo, &branch).map_err(to_message)?;
    let after = session.repo.branch_upstream(&branch).ok().flatten();
    // The upstream lives in .git/config, which the ref fingerprint guarding the
    // refs cache doesn't hash — without this the sidebar keeps the old tracking
    // branch and ahead/behind counts.
    session.refs_cache = None;
    if before != after {
        set_undo(session, Undoable::UpstreamChanged { label, branch, before, after });
    }
    Ok(out)
}

/// A pull moves HEAD; record it so Undo is a plain reset back, the same as any
/// other ref move. The remote-tracking refs it also updated stay where they are
/// — undo puts *your* branch back, it doesn't un-fetch.
fn record_pull(session: &mut Session, before: Option<String>) {
    let Some(before) = before else { return };
    let Ok(after) = session.repo.head_commit_id() else { return };
    if before != after {
        set_undo(
            session,
            Undoable::HeadMoved { label: "Pull".into(), before, after, soft: false },
        );
    }
}

/// Run a checkout, recording the switch (branch/commit before → after) so undo
/// can return to the previous revision. Invalidates the log.
fn with_recorded_checkout<T>(
    state: &RepoState,
    label: impl FnOnce() -> String,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let before = session.repo.head_ref_name().ok();
    let out = f(&session.repo).map_err(to_message)?;
    let after = session.repo.head_ref_name().map_err(to_message)?;
    if let Some(before) = before {
        if before != after {
            set_undo(
                session,
                Undoable::Switched { label: label(), before, after },
            );
        }
    }
    Ok(out)
}

/// Run a branch-create that also checks it out (`name` created at `at_rev`, or at
/// HEAD when `at_rev` is None), recording it so undo returns to the previous
/// branch and deletes the new one. Invalidates the log.
fn with_recorded_branch_create(
    state: &RepoState,
    name: &str,
    at_rev: Option<&str>,
    f: impl FnOnce(&Repo) -> gitp_core::Result<String>,
) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let prev = session.repo.head_ref_name().map_err(to_message)?;
    let at = match at_rev {
        Some(r) => r.to_string(),
        None => session.repo.head_commit_id().map_err(to_message)?,
    };
    let out = f(&session.repo).map_err(to_message)?;
    set_undo(
        session,
        Undoable::BranchCreated {
            label: format!("Create branch {name}"),
            name: name.into(),
            at,
            prev,
        },
    );
    Ok(out)
}

/// Discard `paths`, snapshotting each file's bytes before and after so undo can
/// restore the discarded content exactly (and redo re-discards).
fn with_recorded_discard(
    state: &RepoState,
    paths: &[String],
    f: impl FnOnce(&Repo) -> gitp_core::Result<()>,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let befores: Vec<Option<Vec<u8>>> =
        paths.iter().map(|p| session.repo.read_workfile(p).ok().flatten()).collect();
    f(&session.repo).map_err(to_message)?;
    let files = paths
        .iter()
        .enumerate()
        .map(|(i, p)| FileBlob {
            path: p.clone(),
            before: befores[i].clone(),
            after: session.repo.read_workfile(p).ok().flatten(),
        })
        .collect();
    let n = paths.len();
    set_undo(
        session,
        Undoable::Discarded {
            label: format!("Discard {n} file{}", if n == 1 { "" } else { "s" }),
            files,
        },
    );
    invalidate_status(session); // a discard rewrites the worktree, not the index
    Ok(())
}

/// Forget the undo/redo slots — used when a non-tracked op (pull, stash) moves
/// HEAD or the working tree, which could make a stored action stale.
fn clear_undo(session: &mut Session) {
    session.undo = None;
    session.redo = None;
}

/// The active session's staging lists, cached until the worktree changes.
///
/// `status_summary` shells out to `git status --porcelain -u all`, which has to
/// stat the whole working tree — ~110ms on a large repo, and it ran on every
/// snapshot: every action, every view switch, and the 60s background poll. The
/// filesystem watcher (see `watch_worktree`) tells us when that's actually
/// worth redoing.
///
/// The dirty flag is cleared *before* the scan, so a write that lands while
/// `git status` is running marks the result stale rather than being swallowed.
/// With no watcher (the OS refused, or watch limits were hit) there's no cache
/// and every call scans, exactly as before.
fn ensure_status(session: &mut Session) -> Result<StatusLists, String> {
    let dirty = match &session.worktree_dirty {
        Some(flag) => flag.swap(false, Ordering::SeqCst),
        None => true,
    };
    let stamp = session.repo.index_stamp();
    if !dirty {
        if let Some((cached_stamp, cached)) = &session.status_cache {
            if *cached_stamp == stamp {
                return Ok(cached.clone());
            }
        }
    }
    let status = session.repo.status_summary().map_err(to_message)?;
    session.status_cache = Some((stamp, status.clone()));
    Ok(status)
}

/// Drop the cached `git status` because we're about to change the working tree
/// in a way the index won't record.
///
/// The watcher takes ~12ms to deliver an event (measured, FSEvents), while the
/// frontend issues its follow-up snapshot within a millisecond or two of the
/// command returning — so for changes gitp makes itself the watcher is too slow
/// to be the only guard. Index-touching operations are caught by the stamp in
/// `ensure_status`; this is for the rest.
fn invalidate_status(session: &mut Session) {
    session.status_cache = None;
}

/// `with_repo` for operations that write the working tree — see
/// `invalidate_status` for why they can't rely on the watcher alone.
fn with_repo_writing<T>(
    state: &RepoState,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let out = f(&session.repo).map_err(to_message)?;
    invalidate_status(session);
    Ok(out)
}

/// Build the post-action snapshot in one lock acquisition, running `git status`
/// exactly once (see `WorkspaceSnapshot`) — and only when something changed.
fn workspace_snapshot_impl(state: &RepoState) -> Result<WorkspaceSnapshot, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];

    let status = ensure_status(session)?;
    let refs = ensure_refs(session)?;
    // A path can appear in both lists (partially staged); the badge counts it once.
    let local_changes = status
        .staged
        .iter()
        .chain(&status.unstaged)
        .map(|f| f.path.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len();

    Ok(WorkspaceSnapshot {
        refs,
        local_changes,
        status,
        rebase: session.repo.rebase_status().map_err(to_message)?,
        conflict: session.repo.conflict_status().map_err(to_message)?,
        undo: undo_view(session),
    })
}

fn undo_state_impl(state: &RepoState) -> Result<UndoView, String> {
    let guard = state.0.lock().map_err(to_message)?;
    let Some(idx) = guard.active else {
        return Ok(UndoView::default());
    };
    Ok(undo_view(&guard.sessions[idx]))
}

/// Reverse the last recorded action. On failure the undo slot is kept so the
/// button stays and the user can retry after fixing the cause.
fn undo_impl(state: &RepoState) -> Result<UndoView, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let action = session.undo.take().ok_or("nothing to undo")?;
    match session.repo.undo(&action) {
        Ok(()) => {
            session.redo = Some(action);
            // Undoing a discard restores worktree files, and an upstream change
            // lives in .git/config — which the ref fingerprint guarding the refs
            // cache can't see. Undo is rare and user-initiated, so dropping both
            // caches outright is cheaper than reasoning per action kind.
            invalidate_status(session);
            session.refs_cache = None;
            Ok(undo_view(session))
        }
        Err(e) => {
            session.undo = Some(action);
            Err(to_message(e))
        }
    }
}

/// Re-apply the action that was just undone.
fn redo_impl(state: &RepoState) -> Result<UndoView, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let action = session.redo.take().ok_or("nothing to redo")?;
    match session.repo.redo(&action) {
        Ok(()) => {
            session.undo = Some(action);
            invalidate_status(session);
            session.refs_cache = None; // same reasoning as undo_impl
            Ok(undo_view(session))
        }
        Err(e) => {
            session.redo = Some(action);
            Err(to_message(e))
        }
    }
}

/// Detach HEAD onto `rev`. Invalidates the cached log because HEAD moves.
fn checkout_commit_impl(state: &RepoState, rev: String) -> Result<String, String> {
    with_recorded_checkout(state, || format!("Checkout {}", short_rev(&rev)), |repo| {
        repo.checkout_commit(&rev)
    })
}

/// A short display form of a revision for undo labels (12-char id, or the name).
fn short_rev(rev: &str) -> String {
    if rev.len() > 12 && rev.bytes().all(|b| b.is_ascii_hexdigit()) {
        rev[..12].to_string()
    } else {
        rev.to_string()
    }
}

/// Create branch `name` at `rev` and check it out. Invalidates the cached log.
fn create_branch_at_impl(state: &RepoState, name: String, rev: String) -> Result<String, String> {
    with_recorded_branch_create(state, &name, Some(&rev), |repo| repo.create_branch_at(&name, &rev))
}

/// Tag `rev` as `name`. HEAD doesn't move, so the log cache is left intact.
fn create_tag_at_impl(state: &RepoState, name: String, rev: String) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let out = session.repo.create_tag_at(&name, &rev).map_err(to_message)?;
    // Read back what the ref actually holds, so redo can recreate it after undo
    // has removed it.
    let target = session.repo.tag_ref_target(&name).map_err(to_message)?;
    set_undo(session, Undoable::TagCreated { label: format!("Tag {name}"), name, target });
    Ok(out)
}

/// Read tag `name`'s metadata for the tag details dialog. Read-only.
fn tag_detail_impl(state: &RepoState, name: String) -> Result<TagDetail, String> {
    with_repo(state, |repo| repo.tag_detail(&name))
}

/// Push tag `name` to origin. Nothing local changes.
fn push_tag_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_repo(state, |repo| repo.push_tag(&name))
}

/// Delete the local tag `name`. HEAD doesn't move and no commit is lost (the
/// tagged commit stays reachable from whatever else points at it), so the log
/// cache stays valid.
fn delete_tag_impl(state: &RepoState, name: String) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    // Captured before the delete: afterwards the ref is gone and with it any way
    // to tell which tag object it named.
    let target = session.repo.tag_ref_target(&name).map_err(to_message)?;
    let out = session.repo.delete_tag(&name).map_err(to_message)?;
    set_undo(
        session,
        Undoable::TagDeleted { label: format!("Delete tag {name}"), name, target },
    );
    Ok(out)
}

/// Delete tag `name` on origin.
fn delete_remote_tag_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_repo(state, |repo| repo.delete_remote_tag(&name))
}

/// Whether origin has a tag called `name` (live `git ls-remote` probe).
fn remote_tag_exists_impl(state: &RepoState, name: String) -> Result<bool, String> {
    with_repo(state, |repo| repo.remote_tag_exists(&name))
}

/// Cherry-pick `rev` onto the current branch. Invalidates the cached log.
fn cherry_pick_impl(state: &RepoState, rev: String) -> Result<String, String> {
    with_recorded_head_move(state, "Cherry-pick", false, |repo| repo.cherry_pick(&rev))
}

/// Revert `rev` on the current branch. Invalidates the cached log.
fn revert_impl(state: &RepoState, rev: String) -> Result<String, String> {
    with_recorded_head_move(state, "Revert", false, |repo| repo.revert(&rev))
}

/// Reset the current branch to `rev`. Invalidates the cached log.
fn reset_impl(state: &RepoState, rev: String, mode: ResetMode) -> Result<String, String> {
    with_recorded_head_move(state, "Reset", false, |repo| repo.reset(&rev, mode))
}

/// Rebase the current branch onto `rev`. Invalidates the cached log.
fn rebase_onto_impl(state: &RepoState, rev: String) -> Result<String, String> {
    with_recorded_head_move(state, "Rebase", false, |repo| repo.rebase_onto(&rev))
}

/// Rename branch `old` to `new`. Invalidates the cached log (HEAD's branch name
/// may change).
fn rename_branch_impl(state: &RepoState, old: String, new: String) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
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
    with_repo(state, |repo| repo.rename_remote_branch(&new))
}

/// Create branch `name` at HEAD without checking it out (e.g. a rebase backup).
fn create_backup_branch_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_repo(state, |repo| repo.create_branch_here(&name))
}

/// Delete branch `name` (force = `-D`). Doesn't move HEAD, so the log stays.
fn delete_branch_impl(state: &RepoState, name: String, force: bool) -> Result<String, String> {
    let label = format!("Delete branch {name}");
    delete_branches_recorded(state, &[name], force, label).map(|(out, _)| out)
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
    Ok(DeleteBranchesResult { output: out, failed })
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
    let mut guard = state.0.lock().map_err(to_message)?;
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
                deleted.push(DeletedBranch { name: name.clone(), oid, upstream });
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
        set_undo(session, Undoable::BranchesDeleted { label, branches: deleted });
    }
    Ok((outputs.join("\n"), failed))
}

fn delete_remote_branch_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_repo(state, |repo| repo.delete_remote_branch(&name))
}

fn remote_branch_exists_impl(state: &RepoState, name: String) -> Result<Option<String>, String> {
    with_repo(state, |repo| repo.remote_branch_exists(&name))
}

/// Merge `name` into the current branch. Invalidates the cached log.
fn merge_branch_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_recorded_head_move(state, &format!("Merge {name}"), false, |repo| repo.merge_branch(&name))
}

/// Push branch `name` to origin. No local change to the log.
fn push_branch_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_repo(state, |repo| repo.push_branch(&name))
}

/// Fetch `name`'s remote. Updates remote-tracking refs only, so the local log
/// (which walks from HEAD) is unchanged.
fn fetch_branch_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_repo_networked(state, |repo| repo.fetch_branch(&name), |_| {})
}

/// Fetch all remotes. Only updates remote-tracking refs, so the cached log
/// (which walks from HEAD) is unchanged.
fn fetch_all_impl(state: &RepoState) -> Result<String, String> {
    with_repo_networked(state, Repo::fetch_all, |_| {})
}

/// Local branches whose upstream was deleted (see `Repo::gone_branches`) — the
/// candidates Quick Launch's Clean up offers to remove.
fn gone_branches_impl(state: &RepoState) -> Result<Vec<String>, String> {
    with_repo(state, Repo::gone_branches)
}

/// Fetch one named remote, for repos with more than one.
fn fetch_remote_impl(state: &RepoState, remote: String) -> Result<String, String> {
    with_repo_networked(state, |repo| repo.fetch_remote(&remote), |_| {})
}

/// Fetch and fast-forward `name`. Invalidates the cached log because the branch
/// (possibly the current one) advances.
fn fetch_and_update_branch_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_repo_networked(
        state,
        |repo| repo.fetch_and_update_branch(&name),
        |_| (), // the fast-forward advanced a local branch — ensure_log notices
    )
}

/// Fast-forward `name` to its upstream. Invalidates the cached log (it may be
/// the current branch).
fn fast_forward_branch_impl(state: &RepoState, name: String) -> Result<String, String> {
    with_active_repo_invalidating(state, |repo| repo.fast_forward_branch(&name))
}

/// Set `branch`'s upstream. No commit change, so the log stays.
fn set_upstream_impl(state: &RepoState, branch: String, upstream: String) -> Result<String, String> {
    with_recorded_upstream(state, branch, format!("Set upstream"), |repo, b| {
        repo.set_upstream(b, &upstream)
    })
}

/// Clear `branch`'s upstream.
fn unset_upstream_impl(state: &RepoState, branch: String) -> Result<String, String> {
    with_recorded_upstream(state, branch, "Unset upstream".into(), |repo, b| {
        repo.unset_upstream(b)
    })
}

/// Compute the pull/merge-request URL for `branch` and open it in the default
/// browser. Returns the URL for display.
fn create_pull_request_impl(state: &RepoState, branch: String) -> Result<String, String> {
    let url = with_repo(state, |repo| repo.pull_request_url(&branch))?;
    open_in_browser(&url).map_err(|e| e.to_string())?;
    Ok(url)
}

/// The commits that a rebase onto `onto` would replay, for the editor UI.
fn get_rebase_todo_impl(state: &RepoState, onto: String) -> Result<Vec<RebaseCommit>, String> {
    with_repo(state, |repo| repo.rebase_todo(&onto))
}

/// Run an interactive rebase onto `onto` following `steps`. Invalidates the log.
fn interactive_rebase_impl(
    state: &RepoState,
    onto: String,
    steps: Vec<RebaseStep>,
    update_refs: bool,
) -> Result<String, String> {
    with_recorded_head_move(state, "Rebase", false, |repo| {
        repo.interactive_rebase(&onto, &steps, update_refs)
    })
}

/// Snapshot of an in-progress rebase (for the resume UI), or a not-in-progress
/// status. Does not invalidate the log — it only reads state.
fn rebase_status_impl(state: &RepoState) -> Result<RebaseStatus, String> {
    with_repo(state, Repo::rebase_status)
}

/// Resume / skip / abort a paused rebase. All can move HEAD, so invalidate.
fn rebase_continue_impl(state: &RepoState) -> Result<String, String> {
    with_active_repo_invalidating(state, Repo::rebase_continue)
}

fn rebase_skip_impl(state: &RepoState) -> Result<String, String> {
    with_active_repo_invalidating(state, Repo::rebase_skip)
}

fn rebase_abort_impl(state: &RepoState) -> Result<String, String> {
    with_active_repo_invalidating(state, Repo::rebase_abort)
}

/// Open `url` in the OS default browser.
fn open_in_browser(url: &str) -> std::io::Result<()> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program).arg(url).spawn()?;
    Ok(())
}

// --- Tauri command wrappers -------------------------------------------------
//
// Every wrapper is `command(async)`, not a plain `command`. A plain synchronous
// Tauri command runs *inline on the main thread* — the thread driving the
// webview — so a `git status` (~110ms on a large repo), a log walk (~200ms),
// or, worst of all, a push over the network froze the whole window for its
// duration. `(async)` dispatches the same synchronous body onto the async
// runtime's thread pool instead, so the UI keeps painting and scrolling while
// git works. The bodies stay synchronous; only where they run changes.

#[tauri::command(async)]
fn open_repo(path: String, state: State<RepoState>) -> Result<WorkspaceView, String> {
    open_repo_impl(&state, path)
}

#[tauri::command(async)]
fn list_repos(state: State<RepoState>) -> Result<WorkspaceView, String> {
    list_repos_impl(&state)
}

#[tauri::command(async)]
fn activate_repo(path: String, state: State<RepoState>) -> Result<WorkspaceView, String> {
    activate_repo_impl(&state, path)
}

#[tauri::command(async)]
fn close_repo(path: String, state: State<RepoState>) -> Result<WorkspaceView, String> {
    close_repo_impl(&state, path)
}

#[tauri::command(async)]
fn get_log_page(
    offset: usize,
    limit: usize,
    all_branches: bool,
    state: State<RepoState>,
) -> Result<LogPage, String> {
    get_log_page_impl(&state, offset, limit, all_branches)
}

#[tauri::command(async)]
fn log_index_of(
    rev: String,
    all_branches: bool,
    state: State<RepoState>,
) -> Result<Option<usize>, String> {
    log_index_of_impl(&state, rev, all_branches)
}

#[tauri::command(async)]
fn search_log(
    query: String,
    all_branches: bool,
    state: State<RepoState>,
) -> Result<Vec<CommitRow>, String> {
    search_log_impl(&state, query, all_branches)
}

#[tauri::command(async)]
fn get_commit_detail(rev: String, state: State<RepoState>) -> Result<CommitDetail, String> {
    get_commit_detail_impl(&state, rev)
}

#[tauri::command(async)]
fn get_refs(state: State<RepoState>) -> Result<Refs, String> {
    get_refs_impl(&state)
}

#[tauri::command(async)]
fn get_working_changes(state: State<RepoState>) -> Result<Vec<FileDiff>, String> {
    get_working_changes_impl(&state)
}

#[tauri::command(async)]
fn get_status(state: State<RepoState>) -> Result<StatusLists, String> {
    get_status_impl(&state)
}

#[tauri::command(async)]
fn get_status_summary(state: State<RepoState>) -> Result<StatusLists, String> {
    get_status_summary_impl(&state)
}

#[tauri::command(async)]
fn get_file_diff(
    path: String,
    staged: bool,
    state: State<RepoState>,
) -> Result<Option<FileDiff>, String> {
    get_file_diff_impl(&state, path, staged)
}

#[tauri::command(async)]
fn stage(path: String, state: State<RepoState>) -> Result<(), String> {
    stage_impl(&state, path)
}

#[tauri::command(async)]
fn unstage(path: String, state: State<RepoState>) -> Result<(), String> {
    unstage_impl(&state, path)
}

#[tauri::command(async)]
fn stage_hunk(path: String, hunk_index: usize, state: State<RepoState>) -> Result<(), String> {
    stage_hunk_impl(&state, path, hunk_index)
}

#[tauri::command(async)]
fn unstage_hunk(path: String, hunk_index: usize, state: State<RepoState>) -> Result<(), String> {
    unstage_hunk_impl(&state, path, hunk_index)
}

#[tauri::command(async)]
fn discard_hunk(path: String, hunk_index: usize, state: State<RepoState>) -> Result<(), String> {
    discard_hunk_impl(&state, path, hunk_index)
}

#[tauri::command(async)]
fn stage_all(state: State<RepoState>) -> Result<(), String> {
    stage_all_impl(&state)
}

#[tauri::command(async)]
fn unstage_all(state: State<RepoState>) -> Result<(), String> {
    unstage_all_impl(&state)
}

#[tauri::command(async)]
fn undo_state(state: State<RepoState>) -> Result<UndoView, String> {
    undo_state_impl(&state)
}

#[tauri::command(async)]
fn undo(state: State<RepoState>) -> Result<UndoView, String> {
    undo_impl(&state)
}

#[tauri::command(async)]
fn redo(state: State<RepoState>) -> Result<UndoView, String> {
    redo_impl(&state)
}

#[tauri::command(async)]
fn commit_changes(
    subject: String,
    body: String,
    amend: bool,
    state: State<RepoState>,
) -> Result<String, String> {
    commit_changes_impl(&state, subject, body, amend)
}

#[tauri::command(async)]
fn checkout_branch(name: String, state: State<RepoState>) -> Result<(), String> {
    checkout_branch_impl(&state, name)
}

#[tauri::command(async)]
fn checkout_remote(name: String, state: State<RepoState>) -> Result<String, String> {
    checkout_remote_impl(&state, name)
}

#[tauri::command(async)]
fn create_branch(name: String, state: State<RepoState>) -> Result<(), String> {
    create_branch_impl(&state, name)
}

#[tauri::command(async)]
fn checkout_commit(rev: String, state: State<RepoState>) -> Result<String, String> {
    checkout_commit_impl(&state, rev)
}

#[tauri::command(async)]
fn create_branch_at(name: String, rev: String, state: State<RepoState>) -> Result<String, String> {
    create_branch_at_impl(&state, name, rev)
}

#[tauri::command(async)]
fn create_tag_at(name: String, rev: String, state: State<RepoState>) -> Result<String, String> {
    create_tag_at_impl(&state, name, rev)
}

#[tauri::command(async)]
fn history_fingerprint(state: State<RepoState>) -> Result<String, String> {
    history_fingerprint_impl(&state)
}

#[tauri::command(async)]
fn tag_detail(name: String, state: State<RepoState>) -> Result<TagDetail, String> {
    tag_detail_impl(&state, name)
}

#[tauri::command(async)]
fn push_tag(name: String, state: State<RepoState>) -> Result<String, String> {
    push_tag_impl(&state, name)
}

#[tauri::command(async)]
fn delete_tag(name: String, state: State<RepoState>) -> Result<String, String> {
    delete_tag_impl(&state, name)
}

#[tauri::command(async)]
fn delete_remote_tag(name: String, state: State<RepoState>) -> Result<String, String> {
    delete_remote_tag_impl(&state, name)
}

#[tauri::command(async)]
fn remote_tag_exists(name: String, state: State<RepoState>) -> Result<bool, String> {
    remote_tag_exists_impl(&state, name)
}

#[tauri::command(async)]
fn cherry_pick(rev: String, state: State<RepoState>) -> Result<String, String> {
    cherry_pick_impl(&state, rev)
}

#[tauri::command(async)]
fn revert(rev: String, state: State<RepoState>) -> Result<String, String> {
    revert_impl(&state, rev)
}

#[tauri::command(async)]
fn reset(rev: String, mode: ResetMode, state: State<RepoState>) -> Result<String, String> {
    reset_impl(&state, rev, mode)
}

#[tauri::command(async)]
fn rebase_onto(rev: String, state: State<RepoState>) -> Result<String, String> {
    rebase_onto_impl(&state, rev)
}

#[tauri::command(async)]
fn rename_branch(old: String, new: String, state: State<RepoState>) -> Result<String, String> {
    rename_branch_impl(&state, old, new)
}

#[tauri::command(async)]
fn rename_remote_branch(new: String, state: State<RepoState>) -> Result<String, String> {
    rename_remote_branch_impl(&state, new)
}

#[tauri::command(async)]
fn create_backup_branch(name: String, state: State<RepoState>) -> Result<String, String> {
    create_backup_branch_impl(&state, name)
}

#[tauri::command(async)]
fn delete_branch(name: String, force: bool, state: State<RepoState>) -> Result<String, String> {
    delete_branch_impl(&state, name, force)
}

#[tauri::command(async)]
fn delete_remote_branch(name: String, state: State<RepoState>) -> Result<String, String> {
    delete_remote_branch_impl(&state, name)
}

#[tauri::command(async)]
fn remote_branch_exists(name: String, state: State<RepoState>) -> Result<Option<String>, String> {
    remote_branch_exists_impl(&state, name)
}

#[tauri::command(async)]
fn merge_branch(name: String, state: State<RepoState>) -> Result<String, String> {
    merge_branch_impl(&state, name)
}

#[tauri::command(async)]
fn push_branch(name: String, state: State<RepoState>) -> Result<String, String> {
    push_branch_impl(&state, name)
}

#[tauri::command(async)]
fn fetch_branch(name: String, state: State<RepoState>) -> Result<String, String> {
    fetch_branch_impl(&state, name)
}

#[tauri::command(async)]
fn fetch_all(state: State<RepoState>) -> Result<String, String> {
    fetch_all_impl(&state)
}

#[tauri::command(async)]
fn delete_branches(
    names: Vec<String>,
    force: bool,
    state: State<RepoState>,
) -> Result<DeleteBranchesResult, String> {
    delete_branches_impl(&state, names, force)
}

#[tauri::command(async)]
fn gone_branches(state: State<RepoState>) -> Result<Vec<String>, String> {
    gone_branches_impl(&state)
}

#[tauri::command(async)]
fn fetch_remote(remote: String, state: State<RepoState>) -> Result<String, String> {
    fetch_remote_impl(&state, remote)
}

#[tauri::command(async)]
fn fetch_and_update_branch(name: String, state: State<RepoState>) -> Result<String, String> {
    fetch_and_update_branch_impl(&state, name)
}

#[tauri::command(async)]
fn fast_forward_branch(name: String, state: State<RepoState>) -> Result<String, String> {
    fast_forward_branch_impl(&state, name)
}

#[tauri::command(async)]
fn set_upstream(branch: String, upstream: String, state: State<RepoState>) -> Result<String, String> {
    set_upstream_impl(&state, branch, upstream)
}

#[tauri::command(async)]
fn unset_upstream(branch: String, state: State<RepoState>) -> Result<String, String> {
    unset_upstream_impl(&state, branch)
}

#[tauri::command(async)]
fn create_pull_request(branch: String, state: State<RepoState>) -> Result<String, String> {
    create_pull_request_impl(&state, branch)
}

#[tauri::command(async)]
fn get_rebase_todo(onto: String, state: State<RepoState>) -> Result<Vec<RebaseCommit>, String> {
    get_rebase_todo_impl(&state, onto)
}

#[tauri::command(async)]
fn interactive_rebase(
    onto: String,
    steps: Vec<RebaseStep>,
    update_refs: bool,
    state: State<RepoState>,
) -> Result<String, String> {
    interactive_rebase_impl(&state, onto, steps, update_refs)
}

#[tauri::command(async)]
fn rebase_status(state: State<RepoState>) -> Result<RebaseStatus, String> {
    rebase_status_impl(&state)
}

#[tauri::command(async)]
fn rebase_continue(state: State<RepoState>) -> Result<String, String> {
    rebase_continue_impl(&state)
}

#[tauri::command(async)]
fn rebase_skip(state: State<RepoState>) -> Result<String, String> {
    rebase_skip_impl(&state)
}

#[tauri::command(async)]
fn rebase_abort(state: State<RepoState>) -> Result<String, String> {
    rebase_abort_impl(&state)
}

#[tauri::command(async)]
fn pull(mode: PullMode, state: State<RepoState>) -> Result<String, String> {
    pull_impl(&state, mode)
}

#[tauri::command(async)]
fn push(state: State<RepoState>) -> Result<String, String> {
    push_impl(&state)
}

#[tauri::command(async)]
fn push_force(state: State<RepoState>) -> Result<String, String> {
    push_force_impl(&state)
}

#[tauri::command(async)]
fn stash(state: State<RepoState>) -> Result<String, String> {
    stash_impl(&state)
}

#[tauri::command(async)]
fn stash_pop(state: State<RepoState>) -> Result<String, String> {
    stash_pop_impl(&state)
}

#[tauri::command(async)]
fn stash_apply(index: usize, drop: bool, state: State<RepoState>) -> Result<String, String> {
    stash_apply_impl(&state, index, drop)
}

#[tauri::command(async)]
fn stash_drop(index: usize, state: State<RepoState>) -> Result<String, String> {
    stash_drop_impl(&state, index)
}

#[tauri::command(async)]
fn stash_rename(index: usize, message: String, state: State<RepoState>) -> Result<String, String> {
    stash_rename_impl(&state, index, message)
}

#[tauri::command(async)]
fn save_stash_patch(index: usize, path: String, state: State<RepoState>) -> Result<String, String> {
    save_stash_patch_impl(&state, index, path)
}

#[tauri::command(async)]
fn discard_files(paths: Vec<String>, state: State<RepoState>) -> Result<(), String> {
    discard_files_impl(&state, paths)
}

#[tauri::command(async)]
fn stash_files(paths: Vec<String>, state: State<RepoState>) -> Result<String, String> {
    stash_files_impl(&state, paths)
}

#[tauri::command(async)]
fn save_files_patch(
    paths: Vec<String>,
    staged: bool,
    path: String,
    state: State<RepoState>,
) -> Result<String, String> {
    save_files_patch_impl(&state, paths, staged, path)
}

#[tauri::command(async)]
fn add_to_gitignore(paths: Vec<String>, state: State<RepoState>) -> Result<usize, String> {
    add_to_gitignore_impl(&state, paths)
}

#[tauri::command(async)]
fn reveal_path(path: String, state: State<RepoState>) -> Result<(), String> {
    reveal_path_impl(&state, path)
}

#[tauri::command(async)]
fn workspace_snapshot(state: State<RepoState>) -> Result<WorkspaceSnapshot, String> {
    workspace_snapshot_impl(&state)
}

#[tauri::command(async)]
fn open_in_editor(path: String, state: State<RepoState>) -> Result<(), String> {
    open_in_editor_impl(&state, path)
}

#[tauri::command(async)]
fn read_dotfile(kind: DotfileKind) -> Result<String, String> {
    read_dotfile_impl(kind)
}

#[tauri::command(async)]
fn write_dotfile(kind: DotfileKind, content: String) -> Result<(), String> {
    write_dotfile_impl(kind, content)
}

#[tauri::command(async)]
fn conflict_status(state: State<RepoState>) -> Result<ConflictStatus, String> {
    conflict_status_impl(&state)
}

#[tauri::command(async)]
fn conflict_sides(path: String, state: State<RepoState>) -> Result<ConflictSides, String> {
    conflict_sides_impl(&state, path)
}

#[tauri::command(async)]
fn resolve_conflict(path: String, content: String, state: State<RepoState>) -> Result<(), String> {
    resolve_conflict_impl(&state, path, content)
}

#[tauri::command(async)]
fn resolve_conflict_side(path: String, ours: bool, state: State<RepoState>) -> Result<(), String> {
    resolve_conflict_side_impl(&state, path, ours)
}

#[tauri::command(async)]
fn abort_conflict(state: State<RepoState>) -> Result<String, String> {
    abort_conflict_impl(&state)
}

#[tauri::command(async)]
fn finish_conflict(message: String, state: State<RepoState>) -> Result<String, String> {
    finish_conflict_impl(&state, message)
}

#[tauri::command(async)]
fn get_commit_tree(rev: String, state: State<RepoState>) -> Result<Vec<String>, String> {
    get_commit_tree_impl(&state, rev)
}

#[tauri::command(async)]
fn get_blame(rev: String, path: String, state: State<RepoState>) -> Result<Vec<BlameLine>, String> {
    get_blame_impl(&state, rev, path)
}

#[tauri::command(async)]
fn get_file_history(
    rev: String,
    path: String,
    state: State<RepoState>,
) -> Result<Vec<FileCommit>, String> {
    get_file_history_impl(&state, rev, path)
}

#[tauri::command(async)]
fn get_config(state: State<RepoState>) -> Result<Vec<ConfigEntry>, String> {
    get_config_impl(&state)
}

#[tauri::command(async)]
fn set_config(
    scope: ConfigScope,
    name: String,
    value: String,
    state: State<RepoState>,
) -> Result<(), String> {
    set_config_impl(&state, scope, name, value)
}

/// Open the OS file manager with `full` selected (macOS Finder / Windows
/// Explorer), falling back to opening its parent directory elsewhere.
fn reveal_in_file_manager(full: &std::path::Path) -> Result<(), String> {
    use std::process::Command;
    let spawn = |mut cmd: Command| cmd.spawn().map(|_| ()).map_err(to_message);
    if cfg!(target_os = "macos") {
        let mut cmd = Command::new("open");
        cmd.arg("-R").arg(full);
        spawn(cmd)
    } else if cfg!(target_os = "windows") {
        let mut cmd = Command::new("explorer");
        cmd.arg(format!("/select,{}", full.display()));
        spawn(cmd)
    } else {
        let dir = full.parent().unwrap_or(full);
        let mut cmd = Command::new("xdg-open");
        cmd.arg(dir);
        spawn(cmd)
    }
}

/// Open `full` with the OS default application for its file type.
fn open_in_default_app(full: &std::path::Path) -> Result<(), String> {
    use std::process::Command;
    let spawn = |mut cmd: Command| cmd.spawn().map(|_| ()).map_err(to_message);
    if cfg!(target_os = "macos") {
        let mut cmd = Command::new("open");
        cmd.arg(full);
        spawn(cmd)
    } else if cfg!(target_os = "windows") {
        let mut cmd = Command::new("explorer");
        cmd.arg(full);
        spawn(cmd)
    } else {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(full);
        spawn(cmd)
    }
}

/// Build and run the desktop app.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(RepoState::default())
        .manage(TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            open_repo,
            list_repos,
            activate_repo,
            close_repo,
            get_log_page,
            search_log,
            log_index_of,
            get_commit_detail,
            get_refs,
            get_working_changes,
            get_status,
            get_status_summary,
            get_file_diff,
            stage,
            unstage,
            stage_hunk,
            unstage_hunk,
            discard_hunk,
            stage_all,
            unstage_all,
            undo_state,
            undo,
            redo,
            commit_changes,
            checkout_branch,
            checkout_remote,
            create_branch,
            checkout_commit,
            create_branch_at,
            create_tag_at,
            history_fingerprint,
            tag_detail,
            push_tag,
            delete_tag,
            delete_remote_tag,
            remote_tag_exists,
            cherry_pick,
            revert,
            reset,
            rebase_onto,
            rename_branch,
            rename_remote_branch,
            create_backup_branch,
            delete_branch,
            delete_remote_branch,
            remote_branch_exists,
            merge_branch,
            push_branch,
            fetch_branch,
            fetch_all,
            fetch_remote,
            gone_branches,
            delete_branches,
            fetch_and_update_branch,
            fast_forward_branch,
            set_upstream,
            unset_upstream,
            create_pull_request,
            get_rebase_todo,
            interactive_rebase,
            rebase_status,
            rebase_continue,
            rebase_skip,
            rebase_abort,
            pull,
            push,
            push_force,
            stash,
            stash_pop,
            stash_apply,
            stash_drop,
            stash_rename,
            save_stash_patch,
            discard_files,
            stash_files,
            save_files_patch,
            add_to_gitignore,
            reveal_path,
            workspace_snapshot,
            open_in_editor,
            read_dotfile,
            write_dotfile,
            conflict_status,
            conflict_sides,
            resolve_conflict,
            resolve_conflict_side,
            abort_conflict,
            finish_conflict,
            get_commit_tree,
            get_blame,
            get_file_history,
            get_config,
            set_config,
            terminal::terminal_spawn,
            terminal::terminal_write,
            terminal::terminal_resize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running gitp");
}

#[cfg(test)]
mod tests {
    use super::{
        activate_repo_impl, close_repo_impl, commit_changes_impl, delete_branches_impl,
        get_commit_detail_impl, get_log_page_impl, history_fingerprint_impl, list_repos_impl,
        log_index_of_impl,
        create_tag_at_impl, delete_tag_impl, open_repo_impl, redo_impl, stage_all_impl,
        stage_impl, undo_impl, undo_state_impl, unstage_impl,
        workspace_snapshot_impl, RepoState,
    };
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed");
    }

    /// Build a temp repo whose commits each rewrite `f.txt`.
    fn make_repo(dir: &Path, messages: &[&str]) {
        git(dir, &["init", "-q"]);
        git(dir, &["config", "user.email", "t@t.io"]);
        git(dir, &["config", "user.name", "Tester"]);
        for (i, msg) in messages.iter().enumerate() {
            std::fs::write(dir.join("f.txt"), format!("line {i}\n")).unwrap();
            git(dir, &["add", "f.txt"]);
            git(dir, &["commit", "-q", "-m", msg]);
        }
    }

    #[test]
    fn switching_repos_shows_the_new_repos_commits_and_diffs() {
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();
        make_repo(dir_a.path(), &["a1", "a2", "a3"]); // 3 commits
        make_repo(dir_b.path(), &["b1", "b2", "b3", "b4", "b5"]); // 5 commits

        // One long-lived state, like the running app: open A, then switch to B.
        let state = RepoState::default();

        open_repo_impl(&state, dir_a.path().to_str().unwrap().to_string()).expect("open A");
        let log_a = get_log_page_impl(&state, 0, 1000, true).expect("log A");
        assert_eq!(log_a.total, 3, "repo A has 3 commits");
        let detail_a = get_commit_detail_impl(&state, log_a.rows[0].id.clone()).expect("detail A");
        assert!(!detail_a.files.is_empty(), "A's head commit has changes");

        // The switch that was reported broken.
        open_repo_impl(&state, dir_b.path().to_str().unwrap().to_string()).expect("open B");
        let log_b = get_log_page_impl(&state, 0, 1000, true).expect("log B");
        assert_eq!(log_b.total, 5, "after switching, log shows repo B's 5 commits");
        let detail_b = get_commit_detail_impl(&state, log_b.rows[0].id.clone()).expect("detail B");
        assert!(
            !detail_b.files.is_empty(),
            "B's head commit changes should show after switching repos"
        );
        assert_eq!(detail_b.summary, "b5");
    }

    #[test]
    fn paging_returns_consistent_slices_over_the_cached_log() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1", "c2", "c3", "c4", "c5"]); // 5 commits, newest c5

        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        let p0 = get_log_page_impl(&state, 0, 2, true).expect("page 0");
        assert_eq!(p0.total, 5);
        assert_eq!(p0.rows.len(), 2);
        assert_eq!(p0.rows[0].summary, "c5", "newest first");

        let p1 = get_log_page_impl(&state, 2, 2, true).expect("page 1");
        assert_eq!(p1.rows.len(), 2);
        assert_eq!(p1.rows[0].summary, "c3");

        // Pages are contiguous, non-overlapping slices of one cached walk.
        let p2 = get_log_page_impl(&state, 4, 2, true).expect("page 2");
        assert_eq!(p2.rows.len(), 1, "last partial page");
        assert_eq!(p2.rows[0].summary, "c1");

        let past_end = get_log_page_impl(&state, 10, 2, true).expect("past end");
        assert!(past_end.rows.is_empty());
        assert_eq!(past_end.total, 5);
    }

    #[test]
    fn multiple_repos_open_as_tabs_and_can_be_switched_and_closed() {
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();
        make_repo(dir_a.path(), &["a1", "a2"]); // 2 commits
        make_repo(dir_b.path(), &["b1", "b2", "b3"]); // 3 commits
        let path_a = dir_a.path().to_str().unwrap().to_string();
        let path_b = dir_b.path().to_str().unwrap().to_string();

        let state = RepoState::default();
        open_repo_impl(&state, path_a.clone()).expect("open A");
        let ws = open_repo_impl(&state, path_b.clone()).expect("open B");
        // Both repos are open as tabs; the most recently opened is active.
        assert_eq!(ws.repos.len(), 2);
        assert_eq!(ws.active, Some(1));
        assert_eq!(get_log_page_impl(&state, 0, 100, true).unwrap().total, 3, "active is B");

        // Re-opening an already-open repo just switches to it (no duplicate tab).
        let ws = open_repo_impl(&state, path_a.clone()).expect("reopen A");
        assert_eq!(ws.repos.len(), 2);
        assert_eq!(ws.active, Some(0));
        assert_eq!(get_log_page_impl(&state, 0, 100, true).unwrap().total, 2, "active is A");

        // Switch explicitly, then close the active tab.
        activate_repo_impl(&state, path_b.clone()).expect("activate B");
        assert_eq!(get_log_page_impl(&state, 0, 100, true).unwrap().total, 3);
        let ws = close_repo_impl(&state, path_b).expect("close B");
        assert_eq!(ws.repos.len(), 1);
        assert_eq!(ws.repos[0].path, path_a);
        assert_eq!(get_log_page_impl(&state, 0, 100, true).unwrap().total, 2, "fell back to A");

        // Closing the last repo leaves no active tab.
        let ws = close_repo_impl(&state, path_a).expect("close A");
        assert!(ws.repos.is_empty());
        assert_eq!(ws.active, None);
        assert!(list_repos_impl(&state).unwrap().repos.is_empty());
    }

    // --- cache invalidation ------------------------------------------------
    //
    // The log, the ref tree and `git status` are all cached now (see Session).
    // These pin the cases where a cache must NOT be served, since a stale one
    // shows the user the wrong repository state rather than merely being slow.

    #[test]
    fn a_new_commit_shows_up_without_an_explicit_log_invalidation() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1", "c2"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        assert_eq!(get_log_page_impl(&state, 0, 100, true).unwrap().total, 2);

        // Commit through the app: nothing clears the cached log by hand any
        // more, so this only works if the state fingerprint notices HEAD moved.
        std::fs::write(dir.path().join("f.txt"), "new\n").unwrap();
        git(dir.path(), &["add", "f.txt"]);
        commit_changes_impl(&state, "c3".into(), String::new(), false).expect("commit");

        let page = get_log_page_impl(&state, 0, 100, true).unwrap();
        assert_eq!(page.total, 3, "the new commit must appear");
        assert_eq!(page.rows[0].summary, "c3");
    }

    #[test]
    fn a_commit_made_outside_the_app_still_shows_up() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");
        assert_eq!(get_log_page_impl(&state, 0, 100, true).unwrap().total, 1);

        // The embedded terminal, or any other git client, moving HEAD behind
        // our back: no command of ours ran, so only the fingerprint can catch it.
        std::fs::write(dir.path().join("f.txt"), "outside\n").unwrap();
        git(dir.path(), &["add", "f.txt"]);
        git(dir.path(), &["commit", "-q", "-m", "outside"]);

        assert_eq!(get_log_page_impl(&state, 0, 100, true).unwrap().total, 2);
    }

    #[test]
    fn checking_out_a_branch_at_the_same_commit_still_updates_head() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");
        let before = workspace_snapshot_impl(&state).expect("snapshot").refs;

        // `side` points at the very same commit, so every ref oid is unchanged —
        // only HEAD's *name* moves. The fingerprint hashes that name for
        // exactly this case.
        git(dir.path(), &["checkout", "-q", "-b", "side"]);
        let after = workspace_snapshot_impl(&state).expect("snapshot").refs;

        assert_ne!(before.head, after.head);
        assert_eq!(after.head.as_deref(), Some("side"));
    }

    #[test]
    fn staging_is_reflected_in_the_very_next_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        std::fs::write(dir.path().join("f.txt"), "edited\n").unwrap();
        let before = workspace_snapshot_impl(&state).expect("snapshot");
        assert_eq!(before.status.staged.len(), 0);
        assert_eq!(before.status.unstaged.len(), 1);

        // No sleep: this is the race the `.git/index` stamp exists to close.
        // The filesystem watcher takes ~12ms to deliver, far longer than the
        // gap between these two calls in the running app.
        stage_impl(&state, "f.txt".into()).expect("stage");
        let staged = workspace_snapshot_impl(&state).expect("snapshot");
        assert_eq!(staged.status.staged.len(), 1, "staging must show immediately");
        assert_eq!(staged.status.unstaged.len(), 0);

        unstage_impl(&state, "f.txt".into()).expect("unstage");
        let unstaged = workspace_snapshot_impl(&state).expect("snapshot");
        assert_eq!(unstaged.status.staged.len(), 0, "unstaging must show immediately");
        assert_eq!(unstaged.status.unstaged.len(), 1);
    }

    #[test]
    fn staging_done_outside_the_app_shows_up_in_the_next_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        std::fs::write(dir.path().join("f.txt"), "edited\n").unwrap();
        let before = workspace_snapshot_impl(&state).expect("snapshot");
        assert_eq!(before.status.staged.len(), 0);
        assert_eq!(before.status.unstaged.len(), 1);
        // That snapshot populated the status cache — the point of what follows.

        // Another git client (a terminal, an IDE, another GUI) stages the file.
        // No command of ours ran, so the dirty flag may not have been raised
        // yet; the `.git/index` stamp is what has to catch this.
        git(dir.path(), &["add", "f.txt"]);

        let after = workspace_snapshot_impl(&state).expect("snapshot");
        assert_eq!(after.status.staged.len(), 1, "an outside stage must not be served from cache");
        assert_eq!(after.status.unstaged.len(), 0);

        // ...and the same on the way back out.
        git(dir.path(), &["reset", "-q", "HEAD", "f.txt"]);
        let reset = workspace_snapshot_impl(&state).expect("snapshot");
        assert_eq!(reset.status.staged.len(), 0, "an outside unstage must not be served from cache");
        assert_eq!(reset.status.unstaged.len(), 1);
    }

    // The history fingerprint is what lets the frontend skip pulling a whole
    // page to find out nothing changed. It has to be stable when history is
    // stable, and move whenever a page fetch could return something different —
    // it guards the same cache `ensure_log` guards, so those are the same thing.
    #[test]
    fn history_fingerprint_is_stable_until_history_actually_moves() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1", "c2"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        let base = history_fingerprint_impl(&state).expect("fingerprint");
        assert_eq!(base, history_fingerprint_impl(&state).unwrap(), "stable when nothing happens");

        // Reading the log must not disturb it either.
        get_log_page_impl(&state, 0, 100, true).unwrap();
        assert_eq!(base, history_fingerprint_impl(&state).unwrap(), "reads don't move it");

        // A new commit must move it, or the frontend would keep showing stale history.
        std::fs::write(dir.path().join("f.txt"), "new\n").unwrap();
        git(dir.path(), &["add", "f.txt"]);
        commit_changes_impl(&state, "c3".into(), String::new(), false).expect("commit");
        let after_commit = history_fingerprint_impl(&state).unwrap();
        assert_ne!(base, after_commit, "a new commit must be visible to the guard");

        // So must a branch created behind our back, which adds rows in all-branches mode.
        git(dir.path(), &["branch", "sidebar-branch"]);
        assert_ne!(
            after_commit,
            history_fingerprint_impl(&state).unwrap(),
            "an outside ref change must be visible to the guard"
        );
    }

    // --- undo/redo wiring ---------------------------------------------------
    //
    // The core tests cover whether a recorded action reverses correctly. These
    // cover the half that the buttons actually depend on: that the operation
    // records anything at all, with a label, and that undo/redo through the
    // command layer put the repository back.

    fn staged_paths(state: &RepoState) -> Vec<String> {
        let mut v: Vec<String> = workspace_snapshot_impl(state)
            .unwrap()
            .status
            .staged
            .into_iter()
            .map(|f| f.path)
            .collect();
        v.sort();
        v
    }

    #[test]
    fn staging_a_file_is_undoable_through_the_command_layer() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        std::fs::write(dir.path().join("f.txt"), "new\n").unwrap();
        assert!(staged_paths(&state).is_empty());

        stage_impl(&state, "f.txt".into()).expect("stage");
        assert_eq!(staged_paths(&state), vec!["f.txt".to_string()]);

        let view = undo_state_impl(&state).unwrap();
        assert_eq!(view.undo.as_deref(), Some("Stage"), "the button has something to offer");

        undo_impl(&state).expect("undo");
        assert!(staged_paths(&state).is_empty(), "undo unstaged it");
        // And the snapshot the UI reads must reflect it, not a cached status.
        assert_eq!(undo_state_impl(&state).unwrap().redo.as_deref(), Some("Stage"));

        redo_impl(&state).expect("redo");
        assert_eq!(staged_paths(&state), vec!["f.txt".to_string()], "redo staged it again");
    }

    #[test]
    fn undoing_stage_all_restores_the_partial_selection() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        std::fs::write(dir.path().join("a.txt"), "a\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "b\n").unwrap();
        stage_impl(&state, "a.txt".into()).expect("stage a");
        assert_eq!(staged_paths(&state), vec!["a.txt".to_string()]);

        stage_all_impl(&state).expect("stage all");
        assert_eq!(staged_paths(&state), vec!["a.txt".to_string(), "b.txt".to_string()]);

        undo_impl(&state).expect("undo");
        assert_eq!(
            staged_paths(&state),
            vec!["a.txt".to_string()],
            "back to the partial selection, not to nothing staged"
        );
    }

    #[test]
    fn an_operation_that_changes_nothing_records_no_undo() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        // Nothing to stage: the index doesn't move, so the Undo button must not
        // light up offering to reverse a no-op.
        stage_all_impl(&state).expect("stage all on a clean tree");
        assert_eq!(undo_state_impl(&state).unwrap().undo, None);
    }

    #[test]
    fn creating_and_deleting_a_tag_are_both_undoable() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");
        let head = get_log_page_impl(&state, 0, 1, true).unwrap().rows[0].id.clone();

        create_tag_at_impl(&state, "v1.0".into(), head).expect("tag");
        assert_eq!(undo_state_impl(&state).unwrap().undo.as_deref(), Some("Tag v1.0"));
        undo_impl(&state).expect("undo tag create");
        assert!(!tag_names(&state).contains(&"v1.0".to_string()), "tag removed");
        redo_impl(&state).expect("redo tag create");
        assert!(tag_names(&state).contains(&"v1.0".to_string()), "tag back");

        delete_tag_impl(&state, "v1.0".into()).expect("delete tag");
        assert!(!tag_names(&state).contains(&"v1.0".to_string()));
        assert_eq!(
            undo_state_impl(&state).unwrap().undo.as_deref(),
            Some("Delete tag v1.0")
        );
        undo_impl(&state).expect("undo tag delete");
        assert!(tag_names(&state).contains(&"v1.0".to_string()), "delete undone");
    }

    fn tag_names(state: &RepoState) -> Vec<String> {
        workspace_snapshot_impl(state)
            .unwrap()
            .refs
            .tags
            .into_iter()
            .map(|t| t.name)
            .collect()
    }

    // --- locating a commit in the log --------------------------------------
    //
    // The frontend holds only the newest page of the log, so a sidebar click on
    // a tag or an older branch has nothing on screen to scroll to. Measured on
    // a real 20k-commit repository, only 13 of 56 branches and tags were inside
    // the first 1000 rows — the other 42 were as deep as row 6649. These pin
    // the lookup that lets the frontend load down to them.

    #[test]
    fn finds_the_row_of_a_commit_far_below_the_first_page() {
        let dir = tempfile::tempdir().unwrap();
        let msgs: Vec<String> = (0..40).map(|i| format!("c{i}")).collect();
        make_repo(dir.path(), &msgs.iter().map(String::as_str).collect::<Vec<_>>());
        // A tag on an old commit — the case that used to jump nowhere.
        git(dir.path(), &["tag", "old-release", "HEAD~30"]);

        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        let idx = log_index_of_impl(&state, "old-release".into(), true)
            .expect("lookup")
            .expect("the tag is in the log");
        assert_eq!(idx, 30, "log is newest-first, so HEAD~30 is row 30");

        // And it sits beyond a short page, so the frontend genuinely has to
        // fetch further before it has a row to scroll to.
        let first_page = get_log_page_impl(&state, 0, 10, true).unwrap();
        assert!(idx >= first_page.rows.len(), "should not be reachable from page one");
    }

    #[test]
    fn locates_a_commit_by_branch_name_short_id_or_full_id() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c0", "c1", "c2"]);
        git(dir.path(), &["branch", "side", "HEAD~1"]);

        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");
        let page = get_log_page_impl(&state, 0, 100, true).unwrap();
        let middle = &page.rows[1];

        for rev in [middle.id.clone(), middle.short_id.clone(), "side".to_string()] {
            assert_eq!(
                log_index_of_impl(&state, rev.clone(), true).expect("lookup"),
                Some(1),
                "{rev} should resolve to row 1"
            );
        }
    }

    #[test]
    fn reports_a_commit_that_is_not_in_the_graph_rather_than_failing() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c0", "c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        // A real commit, but on no branch — the sidebar can hold a tag like this.
        git(dir.path(), &["checkout", "-q", "--detach"]);
        std::fs::write(dir.path().join("f.txt"), "orphan\n").unwrap();
        git(dir.path(), &["add", "f.txt"]);
        git(dir.path(), &["commit", "-q", "-m", "orphan"]);
        let orphan = String::from_utf8(
            std::process::Command::new("git")
                .current_dir(dir.path())
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        git(dir.path(), &["checkout", "-q", "-"]);

        // HEAD-only mode can't see it, and that's a `None`, not an error: the
        // caller shows the commit's detail and says it isn't in this graph.
        assert_eq!(
            log_index_of_impl(&state, orphan.trim().to_string(), false).expect("lookup"),
            None
        );
        // A rev that doesn't resolve at all is a genuine error.
        assert!(log_index_of_impl(&state, "no-such-ref".into(), true).is_err());
    }

    // --- undoing a bulk delete ---------------------------------------------
    //
    // Undo is single-level. Clean up can remove dozens of branches at once, so
    // recording them one at a time would leave exactly one recoverable — the
    // more an action destroys, the worse that gets. These pin the batch being
    // one undoable unit.

    /// The checked-out branch. `git init`'s default name depends on the host's
    /// `init.defaultBranch`, so tests must ask rather than assume "master".
    fn head_branch(dir: &Path) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .output()
            .expect("rev-parse");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn branch_names(dir: &Path) -> Vec<String> {
        let out = Command::new("git")
            .current_dir(dir)
            .args(["for-each-ref", "--format=%(refname:short)", "refs/heads"])
            .output()
            .expect("for-each-ref");
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::to_string)
            .collect()
    }

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
        let names = vec!["gone-a".to_string(), "gone-b".to_string(), "gone-c".to_string()];
        let result = delete_branches_impl(&state, names, true).expect("delete");
        assert!(result.failed.is_empty());
        for name in ["gone-a", "gone-b", "gone-c"] {
            assert!(!branch_names(dir.path()).contains(&name.to_string()), "{name} deleted");
        }

        // The toolbar's Undo button is driven by this, so it has to be armed and
        // to name the whole batch — not just the last branch.
        let undo = undo_state_impl(&state).expect("undo state");
        assert_eq!(undo.undo.as_deref(), Some("Delete 3 branches"));

        undo_impl(&state).expect("undo");
        assert_eq!(branch_names(dir.path()), before, "all three come back, at their tips");
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
        assert_eq!(restored.trim(), tip, "restored at exactly the commit it pointed at");
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
        let result = delete_branches_impl(
            &state,
            vec![current.clone(), "doomed".to_string()],
            true,
        )
        .expect("batch should not abort on one failure");
        assert_eq!(result.failed, vec![current.clone()]);
        assert!(branch_names(dir.path()).contains(&current), "and it survives");
        assert!(!branch_names(dir.path()).contains(&"doomed".to_string()));

        // Undo restores only what actually went.
        undo_impl(&state).expect("undo");
        assert!(branch_names(dir.path()).contains(&"doomed".to_string()));
    }
}
