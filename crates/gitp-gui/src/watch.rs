//! The filesystem watcher behind each open repository: it marks the cached
//! `git status` stale, and — for the active tab — tells the frontend, so an
//! edit in an editor, a `git commit` in a terminal or a branch switch from the
//! CLI shows up without waiting for the window to be focused or clicked.
//!
//! Events are classified by path alone in the watcher's callback (no `stat`,
//! no git), then handed to a per-repo thread that drops changes in ignored
//! directories and coalesces bursts — a checkout or an `npm install` produces
//! thousands of events — into one `repo-changed` event once things go quiet.

use std::collections::{BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use gitp_core::Repo;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;

/// How long the tree must stay quiet before a batch of changes is reported.
const QUIET: Duration = Duration::from_millis(300);
/// The longest a batch waits under a steady stream of changes, so a build or a
/// long checkout still refreshes now and then instead of never.
const MAX_WAIT: Duration = Duration::from_secs(2);
/// Entries in the ignored-directory cache before it is simply dropped.
const IGNORE_CACHE_LIMIT: usize = 50_000;
/// Worktree paths a batch keeps for the Code tab's index; past this it says
/// "many" and the index rebuilds instead.
const PATHS_LIMIT: usize = 500;

/// The Tauri event the frontend listens for.
pub(crate) const REPO_CHANGED_EVENT: &str = "repo-changed";

/// Where a batch of changes reports to: the app's event emitter, or nothing in
/// the command-layer tests.
pub(crate) type ChangeSink = Arc<dyn Fn(RepoChanged) + Send + Sync>;

/// Payload of [`REPO_CHANGED_EVENT`]: which repo, and what kind of thing moved.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct RepoChanged {
    pub(crate) path: String,
    pub(crate) kinds: Vec<&'static str>,
    /// The working-tree paths that changed (relative, ignored ones dropped),
    /// unless there were more than [`PATHS_LIMIT`]: then empty, with
    /// `worktree_overflow` set.
    pub(crate) worktree_paths: Vec<String>,
    pub(crate) worktree_overflow: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ChangeKind {
    /// A file in the working tree.
    Worktree,
    /// `.git/index` — something was staged, unstaged, committed or checked out.
    Index,
    /// A branch, tag or remote-tracking ref (`.git/refs/**`, `packed-refs`).
    Refs,
    /// `.git/HEAD` — a checkout, or a commit on a detached HEAD.
    Head,
}

impl ChangeKind {
    const ALL: [ChangeKind; 4] = [Self::Worktree, Self::Index, Self::Refs, Self::Head];

    fn bit(self) -> u8 {
        1 << self as u8
    }

    fn name(self) -> &'static str {
        match self {
            Self::Worktree => "worktree",
            Self::Index => "index",
            Self::Refs => "refs",
            Self::Head => "head",
        }
    }
}

/// A set of [`ChangeKind`]s.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Kinds(u8);

impl Kinds {
    pub(crate) fn insert(&mut self, kind: ChangeKind) {
        self.0 |= kind.bit();
    }

    pub(crate) fn contains(self, kind: ChangeKind) -> bool {
        self.0 & kind.bit() != 0
    }

    pub(crate) fn names(self) -> Vec<&'static str> {
        ChangeKind::ALL
            .into_iter()
            .filter(|k| self.contains(*k))
            .map(ChangeKind::name)
            .collect()
    }
}

/// One classified filesystem change.
#[derive(Debug, PartialEq)]
pub(crate) enum Change {
    /// A working-tree path, relative to the working directory — kept so the
    /// watcher thread can check it against the ignore rules.
    Worktree(PathBuf),
    Git(ChangeKind),
}

/// Classify a changed path (relative to the working directory) by name alone.
///
/// Inside `.git` only the index, HEAD and the refs matter; everything else
/// there — objects, reflogs, `FETCH_HEAD`, `ORIG_HEAD`, gitp's own undo
/// snapshots — is noise, as are the `*.lock` files git writes and renames into
/// place (the rename itself reports the final name). A `git fetch` that moves
/// a remote-tracking branch still surfaces, through `refs/remotes/**` or
/// `packed-refs`.
pub(crate) fn classify(rel: &Path) -> Option<Change> {
    let mut parts = rel.components();
    match parts.next()? {
        Component::Normal(name) if name == ".git" => {}
        Component::Normal(_) => return Some(Change::Worktree(rel.to_path_buf())),
        _ => return None,
    }
    let inner = parts.as_path();
    if inner.extension().is_some_and(|e| e == "lock") {
        return None;
    }
    let kind = if inner == Path::new("index") {
        ChangeKind::Index
    } else if inner == Path::new("HEAD") {
        ChangeKind::Head
    } else if inner == Path::new("packed-refs") || inner.starts_with("refs") {
        ChangeKind::Refs
    } else {
        return None;
    };
    Some(Change::Git(kind))
}

