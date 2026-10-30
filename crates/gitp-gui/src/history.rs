//! Reading history: the paged commit log and its search, commit details and
//! diffs, the ref tree, and per-file tree / blame / history / content.

use gitp_core::{
    BlameLine, CommitDetail, CommitRow, CommitSignature, FileCommit, FileContent, FileDiff,
    FileSide, LogScope, LogSearch, Refs, Repo, PREVIEW_MAX_BYTES,
};
use serde::Serialize;
use tauri::State;

use crate::state::{ensure_log, ensure_refs, to_message, with_repo, with_repo_unlocked, RepoState};

/// A page of log rows plus the total count, so the frontend knows when to stop.
#[derive(Serialize)]
pub(crate) struct LogPage {
    pub(crate) rows: Vec<CommitRow>,
    pub(crate) total: usize,
    /// HEAD's commit, where the graph hangs its WIP row. `None` on an unborn
    /// branch. Sent with the page rather than read from the refs because a
    /// detached HEAD has no branch to read it from.
    pub(crate) head: Option<String>,
}

/// Return the `[offset, offset+limit)` slice of the active repo's log, computing
/// and caching the full log on first use so lanes are consistent across pages.
/// `scope` is the history toggle (a bare bool) plus the graph settings.
pub(crate) fn get_log_page_impl(
    state: &RepoState,
    offset: usize,
    limit: usize,
    scope: impl Into<LogScope>,
) -> Result<LogPage, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let log = ensure_log(session, &scope.into())?;
    let total = log.len();
    let end = offset.saturating_add(limit).min(total);
    let rows = log.get(offset..end).map(<[_]>::to_vec).unwrap_or_default();
    let head = session.repo.resolve_commit("HEAD").ok();
    Ok(LogPage { rows, total, head })
}

/// A cheap stand-in for "has history changed?", for callers that would
/// otherwise pull a whole page just to compare it.
///
/// This is the same fingerprint `ensure_log` uses to decide whether its own
/// cache is stale, so if it hasn't moved, a page fetch cannot return anything
/// new. Hex rather than the raw u64: JSON numbers are f64, which cannot hold a
/// 64-bit hash without silently rounding two different states together.
fn history_fingerprint_impl(state: &RepoState) -> Result<String, String> {
    with_repo(state, |repo| {
        repo.state_fingerprint().map(|f| format!("{f:x}"))
    })
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
    scope: impl Into<LogScope>,
) -> Result<Option<usize>, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let id = session.repo.resolve_commit(&rev).map_err(to_message)?;
    let log = ensure_log(session, &scope.into())?;
    Ok(log.iter().position(|row| row.id == id))
}

/// Commits matching a search query — GitKraken-style commit search over the
/// full loaded graph, in log order. Bare words match the message, author or
/// id; `author:`, `path:`, `content:`, `after:` and `before:` narrow it (see
/// `gitp_core::LogSearch`). A blank query returns nothing (the frontend shows
/// the normal paged log instead).
fn search_log_impl(
    state: &RepoState,
    query: String,
    scope: impl Into<LogScope>,
) -> Result<Vec<CommitRow>, String> {
    let scope = scope.into();
    let mut search = LogSearch::parse(&query);
    if search.is_empty() {
        return Ok(Vec::new());
    }
    let path = {
        let guard = state.0.lock().map_err(to_message)?;
        let idx = guard.active.ok_or("no repository is open")?;
        guard.sessions[idx].path.clone()
    };
    // `path:` and `content:` run `git log` over the whole history — seconds on
    // a big repo — so, like a fetch, they run without the workspace lock on a
    // handle of their own (see `with_repo_networked`).
    if search.needs_git() {
        let repo = Repo::open(&path).map_err(to_message)?;
        repo.run_log_search_filters(&mut search, scope.all_branches)
            .map_err(to_message)?;
    }
    // Re-found by path: the user may have switched or closed tabs meanwhile.
    let mut guard = state.0.lock().map_err(to_message)?;
    let Some(session) = guard.sessions.iter_mut().find(|s| s.path == path) else {
        return Ok(Vec::new());
    };
    ensure_log(session, &scope)?;
    let cache = session.log.as_mut().expect("ensure_log fills the cache");
    session
        .repo
        .search_log(cache, &mut search)
        .map_err(to_message)
}

