//! Session state: the open repositories, their cached reads (log, refs,
//! `git status`), and the `with_repo*` wrappers every command runs through.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use notify::RecommendedWatcher;

use gitp_core::{
    CommitRow, LogCache, NetworkHooks, Progress, ProgressFn, Refs, Repo, StatusLists, Undoable,
};
use serde::Serialize;

use crate::undo::clear_undo;
use crate::watch::ChangeSink;

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
pub(crate) struct Session {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) repo: Repo,
    /// The full log with the tips it was walked from, so a change that only
    /// adds history walks just the new commits (`Repo::refresh_log`).
    pub(crate) log: Option<LogCache>,
    /// Fingerprint the cached `log` was last brought up to date at.
    pub(crate) log_sig: u64,
    /// The sidebar's ref tree, with the fingerprint it was built at.
    pub(crate) refs_cache: Option<(u64, Refs)>,
    /// The last `git status` result, with the `.git/index` stamp it was taken
    /// at. Valid while the watcher is quiet *and* that stamp still holds.
    pub(crate) status_cache: Option<(Option<(u64, std::time::SystemTime)>, StatusLists)>,
    /// Raised by the filesystem watcher on any change under the working tree.
    /// `None` means no watcher could be started — then nothing is cached.
    pub(crate) worktree_dirty: Option<Arc<AtomicBool>>,
    /// Held only to keep the watcher alive for as long as the session is open.
    pub(crate) _watcher: Option<RecommendedWatcher>,
    /// Whether this is the active tab — only then does its watcher report
    /// changes to the frontend (see `watch::watch_worktree`).
    pub(crate) watch_live: Arc<AtomicBool>,
    /// The single most-recent reversible action (GitKraken-style single-level
    /// undo), and the action just undone that Redo would re-apply.
    pub(crate) undo: Option<Undoable>,
    pub(crate) redo: Option<Undoable>,
}

/// All open repositories plus which one is active. Commands that read a repo
/// (log, detail, config) operate on the active session.
#[derive(Default)]
pub(crate) struct Workspace {
    pub(crate) sessions: Vec<Session>,
    pub(crate) active: Option<usize>,
    /// Where watchers report changes on disk; set once the app is running
    /// (`None` in the command-layer tests).
    pub(crate) on_change: Option<ChangeSink>,
}

impl Workspace {
    /// Make tab `idx` the active one, and let only its watcher report changes.
    pub(crate) fn set_active(&mut self, idx: Option<usize>) {
        self.active = idx;
        for (i, session) in self.sessions.iter().enumerate() {
            session.watch_live.store(Some(i) == idx, Ordering::SeqCst);
        }
    }

    pub(crate) fn view(&self) -> WorkspaceView {
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

/// The set of open repositories (a workspace of tabs), and the network
/// operations running against them.
#[derive(Default)]
pub(crate) struct RepoState(pub(crate) Mutex<Workspace>, pub(crate) NetworkOps);

/// The network operations in flight — kept outside the workspace lock, which
/// they deliberately don't hold (see [`with_repo_networked`]) — so Cancel can
/// reach them, plus where their progress is sent.
#[derive(Default)]
pub(crate) struct NetworkOps {
    /// Each running operation's repo path and cancel flag.
    in_flight: Mutex<Vec<(String, Arc<AtomicBool>)>>,
    /// Sends a `git-progress` event to the frontend. Set once at startup; unset
    /// in tests, where progress simply goes nowhere.
    emit: OnceLock<Emit>,
}

type Emit = Arc<dyn Fn(ProgressEvent) + Send + Sync>;

/// The `git-progress` event payload: which operation (`"push"`, `"fetch"`, ...)
/// and git's phase / percentage / detail.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct ProgressEvent {
    pub(crate) op: &'static str,
    #[serde(flatten)]
    pub(crate) progress: Progress,
}

/// Git rewrites a meter on every percent, hundreds of times a second on a fast
/// link; ~10 events a second is as fast as anyone can read a number.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

impl NetworkOps {
    pub(crate) fn set_emitter(&self, emit: impl Fn(ProgressEvent) + Send + Sync + 'static) {
        let _ = self.emit.set(Arc::new(emit));
    }

    /// Register an operation on `path`, returning the flag that cancels it.
    fn begin(&self, path: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut ops) = self.in_flight.lock() {
            ops.push((path.to_string(), Arc::clone(&flag)));
        }
        flag
    }

    fn end(&self, flag: &Arc<AtomicBool>) {
        if let Ok(mut ops) = self.in_flight.lock() {
            ops.retain(|(_, f)| !Arc::ptr_eq(f, flag));
        }
    }