/// Trailing-edge debounce with a ceiling: a batch is due once no change has
/// arrived for [`QUIET`], or [`MAX_WAIT`] after its first change, whichever
/// comes first. Pure — the caller supplies the clock — so it's testable
/// without a watcher or real time passing.
#[derive(Default)]
pub(crate) struct Debouncer {
    kinds: Kinds,
    first: Option<Instant>,
    last: Option<Instant>,
    paths: BTreeSet<String>,
    overflow: bool,
}

impl Debouncer {
    pub(crate) fn push(&mut self, kind: ChangeKind, now: Instant) {
        self.kinds.insert(kind);
        self.first.get_or_insert(now);
        self.last = Some(now);
    }

    /// A working-tree change at `rel`, kept for the batch up to [`PATHS_LIMIT`].
    pub(crate) fn push_path(&mut self, rel: String, now: Instant) {
        self.push(ChangeKind::Worktree, now);
        if self.overflow {
            return;
        }
        self.paths.insert(rel);
        if self.paths.len() > PATHS_LIMIT {
            self.paths.clear();
            self.overflow = true;
        }
    }

    /// The batch's paths, sorted, and whether there were too many to keep.
    pub(crate) fn take_paths(&mut self) -> (Vec<String>, bool) {
        let overflow = std::mem::take(&mut self.overflow);
        (std::mem::take(&mut self.paths).into_iter().collect(), overflow)
    }

    /// When the pending batch becomes due, or `None` when nothing is pending.
    pub(crate) fn deadline(&self) -> Option<Instant> {
        Some((self.last? + QUIET).min(self.first? + MAX_WAIT))
    }

    /// The pending batch if it's due at `now`, resetting for the next one.
    pub(crate) fn take_due(&mut self, now: Instant) -> Option<Kinds> {
        if now < self.deadline()? {
            return None;
        }
        self.first = None;
        self.last = None;
        Some(std::mem::take(&mut self.kinds))
    }
}

/// Answers "is this working-tree path ignored?" against the repo's ignore
/// rules, caching the answer per directory so a build churning through
/// `target/` costs one lookup per event, not one rules evaluation.
///
/// Directories are checked top-down, so everything under `node_modules/` is
/// settled by the single cached entry for `node_modules`.
pub(crate) struct IgnoreFilter {
    /// Its own handle — the session's is behind the workspace lock. `None` if
    /// the repo couldn't be opened, in which case nothing is filtered.
    repo: Option<Repo>,
    dirs: HashMap<PathBuf, bool>,
}

impl IgnoreFilter {
    pub(crate) fn new(workdir: &Path) -> Self {
        Self {
            repo: Repo::open(workdir).ok(),
            dirs: HashMap::new(),
        }
    }

    pub(crate) fn is_ignored(&mut self, rel: &Path) -> bool {
        let Self { repo, dirs } = self;
        let Some(repo) = repo else { return false };
        // New rules invalidate every cached answer. The `.gitignore` edit is a
        // change in its own right, so it's never filtered.
        if rel.file_name().is_some_and(|n| n == ".gitignore") || dirs.len() > IGNORE_CACHE_LIMIT {
            dirs.clear();
        }
        let mut dir = PathBuf::new();
        for part in rel.parent().into_iter().flat_map(Path::components) {
            dir.push(part);
            let ignored = match dirs.get(&dir) {
                Some(&hit) => hit,
                None => {
                    let hit = repo.is_ignored(&dir, true);
                    dirs.insert(dir.clone(), hit);
                    hit
                }
            };
            if ignored {
                return true;
            }
        }
        repo.is_ignored(rel, false)
    }
}