pub(crate) fn get_commit_detail_impl(
    state: &RepoState,
    rev: String,
) -> Result<CommitDetail, String> {
    with_repo(state, |repo| repo.commit_detail(&rev))
}

/// The signature on `rev` and whether it verifies; `None` when unsigned. A
/// request of its own, separate from the detail, because verifying runs gpg /
/// ssh-keygen — so it runs without the workspace lock (see
/// `with_repo_unlocked`), and a slow verifier never stalls other commands.
fn get_commit_signature_impl(
    state: &RepoState,
    rev: String,
) -> Result<Option<CommitSignature>, String> {
    with_repo_unlocked(state, |repo| repo.commit_signature(&rev))
}

fn get_commit_file_diff_impl(
    state: &RepoState,
    rev: String,
    path: String,
    old_path: Option<String>,
    context_lines: u32,
    ignore_whitespace: bool,
    full: bool,
) -> Result<Option<FileDiff>, String> {
    with_repo(state, |repo| {
        repo.commit_file_diff_with(
            &rev,
            &path,
            old_path.as_deref(),
            context_lines,
            ignore_whitespace,
            crate::staging::diff_cap(full),
        )
    })
}

/// `path` as it is on `side` (a revision, the index or the working tree), for
/// the image diff — capped at PREVIEW_MAX_BYTES. Shared by the commit detail
/// and Local Changes.
fn get_file_content_impl(
    state: &RepoState,
    side: FileSide,
    path: String,
) -> Result<Option<FileContent>, String> {
    with_repo(state, |repo| {
        repo.file_content(&side, &path, PREVIEW_MAX_BYTES)
    })
}

fn get_refs_impl(state: &RepoState) -> Result<Refs, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    ensure_refs(&mut guard.sessions[idx])
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

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn get_log_page(
    offset: usize,
    limit: usize,
    scope: LogScope,
    state: State<RepoState>,
) -> Result<LogPage, String> {
    get_log_page_impl(&state, offset, limit, scope)
}

#[tauri::command(async)]
pub(crate) fn log_index_of(
    rev: String,
    scope: LogScope,
    state: State<RepoState>,
) -> Result<Option<usize>, String> {
    log_index_of_impl(&state, rev, scope)
}

#[tauri::command(async)]
pub(crate) fn search_log(
    query: String,
    scope: LogScope,
    state: State<RepoState>,
) -> Result<Vec<CommitRow>, String> {
    search_log_impl(&state, query, scope)
}

#[tauri::command(async)]
pub(crate) fn get_commit_detail(
    rev: String,
    state: State<RepoState>,
) -> Result<CommitDetail, String> {
    get_commit_detail_impl(&state, rev)
}

#[tauri::command(async)]
pub(crate) fn get_commit_signature(
    rev: String,
    state: State<RepoState>,
) -> Result<Option<CommitSignature>, String> {
    get_commit_signature_impl(&state, rev)
}

#[tauri::command(async)]
pub(crate) fn get_commit_file_diff(
    rev: String,
    path: String,
    old_path: Option<String>,
    context_lines: u32,
    ignore_whitespace: bool,
    full: bool,
    state: State<RepoState>,
) -> Result<Option<FileDiff>, String> {
    get_commit_file_diff_impl(
        &state,
        rev,
        path,
        old_path,
        context_lines,
        ignore_whitespace,
        full,
    )
}

#[tauri::command(async)]
pub(crate) fn get_file_content(
    side: FileSide,
    path: String,
    state: State<RepoState>,
) -> Result<Option<FileContent>, String> {
    get_file_content_impl(&state, side, path)
}

