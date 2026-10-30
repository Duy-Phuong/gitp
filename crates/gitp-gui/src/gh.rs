//! GitHub pull requests through the user's own `gh` login (see gitp-core's
//! `gh`): the account, signing in and out, the sidebar's list, the pull
//! request view, checking one out, and commenting and reviewing.
//!
//! The reads and posts run on a repo handle of their own, without the
//! workspace lock — each is a round trip to GitHub. Checking out moves HEAD,
//! so it runs as a network operation, with Cancel.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use gitp_core::{
    FileDiff, Gh, GhAccount, GhLogin, LineComment, PrFilter, PrReviewComment, PullRequest,
    PullRequestDetail, ReviewVerdict, LOGIN_TIMEOUT,
};
use serde::Serialize;
use tauri::State;

use crate::os::open_in_browser;
use crate::state::{
    invalidate_status, to_message, with_repo, with_repo_networked, with_repo_unlocked, RepoState,
};
use crate::undo::clear_undo;

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
    with_repo(state, |repo| Ok(repo.github_repo())).ok().flatten()
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
    with_repo_networked(
        state,
        "fetch",
        |repo| repo.checkout_pull_request(&Gh::system(), number),
        |session| {
            clear_undo(session);
            invalidate_status(session);
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

fn gh_line_comment_impl(
    state: &RepoState,
    number: u64,
    comment: LineComment,
) -> Result<PrReviewComment, String> {
    with_repo_unlocked(state, |repo| {
        repo.comment_on_line(&Gh::system(), number, &comment)
    })
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

#[tauri::command(async)]
pub(crate) fn gh_pull_request_files(
    number: u64,
    state: State<RepoState>,
) -> Result<Vec<FileDiff>, String> {
    gh_pull_request_files_impl(&state, number)
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
pub(crate) fn gh_reply(
    number: u64,
    comment_id: u64,
    body: String,
    state: State<RepoState>,
) -> Result<PrReviewComment, String> {
    gh_reply_impl(&state, number, comment_id, body)
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
