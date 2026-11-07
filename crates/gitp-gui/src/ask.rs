//! "Explain with Claude" on a commit, a branch or a tag: a Claude job that
//! reads the commit, the branch's commits and diff, or the release's
//! commits, and answers in Markdown.

use gitp_core::{my_work_input, AskKind, Gh, Repo};
use tauri::State;

use crate::claude_jobs::{ClaudeJobs, JobKind, NewJob};
use crate::state::{to_message, RepoState};

fn claude_ask_impl(
    state: &RepoState,
    jobs: &ClaudeJobs,
    kind: String,
    target: String,
    command: String,
) -> Result<String, String> {
    let ask = AskKind::parse(&kind).ok_or_else(|| format!("unknown kind: {kind}"))?;
    let repo_path = {
        let guard = state.workspace();
        let idx = guard.active.ok_or("no repository is open")?;
        guard.sessions[idx].path.clone()
    };
    let mut repo = Repo::open(&repo_path).map_err(to_message)?;
    let (input, what) = repo.claude_ask_input(ask, &target).map_err(to_message)?;
    let verb = match ask {
        AskKind::Commit => "Explain commit",
        AskKind::Branch => "Summarize branch",
        AskKind::Release => "Release notes",
    };
    let short: String = if ask == AskKind::Commit {
        what.chars().take(10).collect()
    } else {
        what
    };
    let run = jobs.begin(NewJob {
        kind: JobKind::Ask,
        label: format!("{verb} · {short}"),
        activity: String::new(),
        repo: repo_path,
        pr: 0,
        thread: None,
        finding: Some(format!("{kind}:{target}")),
        branch: None,
        command: command.clone(),
        stdin_bytes: input.len(),
    })?;
    repo.set_network_hooks(run.hooks());
    let out = repo.run_claude(&command, &input).map_err(to_message);
    run.finish(out.clone(), &[]);
    out
}

#[tauri::command(async)]
pub(crate) fn claude_ask(
    kind: String,
    target: String,
    command: String,
    state: State<RepoState>,
    jobs: State<ClaudeJobs>,
) -> Result<String, String> {
    claude_ask_impl(&state, &jobs, kind, target, command)
}

/// "What did I do": the user's commits in `repos` and pull requests on
/// GitHub since `since`, summed up by Claude for a stand-up, as a Claude job
/// run in the open repository.
fn claude_my_work_impl(
    state: &RepoState,
    jobs: &ClaudeJobs,
    since: String,
    repos: Vec<String>,
    command: String,
) -> Result<String, String> {
    let repo_path = {
        let guard = state.workspace();
        let idx = guard.active.ok_or("Open a repository first.")?;
        guard.sessions[idx].path.clone()
    };
    let dirs: Vec<std::path::PathBuf> = repos.iter().map(std::path::PathBuf::from).collect();
    let input = my_work_input(&Gh::system(), &dirs, &since).map_err(to_message)?;
    let mut repo = Repo::open(&repo_path).map_err(to_message)?;
    let run = jobs.begin(NewJob {
        kind: JobKind::Ask,
        label: format!("What I did · since {since}"),
        activity: String::new(),
        repo: repo_path,
        pr: 0,
        thread: None,
        finding: Some(format!("my-work:{since}")),
        branch: None,
        command: command.clone(),
        stdin_bytes: input.len(),
    })?;
    repo.set_network_hooks(run.hooks());
    let out = repo.run_claude(&command, &input).map_err(to_message);
    run.finish(out.clone(), &[]);
    out
}

#[tauri::command(async)]
pub(crate) fn claude_my_work(
    since: String,
    repos: Vec<String>,
    command: String,
    state: State<RepoState>,
    jobs: State<ClaudeJobs>,
) -> Result<String, String> {
    claude_my_work_impl(&state, &jobs, since, repos, command)
}