    /// Raise the cancel flag of every operation running on `path`.
    pub(crate) fn cancel(&self, path: &str) {
        if let Ok(ops) = self.in_flight.lock() {
            for (_, flag) in ops.iter().filter(|(p, _)| p == path) {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    /// A progress callback for `op` that forwards to the frontend, at most
    /// once per [`PROGRESS_INTERVAL`] — except a new phase, which always goes
    /// through so a short one isn't skipped entirely.
    fn reporter(&self, op: &'static str) -> Option<ProgressFn> {
        let emit = Arc::clone(self.emit.get()?);
        let last: Mutex<Option<(Instant, String)>> = Mutex::new(None);
        Some(Box::new(move |p: &Progress| {
            let Ok(mut last) = last.lock() else { return };
            let due = match &*last {
                Some((at, phase)) => *phase != p.phase || at.elapsed() >= PROGRESS_INTERVAL,
                None => true,
            };
            if due {
                *last = Some((Instant::now(), p.phase.clone()));
                emit(ProgressEvent {
                    op,
                    progress: p.clone(),
                });
            }
        }))
    }
}

/// One open repository as shown in the tab bar.
#[derive(Serialize, Clone)]
pub(crate) struct RepoTab {
    pub(crate) path: String,
    name: String,
}

/// The open repos and the active index — the frontend renders its tab bar from this.
#[derive(Serialize)]
pub(crate) struct WorkspaceView {
    pub(crate) repos: Vec<RepoTab>,
    pub(crate) active: Option<usize>,
}

pub(crate) fn to_message<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

/// Run `f` against the active repo, or return an error string if none is open.
pub(crate) fn with_repo<T>(
    state: &RepoState,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
) -> Result<T, String> {
    let guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    f(&guard.sessions[idx].repo).map_err(to_message)
}

/// Run a mutating `f` that undo does not track (abort/continue a session,
/// apply a stash, resolve a conflict, ...) against the active repo, then forget
/// the undo/redo slots: the operation may have moved HEAD, the index or the
/// working tree out from under whatever was recorded, and an armed Undo that
/// reverses something else is worse than none. Errors if no repository is open.
pub(crate) fn with_repo_clearing_undo<T>(
    state: &RepoState,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(to_message)?;
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let out = f(&session.repo).map_err(to_message)?;
    clear_undo(session);
    invalidate_status(session);
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
///
/// While it runs, git's progress goes out as `git-progress` events tagged
/// `op`, and `cancel_network_op` can stop it.
pub(crate) fn with_repo_networked<T>(
    state: &RepoState,
    op: &'static str,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
    after: impl FnOnce(&mut Session),
) -> Result<T, String> {
    with_repo_networked_prepared(state, op, |_| (), f, |session, ()| after(session))
}

/// [`with_repo_networked`] with a `prepare` step that reads from the session
/// under the *same* lock that selects it, handing its result to `after`. For
/// anything the op will change (pull moves HEAD), reading it in a separate lock
/// would let a tab switch in between pair another repo's value with this one.
pub(crate) fn with_repo_networked_prepared<P, T>(
    state: &RepoState,
    op: &'static str,
    prepare: impl FnOnce(&Session) -> P,
    f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
    after: impl FnOnce(&mut Session, P),
) -> Result<T, String> {
    let (path, prepared) = {
        let guard = state.0.lock().map_err(to_message)?;
        let idx = guard.active.ok_or("no repository is open")?;
        let session = &guard.sessions[idx];
        (session.path.clone(), prepare(session))
    }; // lock released here — before the network round trip
    let mut repo = Repo::open(&path).map_err(to_message)?;
    let cancel = state.1.begin(&path);
    repo.set_network_hooks(NetworkHooks {
        on_progress: state.1.reporter(op),
        cancel: Some(Arc::clone(&cancel)),
    });
    let out = f(&repo);
    state.1.end(&cancel);
    let out = out.map_err(to_message)?;
    {
        let mut guard = state.0.lock().map_err(to_message)?;
        if let Some(session) = guard.sessions.iter_mut().find(|s| s.path == path) {
            after(session, prepared);
        }
    }
    Ok(out)
}

/// The active session's full log, computing and caching it on first use so
/// lanes stay globally consistent across pages and searches. When the refs
/// move (or the all-branches toggle flips) the cache is refreshed — extended
/// with just the new commits where possible, re-walked otherwise.
pub(crate) fn ensure_log(
    session: &mut Session,
    all_branches: bool,
) -> Result<&[CommitRow], String> {
    let sig = session.repo.state_fingerprint().map_err(to_message)?;
    match &mut session.log {
        Some(cache) if session.log_sig == sig && cache.all_branches() == all_branches => {}
        Some(cache) => {
            session
                .repo
                .refresh_log(cache, all_branches)
                .map_err(to_message)?;
        }
        None => {
            let cache = session.repo.log_cache(all_branches).map_err(to_message)?;
            session.log = Some(cache);
        }
    }
    session.log_sig = sig;
    Ok(&session.log.as_ref().unwrap().rows)
}

/// The active session's ref tree, cached against the state fingerprint.
///
/// `refs()` walks every branch, tag and remote and runs a `graph_ahead_behind`
/// revwalk per tracked branch — ~40ms on a repo with 838 refs — and it's part
/// of every workspace snapshot, so it ran on every action and every background
/// poll. Nearly all of those leave the refs untouched.
pub(crate) fn ensure_refs(session: &mut Session) -> Result<Refs, String> {
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

/// The active session's staging lists, cached until the worktree changes.
///
/// `status_summary` shells out to `git status --porcelain -u all`, which has to
/// stat the whole working tree — ~110ms on a large repo, and it ran on every
/// snapshot: every action, every view switch, and the 60s background poll. The
/// filesystem watcher (see `watch::watch_worktree`) tells us when that's actually
/// worth redoing.
///
/// The dirty flag is cleared *before* the scan, so a write that lands while
/// `git status` is running marks the result stale rather than being swallowed.
/// With no watcher (the OS refused, or watch limits were hit) there's no cache
/// and every call scans, exactly as before.
pub(crate) fn ensure_status(session: &mut Session) -> Result<StatusLists, String> {
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
pub(crate) fn invalidate_status(session: &mut Session) {
    session.status_cache = None;
}

// --- Tauri commands --------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::RepoState;
    use crate::history::get_log_page_impl;
    use crate::staging::{commit_changes_impl, stage_impl, unstage_impl};
    use crate::test_support::{git, make_repo};
    use crate::workspace::{open_repo_impl, workspace_snapshot_impl};

    // --- network operations ------------------------------------------------

    use super::ProgressEvent;
    use crate::remote::{cancel_network_op_impl, fetch_all_impl};
    use gitp_core::Progress;
    use std::sync::{Arc, Mutex};

    fn meter(phase: &str, percent: u8) -> Progress {
        Progress {
            phase: phase.into(),
            percent: Some(percent),
            detail: String::new(),
        }
    }

    #[test]
    fn progress_is_throttled_but_a_new_phase_always_gets_through() {
        let state = RepoState::default();
        let events: Arc<Mutex<Vec<ProgressEvent>>> = Arc::default();
        let sink = Arc::clone(&events);
        state.1.set_emitter(move |e| sink.lock().unwrap().push(e));
        let report = state.1.reporter("fetch").expect("an emitter is set");

        for pct in 1..=50 {
            report(&meter("Receiving objects", pct));
        }
        report(&meter("Resolving deltas", 3));

        let events = events.lock().unwrap();
        let phases: Vec<_> = events.iter().map(|e| e.progress.phase.as_str()).collect();
        assert_eq!(phases, ["Receiving objects", "Resolving deltas"]);
        assert_eq!(events[0].op, "fetch");
        assert_eq!(events[0].progress.percent, Some(1));
    }

    #[test]
    fn without_an_emitter_there_is_no_reporter() {
        assert!(RepoState::default().1.reporter("push").is_none());
    }

    #[test]
    fn cancel_reaches_only_the_active_repos_operations() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");
        let path = state.0.lock().unwrap().sessions[0].path.clone();

        let ours = state.1.begin(&path);
        let theirs = state.1.begin("/some/other/repo");
        cancel_network_op_impl(&state).expect("cancel");

        assert!(ours.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!theirs.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn a_finished_operation_is_no_longer_cancellable() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        // No remotes, so this fetch has nothing to do — it only has to
        // register and deregister.
        fetch_all_impl(&state).expect("fetch");
        assert!(state.1.in_flight.lock().unwrap().is_empty());
    }

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
        assert_eq!(
            staged.status.staged.len(),
            1,
            "staging must show immediately"
        );
        assert_eq!(staged.status.unstaged.len(), 0);

        unstage_impl(&state, "f.txt".into()).expect("unstage");
        let unstaged = workspace_snapshot_impl(&state).expect("snapshot");
        assert_eq!(
            unstaged.status.staged.len(),
            0,
            "unstaging must show immediately"
        );
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
        assert_eq!(
            after.status.staged.len(),
            1,
            "an outside stage must not be served from cache"
        );
        assert_eq!(after.status.unstaged.len(), 0);

        // ...and the same on the way back out.
        git(dir.path(), &["reset", "-q", "HEAD", "f.txt"]);
        let reset = workspace_snapshot_impl(&state).expect("snapshot");
        assert_eq!(
            reset.status.staged.len(),
            0,
            "an outside unstage must not be served from cache"
        );
        assert_eq!(reset.status.unstaged.len(), 1);
    }
}