/// Watch everything under `dir` (the working tree, `.git` included).
///
/// Every change raises the returned flag, so `ensure_status` knows a rescan is
/// warranted — for any event at all, deliberately unfiltered: working out
/// whether a write could affect `git status` is exactly the work `git status`
/// does, so filtering there would cost more than it saves and risk missing a
/// change.
///
/// With a `sink`, changes are also reported (debounced, minus ignored paths)
/// as [`RepoChanged`] for `path` — but only while `live` is set, i.e. while
/// this repo is the active tab; an inactive tab is refreshed when activated.
///
/// Returns `(None, None)` if a watcher can't be started — an unreadable
/// directory, or the platform's watch limits being exhausted on a huge tree.
/// That's not an error worth failing the open over: the caller simply doesn't
/// cache, and the frontend falls back to refreshing on focus and interaction.
pub(crate) fn watch_worktree(
    dir: &Path,
    path: String,
    sink: Option<ChangeSink>,
    live: Arc<AtomicBool>,
) -> (Option<Arc<AtomicBool>>, Option<RecommendedWatcher>) {
    let flag = Arc::new(AtomicBool::new(true));
    let signal = Arc::clone(&flag);
    let tx = sink.map(|sink| {
        let (tx, rx) = mpsc::channel::<Change>();
        let workdir = dir.to_path_buf();
        // Ends on its own once the watcher (and with it `tx`) is dropped.
        std::thread::spawn(move || report_changes(rx, &workdir, path, sink, live));
        tx
    });
    // Events carry absolute paths, and on macOS they come back with symlinks
    // resolved (`/var/...` arrives as `/private/var/...`).
    let roots = [dir.to_path_buf(), dir.canonicalize().unwrap_or_default()];
    let handler = move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        signal.store(true, Ordering::SeqCst);
        let Some(tx) = &tx else { return };
        // Reads aren't changes — and reporting them would make gitp's own
        // `git status` (which reads every file) trigger the next refresh.
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        for abs in &event.paths {
            let rel = roots.iter().find_map(|root| abs.strip_prefix(root).ok());
            if let Some(change) = rel.and_then(classify) {
                let _ = tx.send(change);
            }
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

/// The per-repo thread: filter, coalesce, report.
fn report_changes(
    rx: mpsc::Receiver<Change>,
    workdir: &Path,
    path: String,
    sink: ChangeSink,
    live: Arc<AtomicBool>,
) {
    let mut debouncer = Debouncer::default();
    let mut ignore = IgnoreFilter::new(workdir);
    loop {
        let received = match debouncer.deadline() {
            None => rx.recv().ok(),
            Some(due) => match rx.recv_timeout(due.saturating_duration_since(Instant::now())) {
                Ok(change) => Some(change),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            },
        };
        match received {
            None if debouncer.deadline().is_none() => return, // disconnected while idle
            None => {}
            // An inactive tab reports nothing; skip the ignore checks too.
            Some(_) if !live.load(Ordering::SeqCst) => {}
            Some(Change::Git(kind)) => debouncer.push(kind, Instant::now()),
            // The ignore check is cached per directory, so every path can
            // afford it — and the Code tab's index must not see ignored ones.
            Some(Change::Worktree(rel)) if !ignore.is_ignored(&rel) => {
                debouncer.push_path(rel.to_string_lossy().replace('\\', "/"), Instant::now())
            }
            Some(Change::Worktree(_)) => {} // ignored path
        }
        if let Some(kinds) = debouncer.take_due(Instant::now()) {
            let (worktree_paths, worktree_overflow) = debouncer.take_paths();
            sink(RepoChanged {
                path: path.clone(),
                kinds: kinds.names(),
                worktree_paths,
                worktree_overflow,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{git, make_repo};
    use std::sync::Mutex;

    fn kind(rel: &str) -> Option<ChangeKind> {
        match classify(Path::new(rel))? {
            Change::Git(k) => Some(k),
            Change::Worktree(_) => Some(ChangeKind::Worktree),
        }
    }

    #[test]
    fn classifies_changes_by_path() {
        assert_eq!(kind("src/main.rs"), Some(ChangeKind::Worktree));
        assert_eq!(kind(".gitignore"), Some(ChangeKind::Worktree));
        assert_eq!(kind(".github/workflows/ci.yml"), Some(ChangeKind::Worktree));
        assert_eq!(kind(".git/index"), Some(ChangeKind::Index));
        assert_eq!(kind(".git/HEAD"), Some(ChangeKind::Head));
        assert_eq!(kind(".git/packed-refs"), Some(ChangeKind::Refs));
        assert_eq!(kind(".git/refs/heads/main"), Some(ChangeKind::Refs));
        assert_eq!(kind(".git/refs/heads/feat/x"), Some(ChangeKind::Refs));
        // A fetch that moves a remote-tracking branch must surface.
        assert_eq!(
            kind(".git/refs/remotes/origin/main"),
            Some(ChangeKind::Refs)
        );
        assert_eq!(kind(".git/refs/tags/v1"), Some(ChangeKind::Refs));
    }

    #[test]
    fn ignores_git_internals_and_lock_files() {
        for rel in [
            "",
            ".git",
            ".git/objects/ab/cdef",
            ".git/logs/HEAD",
            ".git/logs/refs/heads/main",
            ".git/FETCH_HEAD",
            ".git/ORIG_HEAD",
            ".git/index.lock",
            ".git/HEAD.lock",
            ".git/refs/heads/main.lock",
            ".git/packed-refs.lock",
            ".git/gitp-undo-index-1",
            ".git/config",
        ] {
            assert_eq!(kind(rel), None, "{rel} should be ignored");
        }
        // A worktree path carries itself, for the ignore check.
        assert_eq!(
            classify(Path::new("a/b.txt")),
            Some(Change::Worktree(PathBuf::from("a/b.txt")))
        );
    }

    #[test]
    fn a_burst_of_changes_is_reported_once_after_it_goes_quiet() {
        let t0 = Instant::now();
        let ms = |n: u64| t0 + Duration::from_millis(n);
        let mut d = Debouncer::default();
        assert_eq!(d.deadline(), None);
        assert_eq!(d.take_due(t0), None, "nothing pending");

        // Thousands of events 1ms apart, as from a checkout.
        for i in 0..1000 {
            d.push(ChangeKind::Worktree, ms(i));
            assert_eq!(d.take_due(ms(i)), None, "not while it's still busy");
        }
        d.push(ChangeKind::Index, ms(1000));
        d.push(ChangeKind::Head, ms(1001));
        assert_eq!(d.take_due(ms(1200)), None, "still within the quiet window");

        let kinds = d.take_due(ms(1301)).expect("due once quiet");
        assert_eq!(kinds.names(), vec!["worktree", "index", "head"]);
        assert_eq!(d.deadline(), None, "and reset for the next batch");
        assert_eq!(d.take_due(ms(5000)), None, "reported exactly once");
    }

    #[test]
    fn a_steady_stream_still_reports_every_max_wait() {
        let t0 = Instant::now();
        let mut d = Debouncer::default();
        let mut reported = Vec::new();
        // An event every 100ms for 5s never leaves a 300ms gap.
        for i in 0..50 {
            let now = t0 + Duration::from_millis(i * 100);
            d.push(ChangeKind::Worktree, now);
            if d.take_due(now).is_some() {
                reported.push(i * 100);
            }
        }
        assert_eq!(reported, vec![2000, 4100]);
    }

    #[test]
    fn batch_keeps_worktree_paths_up_to_500() {
        let t0 = Instant::now();
        let mut d = Debouncer::default();
        for i in 0..500 {
            d.push_path(format!("src/{i}.rs"), t0);
        }
        d.push_path("src/0.rs".into(), t0); // a repeat adds nothing
        let (paths, overflow) = d.take_paths();
        assert_eq!((paths.len(), overflow), (500, false));
        assert_eq!(paths[0], "src/0.rs");
        assert!(d.take_paths().0.is_empty(), "taken once");

        let mut d = Debouncer::default();
        for i in 0..501 {
            d.push_path(format!("src/{i}.rs"), t0);
        }
        let (paths, overflow) = d.take_paths();
        assert_eq!((paths.len(), overflow), (0, true));
        assert_eq!(d.take_due(t0 + Duration::from_secs(5)).map(|k| k.names()), Some(vec!["worktree"]), "a path is a worktree change");
    }

    #[test]
    fn ignored_paths_are_not_kept() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        std::fs::write(dir.path().join(".gitignore"), "build/\n").unwrap();
        git(dir.path(), &["add", ".gitignore"]);
        git(dir.path(), &["commit", "-q", "-m", "ignore"]);
        let seen = Arc::new(Mutex::new(Vec::<RepoChanged>::new()));
        let record = Arc::clone(&seen);
        let sink: ChangeSink = Arc::new(move |ev| record.lock().unwrap().push(ev));
        let (_, watcher) = watch_worktree(dir.path(), "repo".into(), Some(sink), Arc::new(AtomicBool::new(true)));
        assert!(watcher.is_some());
        std::thread::sleep(Duration::from_millis(600));
        seen.lock().unwrap().clear();

        std::fs::create_dir_all(dir.path().join("build")).unwrap();
        std::fs::write(dir.path().join("build/x.o"), "x").unwrap();
        std::fs::write(dir.path().join("f2.txt"), "x").unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        let seen = seen.lock().unwrap();
        let paths: Vec<&str> = seen.iter().flat_map(|e| e.worktree_paths.iter().map(String::as_str)).collect();
        assert_eq!(paths, ["f2.txt"], "{seen:?}");
        assert!(seen.iter().all(|e| !e.worktree_overflow));
    }

    #[test]
    fn ignored_paths_are_filtered_and_new_rules_take_effect() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        std::fs::write(dir.path().join(".gitignore"), "node_modules/\ntarget\n").unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(dir.path().join("web/node_modules")).unwrap();
        let mut filter = IgnoreFilter::new(dir.path());
        let ignored = |f: &mut IgnoreFilter, p: &str| f.is_ignored(Path::new(p));

        assert!(ignored(&mut filter, "node_modules/pkg/index.js"));
        assert!(
            ignored(&mut filter, "web/node_modules/x.js"),
            "nested ignored dir"
        );
        assert!(
            ignored(&mut filter, "target/debug/build.o"),
            "even if it doesn't exist"
        );
        assert!(!ignored(&mut filter, "f.txt"));
        assert!(!ignored(&mut filter, "src/lib.rs"));
        assert!(
            !ignored(&mut filter, ".gitignore"),
            "a rules change is a change"
        );

        // Un-ignoring a cached directory must take effect.
        std::fs::write(dir.path().join(".gitignore"), "target\n").unwrap();
        assert!(!ignored(&mut filter, ".gitignore"));
        assert!(!ignored(&mut filter, "node_modules/pkg/index.js"));
    }

    #[test]
    fn a_commit_outside_the_app_is_reported_once_for_the_live_repo() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        std::fs::write(dir.path().join(".gitignore"), "build/\n").unwrap();
        git(dir.path(), &["add", ".gitignore"]);
        git(dir.path(), &["commit", "-q", "-m", "ignore"]);
        let seen = Arc::new(Mutex::new(Vec::<RepoChanged>::new()));
        let record = Arc::clone(&seen);
        let sink: ChangeSink = Arc::new(move |ev| record.lock().unwrap().push(ev));
        let live = Arc::new(AtomicBool::new(true));
        let (_, watcher) = watch_worktree(dir.path(), "repo".into(), Some(sink), Arc::clone(&live));
        assert!(watcher.is_some(), "watcher should start");
        // FSEvents can deliver a little history from just before the watch.
        std::thread::sleep(Duration::from_millis(600));
        seen.lock().unwrap().clear();

        // A build churning in an ignored directory reports nothing...
        std::fs::create_dir_all(dir.path().join("build")).unwrap();
        for i in 0..50 {
            std::fs::write(dir.path().join(format!("build/{i}.o")), "x").unwrap();
        }
        std::thread::sleep(Duration::from_millis(1000));
        assert!(seen.lock().unwrap().is_empty(), "ignored churn is silent");

        // ...while an edit and a commit from a terminal are reported in a
        // couple of coalesced events, not one per file git touched (objects,
        // reflogs, locks). The edit and the commit can land in separate
        // batches when spawning `git` outlasts the quiet window.
        std::fs::write(dir.path().join("f.txt"), "changed\n").unwrap();
        git(dir.path(), &["commit", "-q", "-am", "outside"]);
        let kinds = || -> Vec<&'static str> {
            let seen = seen.lock().unwrap();
            seen.iter().flat_map(|e| e.kinds.clone()).collect()
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        while !["worktree", "index", "refs"]
            .iter()
            .all(|k| kinds().contains(k))
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(50));
        }
        std::thread::sleep(Duration::from_millis(700)); // anything trailing?
        let events = seen.lock().unwrap().clone();
        assert!(events.iter().all(|e| e.path == "repo"));
        assert!((1..=2).contains(&events.len()), "coalesced: {events:?}");
        for k in ["worktree", "index", "refs"] {
            assert!(kinds().contains(&k), "{k} reported in {events:?}");
        }

        // An inactive tab reports nothing.
        live.store(false, Ordering::SeqCst);
        seen.lock().unwrap().clear();
        std::fs::write(dir.path().join("f.txt"), "again\n").unwrap();
        std::thread::sleep(Duration::from_millis(1000));
        assert!(seen.lock().unwrap().is_empty(), "inactive tabs stay quiet");
    }
}
