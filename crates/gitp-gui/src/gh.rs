//! GitHub pull requests through the user's own `gh` login (see gitp-core's
//! `gh`): the account, signing in and out, the sidebar's list, the pull
//! request view, checking one out, commenting and reviewing, and opening and
//! merging one.
//!
//! The reads and posts run on a repo handle of their own, without the
//! workspace lock — each is a round trip to GitHub. Checking out moves HEAD,
//! so it runs as a network operation, with Cancel.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use gitp_core::{
    CommitPullRequest, ConflictResolution, FileDiff, GeneratedReview, Gh, GhAccount, GhLogin,
    GitHubRepoSettings, LineComment, MergeMethod, NewPullRequest, PrDraft, PrFilter,
    PrReviewComment, PullRequest, PullRequestDetail, Repo, ReviewFile, ReviewVerdict,
    ThreadConversation, ThreadInput, ThreadSearch, TurnKind, Undoable, LOGIN_TIMEOUT,
};
use serde::Serialize;
use tauri::State;

use crate::claude_jobs::{ClaudeJobs, JobKind, NewJob, Running};
use crate::os::{open_in_browser, open_in_default_app};
use crate::state::{
    invalidate_status, to_message, with_repo, with_repo_networked, with_repo_networked_prepared,
    with_repo_unlocked, RepoState,
};
use crate::undo::{clear_undo, set_undo};

/// The sign-in in progress, if any: the `gh auth login` between showing its
/// code and finishing, and the flag that cancels it.
#[derive(Default)]
pub(crate) struct GhLoginState {
    pending: Mutex<Option<GhLogin>>,
    cancel: Mutex<Option<Arc<AtomicBool>>>,
}

/// What the sign-in dialog shows: the code to enter, and where.
#[derive(Serialize)]
pub(crate) struct DeviceCode {
    code: String,
    url: String,
}

fn gh_account_impl() -> Result<GhAccount, String> {
    Gh::system().account().map_err(to_message)
}

/// The open repo's GitHub repository, or none — also when no repo is open.
fn gh_repo_impl(state: &RepoState) -> Option<String> {
    with_repo(state, |repo| Ok(repo.github_repo()))
        .ok()
        .flatten()
}

fn gh_pull_requests_impl(state: &RepoState, filter: PrFilter) -> Result<Vec<PullRequest>, String> {
    with_repo_unlocked(state, |repo| repo.pull_requests(&Gh::system(), filter))
}

fn gh_pull_request_impl(state: &RepoState, number: u64) -> Result<PullRequestDetail, String> {
    with_repo_unlocked(state, |repo| repo.pull_request(&Gh::system(), number))
}

fn gh_pull_request_files_impl(state: &RepoState, number: u64) -> Result<Vec<FileDiff>, String> {
    with_repo_unlocked(state, |repo| repo.pull_request_files(&Gh::system(), number))
}

/// `gh pr checkout` may create the branch, move it to the pull request's
/// head, and switch to it — more than one undo step could put back — so undo
/// is cleared, as for Stash & Switch.
fn gh_checkout_pull_request_impl(state: &RepoState, number: u64) -> Result<String, String> {
    // A checkout like any other: undo switches back to the branch that was
    // checked out before (the pull request's branch stays, for next time).
    with_repo_networked_prepared(
        state,
        "fetch",
        |session| session.repo.head_ref_name().ok(),
        |repo| repo.checkout_pull_request(&Gh::system(), number),
        move |session, before| {
            invalidate_status(session);
            let after = session.repo.head_ref_name().ok();
            match (before, after) {
                (Some(before), Some(after))
                    if before != after && !session.repo.operation_in_progress() =>
                {
                    set_undo(
                        session,
                        Undoable::Switched {
                            label: format!("Checkout pull request #{number}"),
                            before,
                            after,
                        },
                    )
                }
                _ => clear_undo(session),
            }
        },
    )
}

/// This worktree's HEAD and files are untouched; the new one's branch shows
/// up through the refs fingerprint.
fn gh_checkout_pull_request_worktree_impl(
    state: &RepoState,
    number: u64,
    path: String,
) -> Result<String, String> {
    with_repo_networked(
        state,
        "fetch",
        |repo| repo.checkout_pull_request_in_worktree(&Gh::system(), number, &path),
        |_| {},
    )
    .map(|p| p.to_string_lossy().into_owned())
}

fn gh_comment_impl(state: &RepoState, number: u64, body: String) -> Result<String, String> {
    with_repo_unlocked(state, |repo| {
        repo.comment_on_pull_request(&Gh::system(), number, &body)
    })
}

fn gh_review_impl(
    state: &RepoState,
    number: u64,
    verdict: ReviewVerdict,
    body: String,
) -> Result<String, String> {
    with_repo_unlocked(state, |repo| {
        repo.review_pull_request(&Gh::system(), number, verdict, &body)
    })
}

