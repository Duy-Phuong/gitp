//! The review inbox: every given repository's pull requests that need the
//! user, streamed as `inbox-repo` events, one per repository as each
//! answers, so a slow one doesn't hold up the rest.

use gitp_core::{inbox_repo, inbox_sources, Gh, InboxRepo};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// The event each repository's answer comes in.
pub(crate) const INBOX_EVENT: &str = "inbox-repo";

/// One repository's answer, with the id of the run that asked.
#[derive(Serialize, Clone)]
struct InboxEvent {
    id: u32,
    result: InboxRepo,
}

/// The inbox of `paths`: those that can't be asked are emitted at once, then
/// each GitHub repository (once, through its first path) on a thread of its
/// own, emitted as it answers. Returns when all have.
pub(crate) fn inbox_impl(gh: &Gh, paths: &[String], emit: impl Fn(InboxRepo) + Send + Sync) {
    let (sources, errors) = inbox_sources(paths);
    for error in errors {
        emit(error);
    }
    let emit = &emit;
    std::thread::scope(|scope| {
        for (path, _) in &sources {
            scope.spawn(move || emit(inbox_repo(gh, path)));
        }
    });
}

/// Read the inbox of `paths` (Open Recent and starred, in that order);
/// returns once every repository has answered.
#[tauri::command]
pub(crate) async fn inbox(paths: Vec<String>, id: u32, app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        inbox_impl(&Gh::system(), &paths, |result| {
            let _ = app.emit(INBOX_EVENT, InboxEvent { id, result });
        })
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn repo(dir: &std::path::Path, url: &str) -> String {
        for args in [&["init", "-q"][..], &["remote", "add", "origin", url]] {
            let out = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        }
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn inbox_emits_one_result_per_unique_repo() {
        let root = tempfile::tempdir().unwrap();
        let dirs: Vec<_> = ["a", "b", "lab"].iter().map(|n| root.path().join(n)).collect();
        for d in &dirs {
            std::fs::create_dir(d).unwrap();
        }
        let a = repo(&dirs[0], "git@github.com:octo/hello.git");
        let b = repo(&dirs[1], "https://github.com/octo/hello.git");
        let lab = repo(&dirs[2], "git@gitlab.com:me/x.git");
        let empty = tempfile::tempdir().unwrap();
        let gh = Gh::with_search_path(empty.path());
        let got = Mutex::new(Vec::new());
        inbox_impl(&gh, &[a.clone(), b, lab.clone()], |r| got.lock().unwrap().push(r));
        let mut got = got.into_inner().unwrap();
        got.sort_by(|x, y| x.path.cmp(&y.path));
        let rows: Vec<_> = got.iter().map(|r| (r.path.clone(), r.error.clone())).collect();
        assert_eq!(
            rows,
            [
                (a, Some("gh is not installed".to_string())),
                (lab, Some("no GitHub remote".to_string())),
            ]
        );
    }
}
