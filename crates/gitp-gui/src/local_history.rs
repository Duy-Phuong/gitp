//! Local history: the commands behind the Local History view, and the
//! automatic snapshots. A change in a working tree (reported by the watcher)
//! arms a timer for that repository; once the tree has been quiet for
//! [`QUIET`], a snapshot is taken on a thread of its own, with a `Repo`
//! handle of its own, so neither the UI nor the workspace lock waits on it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use gitp_core::{FileVersion, Repo, Snapshot};
use tauri::State;

use crate::state::{with_repo, with_repo_unlocked, RepoState};
use crate::undo::with_recorded_files;

/// How long a working tree must stay quiet before its changes are
/// snapshotted: long enough to catch a save-and-keep-typing as one, short
/// enough that little is lost to a crash.
const QUIET: Duration = Duration::from_secs(20);
/// How often the worker looks for a due snapshot.
const TICK: Duration = Duration::from_secs(5);

/// Whether snapshots are taken at all (Settings → Git). On by default.
static ENABLED: AtomicBool = AtomicBool::new(true);

fn pending() -> &'static Mutex<HashMap<String, Instant>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

/// A working tree changed: snapshot it once it has been quiet for a while.
pub(crate) fn note_change(path: &str) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    if let Ok(mut map) = pending().lock() {
        map.insert(path.to_string(), Instant::now() + QUIET);
    }
    ensure_worker();
}

fn ensure_worker() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        std::thread::Builder::new()
            .name("gitp-local-history".into())
            .spawn(worker)
            .map(|_| ())
            .unwrap_or_else(|e| eprintln!("gitp: local history worker not started: {e}"));
    });
}

fn worker() {
    loop {
        std::thread::sleep(TICK);
        let due: Vec<String> = match pending().lock() {
            Ok(mut map) => {
                let now = Instant::now();
                let due: Vec<String> = map
                    .iter()
                    .filter(|(_, at)| **at <= now)
                    .map(|(p, _)| p.clone())
                    .collect();
                for p in &due {
                    map.remove(p);
                }
                due
            }
            Err(_) => continue,
        };
        for path in due {
            if !ENABLED.load(Ordering::Relaxed) {
                continue;
            }
            // Each snapshot on its own handle: a failure (a repository that
            // closed, a lock held by git) only means no snapshot this time.
            if let Ok(repo) = Repo::open(&path) {
                let _ = repo.snapshot_working_tree();
            }
        }
    }
}

fn set_enabled_impl(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
    if !enabled {
        if let Ok(mut map) = pending().lock() {
            map.clear();
        }
    }
}

fn local_history_impl(state: &RepoState) -> Result<Vec<Snapshot>, String> {
    with_repo_unlocked(state, |repo| repo.local_history())
}

fn file_versions_impl(state: &RepoState, path: String) -> Result<Vec<FileVersion>, String> {
    with_repo_unlocked(state, |repo| repo.file_versions(&path))
}

/// The text of `path` in a snapshot, for the viewer. Bytes that aren't
/// UTF-8 are shown lossily; the restore writes the exact bytes regardless.
fn snapshot_file_impl(state: &RepoState, snapshot: String, path: String) -> Result<String, String> {
    with_repo(state, |repo| {
        let bytes = repo.snapshot_file(&snapshot, &path)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
}

/// Put a snapshot's version of `path` back. Recorded like a discard, so Undo
/// restores what was on disk before.
fn restore_from_snapshot_impl(
    state: &RepoState,
    snapshot: String,
    path: String,
) -> Result<(), String> {
    let label = format!("Restore {path}");
    with_recorded_files(state, label, std::slice::from_ref(&path), |repo| {
        repo.restore_from_snapshot(&snapshot, &path)
    })
}

/// A snapshot right now, on request. Returns its id, or null when the tree
/// matches the last snapshot or HEAD.
fn snapshot_now_impl(state: &RepoState) -> Result<Option<String>, String> {
    with_repo_unlocked(state, |repo| repo.snapshot_working_tree())
}

fn clear_local_history_impl(state: &RepoState) -> Result<(), String> {
    with_repo(state, |repo| repo.clear_local_history())
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn local_history(state: State<RepoState>) -> Result<Vec<Snapshot>, String> {
    local_history_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn local_history_versions(
    path: String,
    state: State<RepoState>,
) -> Result<Vec<FileVersion>, String> {
    file_versions_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn local_history_file(
    snapshot: String,
    path: String,
    state: State<RepoState>,
) -> Result<String, String> {
    snapshot_file_impl(&state, snapshot, path)
}

#[tauri::command(async)]
pub(crate) fn local_history_restore(
    snapshot: String,
    path: String,
    state: State<RepoState>,
) -> Result<(), String> {
    restore_from_snapshot_impl(&state, snapshot, path)
}

#[tauri::command(async)]
pub(crate) fn local_history_snapshot(state: State<RepoState>) -> Result<Option<String>, String> {
    snapshot_now_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn local_history_clear(state: State<RepoState>) -> Result<(), String> {
    clear_local_history_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn local_history_set_enabled(enabled: bool) {
    set_enabled_impl(enabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::staging::stage_impl;
    use crate::test_support::make_repo;
    use crate::undo::{undo_impl, undo_state_impl};
    use crate::workspace::open_repo_impl;

    #[test]
    fn a_restore_from_a_snapshot_is_undoable() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");
        std::fs::write(dir.path().join("f.txt"), "draft\n").unwrap();
        let snapshot = snapshot_now_impl(&state).unwrap().expect("snapshot");
        std::fs::write(dir.path().join("f.txt"), "typed over\n").unwrap();
        stage_impl(&state, "f.txt".into()).unwrap();

        let versions = file_versions_impl(&state, "f.txt".into()).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].snapshot, snapshot);
        assert_eq!(
            snapshot_file_impl(&state, snapshot.clone(), "f.txt".into()).unwrap(),
            "draft\n"
        );

        restore_from_snapshot_impl(&state, snapshot, "f.txt".into()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            "draft\n"
        );
        assert_eq!(
            undo_state_impl(&state).unwrap().undo.as_deref(),
            Some("Restore f.txt")
        );
        undo_impl(&state).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            "typed over\n"
        );
    }
}