fn gh_repo_settings_impl(state: &RepoState) -> Result<GitHubRepoSettings, String> {
    with_repo_unlocked(state, |repo| repo.github_repo_settings(&Gh::system()))
}

fn gh_pull_request_draft_impl(
    state: &RepoState,
    branch: String,
    base: String,
) -> Result<PrDraft, String> {
    with_repo(state, |repo| repo.pull_request_draft(&branch, &base))
}

fn gh_create_pull_request_impl(state: &RepoState, pr: NewPullRequest) -> Result<u64, String> {
    with_repo_unlocked(state, |repo| repo.create_pull_request(&Gh::system(), &pr))
}

fn gh_merge_pull_request_impl(
    state: &RepoState,
    number: u64,
    method: MergeMethod,
    delete_branch: bool,
) -> Result<String, String> {
    with_repo_unlocked(state, |repo| {
        repo.merge_pull_request(&Gh::system(), number, method, delete_branch)
    })
}

fn gh_reply_impl(
    state: &RepoState,
    number: u64,
    comment_id: u64,
    body: String,
) -> Result<PrReviewComment, String> {
    with_repo_unlocked(state, |repo| {
        repo.reply_to_review_comment(&Gh::system(), number, comment_id, &body)
    })
}

fn gh_resolve_thread_impl(
    state: &RepoState,
    thread_id: String,
    resolve: bool,
) -> Result<(), String> {
    with_repo_unlocked(state, |repo| {
        repo.resolve_review_thread(&Gh::system(), &thread_id, resolve)
    })
}

fn gh_line_comment_impl(
    state: &RepoState,
    number: u64,
    comment: LineComment,
) -> Result<PrReviewComment, String> {
    with_repo_unlocked(state, |repo| {
        repo.comment_on_line(&Gh::system(), number, &comment)
    })
}

fn gh_review_with_comments_impl(
    state: &RepoState,
    number: u64,
    verdict: ReviewVerdict,
    body: String,
    comments: Vec<LineComment>,
) -> Result<String, String> {
    with_repo_unlocked(state, |repo| {
        repo.review_with_comments(&Gh::system(), number, verdict, &body, &comments)
    })
}

/// Run the user's review command over pull request `number` of the repository
/// at `path` — named, not the active one, so switching tabs while it runs
/// changes nothing. Holds no lock while the model thinks; one review per pull
/// request at a time. A review can run for most of an hour, so it stays out
/// of the status bar's network operations: it is a Claude job, with its own
/// Stop. `label` names it in the jobs list ("Review with Skill").
fn gh_generate_review_impl(
    jobs: &ClaudeJobs,
    path: String,
    number: u64,
    command: String,
    label: Option<String>,
) -> Result<GeneratedReview, String> {
    let mut repo = Repo::open(&path).map_err(to_message)?;
    let run = jobs.begin(NewJob {
        kind: JobKind::Review,
        label: format!("{} · #{number}", label.as_deref().unwrap_or("Review")),
        activity: String::new(),
        repo: path,
        pr: number,
        thread: None,
        finding: None,
        branch: None,
        command: command.clone(),
        stdin_bytes: 0,
    })?;
    repo.set_network_hooks(run.hooks());
    let out = repo
        .generate_review_drafts(&Gh::system(), number, &command)
        .map_err(to_message);
    run.finish(
        out.as_ref().map(|r| r.text.clone()).map_err(Clone::clone),
        &[],
    );
    out
}

/// Run one Claude turn on the thread of `input` in the repository at `path`
/// — named, not the active one — and return the conversation it is kept in.
fn gh_thread_turn_impl(
    jobs: &ClaudeJobs,
    path: String,
    input: ThreadInput,
    kind: TurnKind,
    user_text: String,
    command: String,
) -> Result<ThreadConversation, String> {
    let job = thread_job(&path, &input, kind, &command, user_text.len())?;
    let mut repo = Repo::open(&path).map_err(to_message)?;
    let run = jobs.begin(job)?;
    repo.set_network_hooks(run.hooks());
    let out = repo
        .thread_claude_turn(&Gh::system(), &input, kind, &user_text, &command)
        .map_err(to_message);
    finish_turn(run, &path, &out);
    out
}

