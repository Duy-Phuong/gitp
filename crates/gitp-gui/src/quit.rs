//! What a quit or a window close waits on: Claude jobs still running, and
//! open repositories whose default branch has commits not pushed yet — work
//! that would otherwise sit only on this machine. The frontend asks, and
//! comes back with `claude_jobs_quit` (stop the jobs) or `quit_now`.

use gitp_core::{Repo, Unpushed};
use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::claude_jobs::{ClaudeJobs, QUIT_EVENT};
use crate::state::{with_repo_unlocked, RepoState};

#[derive(Debug, Clone, Serialize)]
pub(crate) struct UnpushedRepo {
    /// The repository's folder name.
    pub repo: String,
    pub branch: String,
    pub ahead: usize,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct QuitCheck {
    /// The labels of the Claude jobs running.
    pub jobs: Vec<String>,
    pub unpushed: Vec<UnpushedRepo>,
}

/// The open repositories' default branches with unpushed commits.
fn unpushed_in(paths: &[String]) -> Vec<UnpushedRepo> {
    paths
        .iter()
        .filter_map(|path| {
            let u = Repo::open(path).ok()?.unpushed_default().ok()??;
            let repo = path
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(path)
                .to_string();
            Some(UnpushedRepo {
                repo,
                branch: u.branch,
                ahead: u.ahead,
            })
        })
        .collect()
}

/// Whether the quit has to wait: then the frontend is sent what for.
pub(crate) fn ask_before_quit(app: &tauri::AppHandle) -> bool {
    let jobs = app.state::<ClaudeJobs>().running();
    let paths: Vec<String> = {
        let state = app.state::<RepoState>();
        let ws = state.workspace();
        ws.sessions.iter().map(|s| s.path.clone()).collect()
    };
    let unpushed = unpushed_in(&paths);
    if jobs.is_empty() && unpushed.is_empty() {
        return false;
    }
    let _ = app.emit(QUIT_EVENT, QuitCheck { jobs, unpushed });
    true
}

/// Quit after all, from the dialog: nothing to stop.
#[tauri::command]
pub(crate) fn quit_now(app: tauri::AppHandle) {
    app.exit(0);
}

/// The active repository's default branch, when it has unpushed commits.
#[tauri::command(async)]
pub(crate) fn unpushed_default(state: tauri::State<RepoState>) -> Result<Option<Unpushed>, String> {
    with_repo_unlocked(&state, Repo::unpushed_default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_that_is_no_repository_is_left_out() {
        let dir = tempfile::tempdir().unwrap();
        assert!(unpushed_in(&[dir.path().to_string_lossy().into_owned()]).is_empty());
    }
}
