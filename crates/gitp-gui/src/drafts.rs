//! Drafts with Claude: a commit message for the commit box and a pull
//! request's title and description for the Create Pull Request dialog. Each
//! runs the user's draft command (see gitp-core's `drafts`) on a repo handle
//! of its own, one of each kind per repository at a time, with a Cancel.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use gitp_core::{CommitDraft, NetworkHooks, PrDraft, Repo};
use serde::Deserialize;
use tauri::State;

use crate::state::to_message;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DraftKind {
    CommitMessage,
    PullRequest,
}

/// The drafts running now: their cancel flags by repository and kind.
#[derive(Default)]
pub(crate) struct DraftRuns(Mutex<HashMap<(String, DraftKind), Arc<AtomicBool>>>);

impl DraftRuns {
    /// Run `f` on a handle of `path` with a cancel flag, refusing while a
    /// draft of the same kind runs there.
    fn run<T>(
        &self,
        path: &str,
        kind: DraftKind,
        f: impl FnOnce(&Repo) -> gitp_core::Result<T>,
    ) -> Result<T, String> {
        let key = (path.to_string(), kind);
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut runs = self.0.lock().map_err(to_message)?;
            if runs.contains_key(&key) {
                return Err("A draft is already running.".into());
            }
            runs.insert(key.clone(), Arc::clone(&cancel));
        }
        let out = Repo::open(path).map_err(to_message).and_then(|mut repo| {
            repo.set_network_hooks(NetworkHooks {
                cancel: Some(cancel),
                ..NetworkHooks::default()
            });
            f(&repo).map_err(to_message)
        });
        if let Ok(mut runs) = self.0.lock() {
            runs.remove(&key);
        }
        out
    }

    /// Raise the cancel flag of the draft of `kind` running in `path`, if any.
    fn cancel(&self, path: &str, kind: DraftKind) {
        if let Some(flag) = self
            .0
            .lock()
            .ok()
            .and_then(|r| r.get(&(path.to_string(), kind)).cloned())
        {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

fn draft_commit_message_impl(
    runs: &DraftRuns,
    path: String,
    command: String,
    amend: bool,
) -> Result<CommitDraft, String> {
    runs.run(&path, DraftKind::CommitMessage, |repo| {
        repo.draft_commit_message(&command, amend)
    })
}

fn draft_pull_request_impl(
    runs: &DraftRuns,
    path: String,
    branch: String,
    base: String,
    command: String,
) -> Result<PrDraft, String> {
    runs.run(&path, DraftKind::PullRequest, |repo| {
        repo.draft_pull_request(&command, &base, &branch)
    })
}

// --- Tauri commands ----------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn draft_commit_message(
    path: String,
    command: String,
    amend: bool,
    runs: State<DraftRuns>,
) -> Result<CommitDraft, String> {
    draft_commit_message_impl(&runs, path, command, amend)
}

#[tauri::command(async)]
pub(crate) fn draft_pull_request(
    path: String,
    branch: String,
    base: String,
    command: String,
    runs: State<DraftRuns>,
) -> Result<PrDraft, String> {
    draft_pull_request_impl(&runs, path, branch, base, command)
}

#[tauri::command]
pub(crate) fn draft_cancel(path: String, kind: DraftKind, runs: State<DraftRuns>) {
    runs.cancel(&path, kind);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{git, make_repo};
    use std::time::{Duration, Instant};

    fn staged_repo() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["one"]);
        std::fs::write(dir.path().join("f.txt"), "changed\n").unwrap();
        git(dir.path(), &["add", "f.txt"]);
        let path = dir.path().to_string_lossy().into_owned();
        (dir, path)
    }

    #[test]
    fn a_commit_draft_runs_in_the_repo() {
        let (_dir, path) = staged_repo();
        let runs = DraftRuns::default();
        let draft = draft_commit_message_impl(
            &runs,
            path,
            "cat >/dev/null; printf 'feat: a\\n\\nbody'".into(),
            false,
        )
        .unwrap();
        assert_eq!(
            (draft.subject.as_str(), draft.body.as_str()),
            ("feat: a", "body")
        );
    }

    #[test]
    fn cancel_stops_a_running_draft() {
        let (_dir, path) = staged_repo();
        let runs = Arc::new(DraftRuns::default());
        let (r, p) = (Arc::clone(&runs), path.clone());
        let started = Instant::now();
        let run =
            std::thread::spawn(move || draft_commit_message_impl(&r, p, "sleep 5".into(), false));
        while runs.0.lock().unwrap().is_empty() {
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(100));
        runs.cancel(&path, DraftKind::CommitMessage);
        assert_eq!(run.join().unwrap().unwrap_err(), "operation cancelled");
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(runs.0.lock().unwrap().is_empty(), "the slot is freed");
    }

    #[test]
    fn a_second_draft_of_the_same_kind_is_refused_and_the_slot_frees() {
        let (_dir, path) = staged_repo();
        let runs = Arc::new(DraftRuns::default());
        let (r, p) = (Arc::clone(&runs), path.clone());
        let run = std::thread::spawn(move || {
            draft_commit_message_impl(&r, p, "cat >/dev/null; sleep 1; echo first".into(), false)
        });
        while runs.0.lock().unwrap().is_empty() {
            std::thread::sleep(Duration::from_millis(10));
        }
        let err = draft_commit_message_impl(&runs, path.clone(), "echo second".into(), false)
            .unwrap_err();
        assert_eq!(err, "A draft is already running.");
        // Another kind is not held up.
        let pr = draft_pull_request_impl(
            &runs,
            path.clone(),
            "nope".into(),
            "main".into(),
            "true".into(),
        )
        .unwrap_err();
        assert!(pr.contains("nope"), "{pr}");
        assert_eq!(run.join().unwrap().unwrap().subject, "first");
        let again =
            draft_commit_message_impl(&runs, path, "cat >/dev/null; echo again".into(), false)
                .unwrap();
        assert_eq!(again.subject, "again");
    }

    #[test]
    fn cancel_with_nothing_running_is_a_no_op() {
        let runs = DraftRuns::default();
        runs.cancel("/nowhere", DraftKind::PullRequest);
        assert!(runs.0.lock().unwrap().is_empty());
    }
}