/// The job of a turn of `kind` on the thread of `input`: one per thread.
fn thread_job(
    path: &str,
    input: &ThreadInput,
    kind: TurnKind,
    command: &str,
    stdin_bytes: usize,
) -> Result<NewJob, String> {
    let Some(root) = input.comments.first() else {
        return Err("The thread has no comments.".into());
    };
    let file = root.path.rsplit('/').next().unwrap_or(&root.path);
    let place = match root.line.or(root.original_line) {
        Some(line) => format!("{file}:{line}"),
        None => file.to_string(),
    };
    Ok(NewJob {
        kind: JobKind::Thread,
        label: format!("{place} · #{}", input.number),
        activity: match kind {
            TurnKind::Check => "Check",
            TurnKind::Explain => "Explain simply",
            TurnKind::Followup => "Follow-up",
            TurnKind::ReplyDraft => "Reply",
            TurnKind::Fix => "Fix",
        }
        .into(),
        repo: path.to_string(),
        pr: input.number,
        thread: Some(root.id),
        finding: None,
        branch: None,
        command: command.to_string(),
        stdin_bytes,
    })
}

/// End a thread job's turn with its answer; the sessions it keeps join the
/// job, for a command whose session came only in its JSON answer.
fn finish_turn(run: Running, path: &str, out: &Result<ThreadConversation, String>) {
    let mut sessions = Vec::new();
    if let Ok(c) = out {
        for s in [&c.session, &c.fix_session].into_iter().flatten() {
            sessions.push((s.clone(), path.to_string()));
        }
    }
    let answer = out
        .as_ref()
        .map(|c| c.turns.last().map(|t| t.text.clone()).unwrap_or_default())
        .map_err(Clone::clone);
    run.finish(answer, &sessions);
}

/// The fixes running, by repository path and branch: one at a time per
/// branch, since they share its worktree — a thread's fix, a pull request
/// draft's and a branch review draft's alike.
#[derive(Default)]
pub(crate) struct FixJobs(Mutex<HashMap<(String, String), ()>>);

impl FixJobs {
    /// Take the branch's fix lock, or say a fix holds it.
    pub(crate) fn hold(&self, path: &str, branch: &str) -> Result<(), String> {
        let mut running = self.0.lock().unwrap();
        let key = (path.to_string(), branch.to_string());
        if running.contains_key(&key) {
            return Err(format!("A fix is already running on {branch}."));
        }
        running.insert(key, ());
        Ok(())
    }

    pub(crate) fn release(&self, path: &str, branch: &str) {
        self.0
            .lock()
            .unwrap()
            .remove(&(path.to_string(), branch.to_string()));
    }
}

/// Fix the thread of `input` as the user chose, in the worktree of the pull
/// request's `branch`: the thread lock as a turn, plus the pull request's
/// fix lock.
fn gh_thread_fix_impl(
    jobs: &ClaudeJobs,
    fixes: &FixJobs,
    path: String,
    input: ThreadInput,
    branch: String,
    fix_command: String,
    reply_command: String,
) -> Result<ThreadConversation, String> {
    let job = thread_job(&path, &input, TurnKind::Fix, &fix_command, 0)?;
    fixes.hold(&path, &branch)?;
    let out = jobs.begin(job).and_then(|run| {
        let out = Repo::open(&path).map_err(to_message).and_then(|mut repo| {
            repo.set_network_hooks(run.hooks());
            repo.fix_thread(&Gh::system(), &input, &branch, &fix_command, &reply_command)
                .map_err(to_message)
        });
        finish_turn(run, &path, &out);
        out
    });
    fixes.release(&path, &branch);
    out
}

fn gh_thread_mark_posted_impl(
    path: String,
    number: u64,
    thread: u64,
    url: String,
) -> Result<(), String> {
    let repo = Repo::open(&path).map_err(to_message)?;
    repo.mark_reply_posted(number, thread, &url)
        .map_err(to_message)
}

fn gh_thread_drop_reply_impl(path: String, number: u64, thread: u64) -> Result<(), String> {
    let repo = Repo::open(&path).map_err(to_message)?;
    repo.drop_reply(number, thread).map_err(to_message)
}

fn gh_thread_conversation_impl(
    path: String,
    number: u64,
    thread: u64,
) -> Result<Option<ThreadConversation>, String> {
    let repo = Repo::open(&path).map_err(to_message)?;
    repo.thread_conversation(number, thread).map_err(to_message)
}

fn gh_thread_clear_impl(path: String, number: u64, thread: u64) -> Result<(), String> {
    let repo = Repo::open(&path).map_err(to_message)?;
    repo.clear_thread_conversation(number, thread)
        .map_err(to_message)
}

/// Search the repository's conversations: last turn in `[from, to)` epoch
/// milliseconds (either end open when missing), on pull request `pr` when given.
fn gh_thread_search_impl(
    path: String,
    query: String,
    from: Option<u64>,
    to: Option<u64>,
    pr: Option<u64>,
) -> Result<ThreadSearch, String> {
    let repo = Repo::open(&path).map_err(to_message)?;
    let range =
        (from.is_some() || to.is_some()).then(|| (from.unwrap_or(0), to.unwrap_or(u64::MAX)));
    repo.search_thread_conversations(&query, range, pr)
        .map_err(to_message)
}