#[tauri::command(async)]
pub(crate) fn get_refs(state: State<RepoState>) -> Result<Refs, String> {
    get_refs_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn history_fingerprint(state: State<RepoState>) -> Result<String, String> {
    history_fingerprint_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn get_commit_tree(rev: String, state: State<RepoState>) -> Result<Vec<String>, String> {
    get_commit_tree_impl(&state, rev)
}

#[tauri::command(async)]
pub(crate) fn get_blame(
    rev: String,
    path: String,
    state: State<RepoState>,
) -> Result<Vec<BlameLine>, String> {
    get_blame_impl(&state, rev, path)
}

#[tauri::command(async)]
pub(crate) fn get_file_history(
    rev: String,
    path: String,
    state: State<RepoState>,
) -> Result<Vec<FileCommit>, String> {
    get_file_history_impl(&state, rev, path)
}

#[cfg(test)]
mod tests {
    use super::{get_log_page_impl, history_fingerprint_impl, log_index_of_impl, search_log_impl};
    use crate::staging::commit_changes_impl;
    use crate::state::RepoState;
    use crate::test_support::{git, head_branch, make_repo};
    use crate::workspace::open_repo_impl;
    use gitp_core::LogScope;

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
        // The WIP row hangs off HEAD, which here is the newest commit.
        assert_eq!(p0.head.as_deref(), Some(p0.rows[0].id.as_str()));

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

    // Pinning a branch re-lays the cached log's lanes, whichever branch it is.
    #[test]
    fn a_pinned_branch_takes_lane_zero_in_the_page() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        git(dir.path(), &["checkout", "-q", "-b", "side"]);
        std::fs::write(dir.path().join("side.txt"), "s\n").unwrap();
        git(dir.path(), &["add", "side.txt"]);
        git(dir.path(), &["commit", "-q", "-m", "on side"]);
        git(dir.path(), &["checkout", "-q", "-"]);
        std::fs::write(dir.path().join("main.txt"), "m\n").unwrap();
        git(dir.path(), &["add", "main.txt"]);
        git(dir.path(), &["commit", "-q", "-m", "on main"]);

        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");
        let lanes = |pin: String| {
            let scope = LogScope {
                all_branches: true,
                pinned: Some(pin),
                ..LogScope::default()
            };
            let page = get_log_page_impl(&state, 0, 10, scope).unwrap();
            let lane = |s: &str| page.rows.iter().find(|r| r.summary == s).unwrap().lane;
            (lane("on side"), lane("on main"))
        };
        let (side, main) = lanes("side".into());
        assert!(side == 0 && main != 0, "side pinned: {side} {main}");
        let (side, main) = lanes(head_branch(dir.path()));
        assert!(main == 0 && side != 0, "main pinned: {side} {main}");
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
        assert_eq!(
            base,
            history_fingerprint_impl(&state).unwrap(),
            "stable when nothing happens"
        );

        // Reading the log must not disturb it either.
        get_log_page_impl(&state, 0, 100, true).unwrap();
        assert_eq!(
            base,
            history_fingerprint_impl(&state).unwrap(),
            "reads don't move it"
        );

        // A new commit must move it, or the frontend would keep showing stale history.
        std::fs::write(dir.path().join("f.txt"), "new\n").unwrap();
        git(dir.path(), &["add", "f.txt"]);
        commit_changes_impl(&state, "c3".into(), String::new(), false, None, false)
            .expect("commit");
        let after_commit = history_fingerprint_impl(&state).unwrap();
        assert_ne!(
            base, after_commit,
            "a new commit must be visible to the guard"
        );

        // So must a branch created behind our back, which adds rows in all-branches mode.
        git(dir.path(), &["branch", "sidebar-branch"]);
        assert_ne!(
            after_commit,
            history_fingerprint_impl(&state).unwrap(),
            "an outside ref change must be visible to the guard"
        );
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
        make_repo(
            dir.path(),
            &msgs.iter().map(String::as_str).collect::<Vec<_>>(),
        );
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
        assert!(
            idx >= first_page.rows.len(),
            "should not be reachable from page one"
        );
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

        for rev in [
            middle.id.clone(),
            middle.short_id.clone(),
            "side".to_string(),
        ] {
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

    // The git-backed terms run outside the workspace lock and are then applied
    // to the session's cached log: both halves have to meet up.
    #[test]
    fn search_combines_git_backed_terms_with_the_cached_log() {
        let dir = tempfile::tempdir().unwrap();
        // Not "c1": hex-looking words also match commit ids.
        make_repo(dir.path(), &["zero", "one", "two"]); // f.txt reads "line <i>"
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        let summaries = |query: &str| -> Vec<String> {
            search_log_impl(&state, query.into(), true)
                .expect("search")
                .into_iter()
                .map(|r| r.summary)
                .collect()
        };
        // "one" adds "line 1" and "two" removes it.
        assert_eq!(summaries(r#"content:"line 1""#), ["two", "one"]);
        assert_eq!(summaries(r#"content:"line 1" one"#), ["one"]);
        assert_eq!(summaries("path:f.txt author:tester").len(), 3);
        assert!(
            summaries("author:").is_empty(),
            "a bare key searches nothing"
        );
    }
}