/// Delete the conversations older than two months; how many went.
fn gh_thread_prune_impl(path: String) -> Result<usize, String> {
    let repo = Repo::open(&path).map_err(to_message)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let threads = repo.prune_thread_conversations(now).map_err(to_message)?;
    Ok(threads + repo.prune_stored_reviews(now).map_err(to_message)?)
}

/// How big a review file may be: a review is text, and this is far past any.
const REVIEW_FILE_LIMIT: u64 = 8 * 1024 * 1024;

/// The text of a review file the user picked in the file dialog — the
/// findings of a review written outside gitp, to load as draft comments. Any
/// path: the dialog chose it, and the file is read as text only.
fn read_review_file_impl(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("can't read {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path} is not a file"));
    }
    if meta.len() > REVIEW_FILE_LIMIT {
        return Err(format!("{path} is too big to be a review file"));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("can't read {path}: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// The pull request commit `commit` came in with — `number` when its message
/// names one — for the inline blame's card.
fn gh_commit_pull_request_impl(
    state: &RepoState,
    commit: String,
    number: Option<u64>,
) -> Result<Option<CommitPullRequest>, String> {
    with_repo_unlocked(state, |repo| {
        repo.commit_pull_request(&Gh::system(), &commit, number)
    })
}

/// The reviews saved under the open repo's `review/` folder, by pull request.
pub(crate) fn review_files_impl(state: &RepoState) -> Result<Vec<ReviewFile>, String> {
    with_repo_unlocked(state, |repo| Ok(repo.review_files()))
}

/// Explain finding `finding` of pull request `number`'s saved review again
/// ("Explain more"), with `command`, in the repository at `path`. Holds no
/// lock while the model thinks.
fn explain_review_finding_impl(
    jobs: &ClaudeJobs,
    path: String,
    number: u64,
    finding: String,
    command: String,
) -> Result<(), String> {
    let mut repo = Repo::open(&path).map_err(to_message)?;
    let run = jobs.begin(NewJob {
        kind: JobKind::Explain,
        label: format!("Explain more · finding {finding} · #{number}"),
        activity: String::new(),
        repo: path,
        pr: number,
        thread: None,
        finding: Some(finding.clone()),
        branch: None,
        command: command.clone(),
        stdin_bytes: 0,
    })?;
    repo.set_network_hooks(run.hooks());
    let out = repo
        .explain_review_finding(number, &finding, &command)
        .map_err(to_message);
    run.finish(out.clone().map(|()| String::new()), &[]);
    out
}

/// Open the saved review page at `path` in the default app — the browser, for
/// the HTML page. Only a file `review_files` lists: the frontend can't make
/// this open anything else.
fn open_review_page_impl(state: &RepoState, path: String) -> Result<(), String> {
    if !review_files_impl(state)?.iter().any(|f| f.path == path) {
        return Err(format!("{path} is not a saved review of this repository"));
    }
    open_in_default_app(std::path::Path::new(&path))
}

/// Start a sign-in, stopping one already waiting (a second click on Sign In).
fn gh_login_start_impl(logins: &GhLoginState) -> Result<DeviceCode, String> {
    gh_login_cancel_impl(logins);
    let login = Gh::system().start_login().map_err(to_message)?;
    let code = DeviceCode {
        code: login.code().to_string(),
        url: login.url().to_string(),
    };
    *logins.cancel.lock().map_err(to_message)? = Some(login.cancel_flag());
    *logins.pending.lock().map_err(to_message)? = Some(login);
    Ok(code)
}

/// Wait for the sign-in started last to finish. Returns gh's last word.
fn gh_login_wait_impl(logins: &GhLoginState) -> Result<String, String> {
    let login = logins
        .pending
        .lock()
        .map_err(to_message)?
        .take()
        .ok_or("no sign-in is in progress")?;
    login.wait(LOGIN_TIMEOUT).map_err(to_message)
}

fn gh_login_cancel_impl(logins: &GhLoginState) {
    if let Ok(mut cancel) = logins.cancel.lock() {
        if let Some(flag) = cancel.take() {
            flag.store(true, Ordering::SeqCst);
        }
    }
    // Not waited on yet: dropping it stops gh.
    if let Ok(mut pending) = logins.pending.lock() {
        pending.take();
    }
}

fn gh_logout_impl(login: Option<String>) -> Result<String, String> {
    Gh::system().logout(login.as_deref()).map_err(to_message)
}

/// Open a pull request, a check's page or GitHub's sign-in page. Only
/// https: the URLs come from GitHub's answers, but `open` would run anything.
fn open_github_url_impl(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err(format!("not an https URL: {url}"));
    }
    open_in_browser(&url).map_err(to_message)
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn gh_account() -> Result<GhAccount, String> {
    gh_account_impl()
}

#[tauri::command(async)]
pub(crate) fn gh_repo(state: State<RepoState>) -> Option<String> {
    gh_repo_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn gh_pull_requests(
    filter: PrFilter,
    state: State<RepoState>,
) -> Result<Vec<PullRequest>, String> {
    gh_pull_requests_impl(&state, filter)
}

#[tauri::command(async)]
pub(crate) fn gh_pull_request(
    number: u64,
    state: State<RepoState>,
) -> Result<PullRequestDetail, String> {
    gh_pull_request_impl(&state, number)
}

/// The pull request's signature (gitp-core's `PrSignature`): what the pull
/// request view polls to know when to read it again.
#[tauri::command(async)]
pub(crate) fn gh_pull_request_signature(
    number: u64,
    state: State<RepoState>,
) -> Result<gitp_core::PrSignature, String> {
    with_repo_unlocked(&state, |repo| {
        repo.pull_request_signature(&Gh::system(), number)
    })
}

/// The CI of `branch`'s newest pushed commit, for the status bar.
#[tauri::command(async)]
pub(crate) fn gh_branch_ci(
    branch: String,
    state: State<RepoState>,
) -> Result<gitp_core::BranchCi, String> {
    with_repo_unlocked(&state, |repo| repo.branch_ci(&Gh::system(), &branch))
}

/// Which files of the pull request are marked Viewed on GitHub.
#[tauri::command(async)]
pub(crate) fn gh_pull_request_viewed(
    number: u64,
    state: State<RepoState>,
) -> Result<gitp_core::PrViewed, String> {
    with_repo_unlocked(&state, |repo| {
        repo.pull_request_viewed(&Gh::system(), number)
    })
}

/// Mark a file of the pull request (by its node id) Viewed on GitHub, or not.
#[tauri::command(async)]
pub(crate) fn gh_set_pull_request_file_viewed(
    pr_id: String,
    path: String,
    viewed: bool,
    state: State<RepoState>,
) -> Result<(), String> {
    with_repo_unlocked(&state, |repo| {
        repo.set_pull_request_file_viewed(&Gh::system(), &pr_id, &path, viewed)
    })
}

#[tauri::command(async)]
pub(crate) fn gh_pull_request_files(
    number: u64,
    state: State<RepoState>,
) -> Result<Vec<FileDiff>, String> {
    gh_pull_request_files_impl(&state, number)
}

#[tauri::command(async)]
pub(crate) fn gh_commit_files(
    oid: String,
    state: State<RepoState>,
) -> Result<Vec<FileDiff>, String> {
    with_repo_unlocked(&state, |repo| repo.github_commit_files(&Gh::system(), &oid))
}

#[tauri::command(async)]
pub(crate) fn gh_checkout_pull_request(
    number: u64,
    state: State<RepoState>,
) -> Result<String, String> {
    gh_checkout_pull_request_impl(&state, number)
}

#[tauri::command(async)]
pub(crate) fn gh_checkout_pull_request_worktree(
    number: u64,
    path: String,
    state: State<RepoState>,
) -> Result<String, String> {
    gh_checkout_pull_request_worktree_impl(&state, number, path)
}

#[tauri::command(async)]
pub(crate) fn gh_comment(
    number: u64,
    body: String,
    state: State<RepoState>,
) -> Result<String, String> {
    gh_comment_impl(&state, number, body)
}

#[tauri::command(async)]
pub(crate) fn gh_review(
    number: u64,
    verdict: ReviewVerdict,
    body: String,
    state: State<RepoState>,
) -> Result<String, String> {
    gh_review_impl(&state, number, verdict, body)
}

#[tauri::command(async)]
pub(crate) fn gh_repo_settings(state: State<RepoState>) -> Result<GitHubRepoSettings, String> {
    gh_repo_settings_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn gh_pull_request_draft(
    branch: String,
    base: String,
    state: State<RepoState>,
) -> Result<PrDraft, String> {
    gh_pull_request_draft_impl(&state, branch, base)
}

#[tauri::command(async)]
pub(crate) fn gh_create_pull_request(
    pr: NewPullRequest,
    state: State<RepoState>,
) -> Result<u64, String> {
    gh_create_pull_request_impl(&state, pr)
}

#[tauri::command(async)]
pub(crate) fn gh_merge_pull_request(
    number: u64,
    method: MergeMethod,
    delete_branch: bool,
    state: State<RepoState>,
) -> Result<String, String> {
    gh_merge_pull_request_impl(&state, number, method, delete_branch)
}

#[tauri::command(async)]
pub(crate) fn gh_reply(
    number: u64,
    comment_id: u64,
    body: String,
    state: State<RepoState>,
) -> Result<PrReviewComment, String> {
    gh_reply_impl(&state, number, comment_id, body)
}

#[tauri::command(async)]
pub(crate) fn gh_resolve_thread(
    thread_id: String,
    resolve: bool,
    state: State<RepoState>,
) -> Result<(), String> {
    gh_resolve_thread_impl(&state, thread_id, resolve)
}

#[tauri::command(async)]
pub(crate) fn gh_review_with_comments(
    number: u64,
    verdict: ReviewVerdict,
    body: String,
    comments: Vec<LineComment>,
    state: State<RepoState>,
) -> Result<String, String> {
    gh_review_with_comments_impl(&state, number, verdict, body, comments)
}

#[tauri::command(async)]
pub(crate) fn gh_generate_review(
    path: String,
    number: u64,
    command: String,
    label: Option<String>,
    jobs: State<ClaudeJobs>,
) -> Result<GeneratedReview, String> {
    gh_generate_review_impl(&jobs, path, number, command, label)
}

#[tauri::command]
pub(crate) fn gh_cancel_review(path: String, number: u64, jobs: State<ClaudeJobs>) {
    jobs.stop_matching(JobKind::Review, &path, number, None);
}

#[tauri::command(async)]
pub(crate) fn gh_thread_turn(
    path: String,
    input: ThreadInput,
    kind: TurnKind,
    user_text: String,
    command: String,
    jobs: State<ClaudeJobs>,
) -> Result<ThreadConversation, String> {
    gh_thread_turn_impl(&jobs, path, input, kind, user_text, command)
}

#[tauri::command]
pub(crate) fn gh_thread_cancel(path: String, number: u64, thread: u64, jobs: State<ClaudeJobs>) {
    jobs.stop_matching(JobKind::Thread, &path, number, Some(thread));
}

#[tauri::command(async)]
pub(crate) fn gh_thread_conversation(
    path: String,
    number: u64,
    thread: u64,
) -> Result<Option<ThreadConversation>, String> {
    gh_thread_conversation_impl(path, number, thread)
}

#[tauri::command(async)]
pub(crate) fn gh_thread_clear(path: String, number: u64, thread: u64) -> Result<(), String> {
    gh_thread_clear_impl(path, number, thread)
}

#[tauri::command(async)]
pub(crate) fn gh_thread_prune(path: String) -> Result<usize, String> {
    gh_thread_prune_impl(path)
}

#[tauri::command(async)]
pub(crate) fn gh_thread_search(
    path: String,
    query: String,
    from: Option<u64>,
    to: Option<u64>,
    pr: Option<u64>,
) -> Result<ThreadSearch, String> {
    gh_thread_search_impl(path, query, from, to, pr)
}

#[tauri::command(async)]
pub(crate) fn gh_thread_fix(
    path: String,
    input: ThreadInput,
    branch: String,
    fix_command: String,
    reply_command: String,
    jobs: State<ClaudeJobs>,
    fixes: State<FixJobs>,
) -> Result<ThreadConversation, String> {
    gh_thread_fix_impl(
        &jobs,
        &fixes,
        path,
        input,
        branch,
        fix_command,
        reply_command,
    )
}

#[tauri::command(async)]
pub(crate) fn gh_thread_mark_posted(
    path: String,
    number: u64,
    thread: u64,
    url: String,
) -> Result<(), String> {
    gh_thread_mark_posted_impl(path, number, thread, url)
}

#[tauri::command(async)]
pub(crate) fn gh_thread_drop_reply(path: String, number: u64, thread: u64) -> Result<(), String> {
    gh_thread_drop_reply_impl(path, number, thread)
}

/// Apply review suggestions in the worktree of the pull request's `branch`,
/// as one commit (see `Repo::apply_suggestions`); the new commit.
#[tauri::command(async)]
pub(crate) fn gh_apply_suggestions(
    path: String,
    number: u64,
    head: String,
    branch: String,
    suggestions: Vec<gitp_core::Suggestion>,
) -> Result<String, String> {
    let repo = Repo::open(&path).map_err(to_message)?;
    repo.apply_suggestions(number, &head, &branch, &suggestions)
        .map_err(to_message)
}

/// Merge the base into the pull request's branch in its worktree and let
/// `command` (Claude) resolve the conflicts; the merge then waits for an
/// approve or a discard (see `Repo::resolve_pr_conflicts`). A Claude job,
/// under the pull request's fix lock: one change at a time in the worktree.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn gh_resolve_conflicts(
    path: String,
    number: u64,
    head: String,
    branch: String,
    base: String,
    command: String,
    jobs: State<ClaudeJobs>,
    fixes: State<FixJobs>,
) -> Result<ConflictResolution, String> {
    fixes.hold(&path, &branch)?;
    let out = jobs
        .begin(NewJob {
            kind: JobKind::Resolve,
            label: format!("Resolve conflicts · #{number}"),
            activity: String::new(),
            repo: path.clone(),
            pr: number,
            thread: None,
            finding: None,
            branch: Some(branch.clone()),
            command: command.clone(),
            stdin_bytes: 0,
        })
        .and_then(|run| {
            let out = Repo::open(&path).map_err(to_message).and_then(|mut repo| {
                repo.set_network_hooks(run.hooks());
                repo.resolve_pr_conflicts(number, &head, &branch, &base, &command)
                    .map_err(to_message)
            });
            run.finish(
                out.as_ref()
                    .map(|r| r.summary.clone())
                    .map_err(Clone::clone),
                &[],
            );
            out
        });
    fixes.release(&path, &branch);
    out
}

/// Commit the waiting merge and push the branch; the merge commit.
#[tauri::command(async)]
pub(crate) fn gh_approve_conflicts(
    path: String,
    branch: String,
    before: String,
    fixes: State<FixJobs>,
) -> Result<String, String> {
    fixes.hold(&path, &branch)?;
    let out = Repo::open(&path)
        .and_then(|repo| repo.approve_conflict_resolution(&branch, &before))
        .map_err(to_message);
    fixes.release(&path, &branch);
    out
}

/// Abort the waiting merge, back to where the branch was.
#[tauri::command(async)]
pub(crate) fn gh_discard_conflicts(
    path: String,
    branch: String,
    before: String,
    fixes: State<FixJobs>,
) -> Result<(), String> {
    fixes.hold(&path, &branch)?;
    let out = Repo::open(&path)
        .and_then(|repo| repo.discard_conflict_resolution(&branch, &before))
        .map_err(to_message);
    fixes.release(&path, &branch);
    out
}

/// Record the user's chosen option on a thread, unanswered, for Fix to take.
#[tauri::command(async)]
pub(crate) fn gh_thread_choose(
    path: String,
    number: u64,
    thread: u64,
    text: String,
) -> Result<ThreadConversation, String> {
    let repo = Repo::open(&path).map_err(to_message)?;
    repo.record_thread_choice(number, thread, &text)
        .map_err(to_message)
}

#[tauri::command(async)]
pub(crate) fn read_review_file(path: String) -> Result<String, String> {
    read_review_file_impl(path)
}

#[tauri::command(async)]
pub(crate) fn gh_commit_pull_request(
    commit: String,
    number: Option<u64>,
    state: State<RepoState>,
) -> Result<Option<CommitPullRequest>, String> {
    gh_commit_pull_request_impl(&state, commit, number)
}

#[tauri::command(async)]
pub(crate) fn review_files(state: State<RepoState>) -> Result<Vec<ReviewFile>, String> {
    review_files_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn explain_review_finding(
    path: String,
    number: u64,
    finding: String,
    command: String,
    jobs: State<ClaudeJobs>,
) -> Result<(), String> {
    explain_review_finding_impl(&jobs, path, number, finding, command)
}

#[tauri::command(async)]
pub(crate) fn open_review_page(path: String, state: State<RepoState>) -> Result<(), String> {
    open_review_page_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn gh_line_comment(
    number: u64,
    comment: LineComment,
    state: State<RepoState>,
) -> Result<PrReviewComment, String> {
    gh_line_comment_impl(&state, number, comment)
}

#[tauri::command(async)]
pub(crate) fn gh_login_start(logins: State<GhLoginState>) -> Result<DeviceCode, String> {
    gh_login_start_impl(&logins)
}

#[tauri::command(async)]
pub(crate) fn gh_login_wait(logins: State<GhLoginState>) -> Result<String, String> {
    gh_login_wait_impl(&logins)
}

#[tauri::command(async)]
pub(crate) fn gh_login_cancel(logins: State<GhLoginState>) {
    gh_login_cancel_impl(&logins)
}

#[tauri::command(async)]
pub(crate) fn gh_logout(login: Option<String>) -> Result<String, String> {
    gh_logout_impl(login)
}

#[tauri::command(async)]
pub(crate) fn open_github_url(url: String) -> Result<(), String> {
    open_github_url_impl(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_thread_turn_runs_once_per_thread_and_is_keyed_by_path() {
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(dir.path())
                .env("GIT_AUTHOR_NAME", "T")
                .env("GIT_AUTHOR_EMAIL", "t@example.com")
                .env("GIT_COMMITTER_NAME", "T")
                .env("GIT_COMMITTER_EMAIL", "t@example.com")
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init", "-q"]);
        git(&["commit", "-q", "--allow-empty", "-m", "init"]);
        git(&["remote", "add", "origin", "git@github.com:octo/hello.git"]);
        let head = git(&["rev-parse", "HEAD"]);
        let path = dir.path().to_string_lossy().into_owned();
        let input = |n| gitp_core::ThreadInput {
            number: n,
            head: head.clone(),
            author: "octocat".into(),
            title: Some("Retry fix".into()),
            comments: vec![PrReviewComment {
                id: 500,
                author: "anna".into(),
                body: "?".into(),
                path: "a".into(),
                line: Some(1),
                original_line: Some(1),
                start_line: None,
                side: "RIGHT".into(),
                created_at: String::new(),
                in_reply_to: None,
                url: String::new(),
                diff_hunk: String::new(),
            }],
        };
        let jobs = ClaudeJobs::default();
        // Hold the thread as if a turn were running.
        let held = jobs
            .begin(thread_job(&path, &input(7), TurnKind::Check, "", 0).unwrap())
            .unwrap();
        let err = gh_thread_turn_impl(
            &jobs,
            path.clone(),
            input(7),
            TurnKind::Check,
            String::new(),
            "echo hi".into(),
        )
        .unwrap_err();
        assert!(err.contains("already running"), "{err}");
        // Another thread of the same pull request is free.
        let c = gh_thread_turn_impl(
            &jobs,
            path.clone(),
            input(8),
            TurnKind::Check,
            String::new(),
            "echo hi".into(),
        )
        .unwrap();
        assert_eq!(c.turns[0].text.trim(), "hi");
        assert_eq!(
            jobs.running(),
            ["Check · a:1 · #7"],
            "the turn on #8 is released"
        );
        held.finish(Ok(String::new()), &[]);
        assert_eq!(
            gh_thread_conversation_impl(path.clone(), 8, 500).unwrap(),
            Some(c)
        );
        let found =
            gh_thread_search_impl(path.clone(), "retry HI".into(), None, None, None).unwrap();
        assert_eq!(
            (
                found.total,
                found.hits[0].pr,
                found.hits[0].title.as_deref()
            ),
            (1, 8, Some("Retry fix"))
        );
        assert_eq!(
            gh_thread_search_impl(path.clone(), "hi".into(), None, None, Some(7))
                .unwrap()
                .total,
            0
        );
        assert_eq!(
            gh_thread_search_impl(path.clone(), "hi".into(), Some(0), Some(1), None)
                .unwrap()
                .total,
            0
        );
        assert_eq!(
            gh_thread_search_impl(path.clone(), "hi".into(), Some(0), None, None)
                .unwrap()
                .total,
            1,
            "from alone"
        );
        gh_thread_clear_impl(path.clone(), 8, 500).unwrap();
        assert_eq!(
            gh_thread_conversation_impl(path.clone(), 8, 500).unwrap(),
            None
        );
        assert_eq!(gh_thread_prune_impl(path.clone()).unwrap(), 0);
        let empty = gitp_core::ThreadInput {
            comments: vec![],
            ..input(9)
        };
        assert!(gh_thread_turn_impl(
            &jobs,
            path,
            empty,
            TurnKind::Check,
            String::new(),
            "echo".into()
        )
        .is_err());
    }

    #[test]
    fn a_fix_is_refused_while_another_runs_on_the_pull_request() {
        let jobs = ClaudeJobs::default();
        let fixes = FixJobs::default();
        let comment = PrReviewComment {
            id: 500,
            author: "anna".into(),
            body: "?".into(),
            path: "a".into(),
            line: Some(1),
            original_line: Some(1),
            start_line: None,
            side: "RIGHT".into(),
            created_at: String::new(),
            in_reply_to: None,
            url: String::new(),
            diff_hunk: String::new(),
        };
        let input = |comments: Vec<PrReviewComment>| gitp_core::ThreadInput {
            number: 7,
            head: "0".repeat(40),
            author: "octocat".into(),
            title: None,
            comments,
        };
        fixes.hold("/nowhere", "b").unwrap();
        let err = gh_thread_fix_impl(
            &jobs,
            &fixes,
            "/nowhere".into(),
            input(vec![comment.clone()]),
            "b".into(),
            "true".into(),
            "true".into(),
        )
        .unwrap_err();
        assert!(err.contains("already running on b"), "{err}");
        fixes.release("/nowhere", "b");
        // No comments: refused before any lock is taken.
        assert!(gh_thread_fix_impl(
            &jobs,
            &fixes,
            "/nowhere".into(),
            input(vec![]),
            "b".into(),
            "true".into(),
            "true".into()
        )
        .is_err());
        assert!(fixes.0.lock().unwrap().is_empty() && jobs.running().is_empty());
        // A repository that doesn't exist fails and releases both locks.
        assert!(gh_thread_fix_impl(
            &jobs,
            &fixes,
            "/nowhere".into(),
            input(vec![comment]),
            "b".into(),
            "true".into(),
            "true".into()
        )
        .is_err());
        assert!(fixes.0.lock().unwrap().is_empty() && jobs.running().is_empty());
    }
}
