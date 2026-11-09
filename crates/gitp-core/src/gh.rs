//! GitHub pull requests through the GitHub CLI, `gh`, signed in as the user:
//! gitp never sees or stores a token — `gh` keeps it (in the system keychain)
//! and makes every request.
//!
//! `gh` is run directly, never through a shell. Each command names the
//! repository with `--repo`, worked out from the remotes the way `gh` itself
//! picks one, and asks for JSON (`--json`, or `gh api`). Whatever the user
//! wrote — a comment, a review, a reply — goes in on stdin, never on the
//! command line, where it could be taken for an option. Every run has a
//! timeout, so a `gh` waiting on something it can't get (an answer to a prompt,
//! a dead network) can't hang the GUI.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

mod signature;
pub use signature::PrSignature;

mod viewed;
pub use viewed::PrViewed;

mod reviewers;
pub use reviewers::PrReviewer;

mod ci;
pub use ci::BranchCi;

mod my_work;
pub use my_work::my_work_input;

use crate::branch_ops::parse_remote_url;
use crate::claude_transcript::new_session_id;
use crate::diff::{collect_files, FileDiff, MAX_DIFF_LINES};
use crate::encoding::TextEncoding;
use crate::error::{Error, Result};
use crate::git_bin::spawn_path;
use crate::pr_threads::{
    now_millis, ThreadComment, ThreadConversation, ThreadTurn, TurnKind, TurnRole,
};
use crate::progress::{kill, ClaudeRun, NetworkHooks};
use crate::repo::Repo;
use crate::worktree_ops::WorktreeTarget;

mod inbox;
pub use inbox::{inbox_repo, inbox_sources, InboxPr, InboxRepo};

/// The host gitp signs in to.
const GITHUB_HOST: &str = "github.com";

/// How long an ordinary `gh` call may take: a page of JSON, a posted comment.
const TIMEOUT: Duration = Duration::from_secs(60);
/// A checkout fetches the pull request's commits first, which on a big one
/// over a slow link takes a while. Cancel stops it sooner.
const CHECKOUT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long a sign-in waits for the user to approve it in the browser.
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// How long `gh auth login` gets to print its one-time code.
const CODE_TIMEOUT: Duration = Duration::from_secs(30);
/// How often a waiting run looks at the cancel flag and the clock.
const POLL: Duration = Duration::from_millis(50);
/// Where `gh` sends the user to enter the code, when it doesn't say.
const DEVICE_URL: &str = "https://github.com/login/device";

const NOT_INSTALLED: &str = "The GitHub CLI (gh) is not installed. Install it (for example with \
     `brew install gh`), then sign in to GitHub.";
const NOT_SIGNED_IN: &str = "gh is not signed in to GitHub. Sign in (the Pull Requests section's \
     Sign in to GitHub, or `gh auth login` in a terminal), then try again.";
const RATE_LIMITED: &str =
    "GitHub's API rate limit was reached. Wait a few minutes, then try again.";
const NO_GITHUB_REMOTE: &str = "This repository has no GitHub remote, so it has no pull requests.";

/// How gitp runs `gh`: which folders it is looked for in, and the PATH it
/// gets — the same as git's spawns, so a Homebrew `gh` is found from an app
/// launched from Finder, and the git it runs is the one gitp uses.
#[derive(Debug, Clone)]
pub struct Gh {
    path: OsString,
}

/// The `gh` account signed in to github.com, as `gh auth status` reports it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct GhAccount {
    pub installed: bool,
    pub signed_in: bool,
    pub login: Option<String>,
    /// The token's OAuth scopes (`repo`, `read:org`, ...), when gh shows them.
    pub scopes: Vec<String>,
    /// What went wrong when signed out for a reason — an expired token, say.
    pub message: Option<String>,
}

/// Which pull requests the sidebar lists: open ones, or the last merged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrFilter {
    All,
    /// Opened by the signed-in user.
    Mine,
    /// Waiting on the signed-in user's review.
    ReviewRequested,
    /// The last ones merged, newest first.
    Merged,
}

/// How many merged pull requests the Merged filter lists.
const MERGED_LIMIT: &str = "20";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrLabel {
    pub name: String,
    /// Hex, without the `#`.
    #[serde(default)]
    pub color: String,
}

/// A pull request as the sidebar lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub is_draft: bool,
    /// `APPROVED`, `CHANGES_REQUESTED` or `REVIEW_REQUIRED`; none when the
    /// repository asks for no review.
    pub review_decision: Option<String>,
    /// All of its checks in one word: `success`, `failure` or `pending`; none
    /// when it has no checks.
    pub checks: Option<String>,
    /// The branch it brings in, and the one it goes into.
    pub head: String,
    pub base: String,
    pub updated_at: String,
    pub url: String,
    pub labels: Vec<PrLabel>,
    /// When it was merged; none while it isn't.
    pub merged_at: Option<String>,
    /// The reviewers whose latest review approves it.
    pub approvals: u32,
    /// Its line-comment threads not resolved yet; none when GitHub didn't say.
    pub unresolved_threads: Option<u32>,
    /// Whether it has conflicts with its base: GitHub's `mergeable` is
    /// `CONFLICTING`. False while GitHub is still working it out.
    pub conflicting: bool,
}

/// One check run or commit status on the pull request's head.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrCheck {
    pub name: String,
    /// `success`, `failure`, `pending`, `neutral` or `skipped`.
    pub state: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrReview {
    pub author: String,
    /// `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED` or `DISMISSED`.
    pub state: String,
    pub body: String,
    pub submitted_at: String,
}

/// A comment on the pull request itself (not on a line).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrComment {
    pub id: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub url: String,
}

/// A comment on a line of the diff — the start of a thread, or a reply in one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrReviewComment {
    pub id: u64,
    pub author: String,
    pub body: String,
    pub path: String,
    /// The line it is on in the current diff; none once a later push moved
    /// the code away (an outdated comment).
    pub line: Option<u32>,
    /// The line it was written on.
    pub original_line: Option<u32>,
    /// The first line of a comment on several lines (a multi-line
    /// suggestion's range is `start_line..=line`); none on one line.
    pub start_line: Option<u32>,
    /// `RIGHT` for a line of the new file, `LEFT` for one of the old.
    pub side: String,
    pub created_at: String,
    /// The thread's first comment, for a reply.
    pub in_reply_to: Option<u64>,
    pub url: String,
    /// The diff around the line, ending with it.
    pub diff_hunk: String,
}

/// A line-comment thread's state, which only GitHub's GraphQL API knows:
/// resolved or not, and the comments in it (by the REST ids the view has).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrReviewThread {
    /// The thread's node id, for a resolve.
    pub id: String,
    pub resolved: bool,
    pub comment_ids: Vec<u64>,
}

/// A commit of a pull request, oldest first as GitHub lists them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrCommit {
    pub oid: String,
    pub headline: String,
    pub body: String,
    /// Logins, or names for authors without an account; co-authors too.
    pub authors: Vec<String>,
    pub committed_at: String,
}

/// Everything the pull request view shows but the changed files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PullRequestDetail {
    pub number: u64,
    pub title: String,
    pub body: String,
    /// `OPEN`, `CLOSED` or `MERGED`.
    pub state: String,
    pub is_draft: bool,
    pub author: String,
    pub base: String,
    pub head: String,
    /// The head commit — what a new line comment is made on.
    pub head_oid: String,
    pub url: String,
    pub created_at: String,
    pub review_decision: Option<String>,
    pub labels: Vec<PrLabel>,
    pub checks: Vec<PrCheck>,
    pub reviews: Vec<PrReview>,
    /// Who is asked for a review and hasn't answered since.
    pub review_requests: Vec<PrReviewer>,
    pub comments: Vec<PrComment>,
    pub review_comments: Vec<PrReviewComment>,
    /// Empty when the host doesn't answer the GraphQL query (threads are
    /// then shown without a resolved state).
    pub review_threads: Vec<PrReviewThread>,
    pub commits: Vec<PrCommit>,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    /// Whether it merges cleanly: `MERGEABLE`, `CONFLICTING`, or `UNKNOWN`
    /// while GitHub is still working it out.
    pub mergeable: String,
    /// GitHub's word on merging it now: `CLEAN`, `BLOCKED` (reviews or checks
    /// it requires), `BEHIND`, `DIRTY` (conflicts), `DRAFT`, `UNSTABLE`
    /// (failing checks it doesn't require), `HAS_HOOKS` or `UNKNOWN`.
    pub merge_state: String,
    /// When GitHub last saw anything happen on it.
    pub updated_at: String,
    /// What a poll compares against (see [`PrSignature`]), from this same
    /// read, so the view needs no call of its own to start polling. None when
    /// the threads couldn't be read: the first poll then sets it.
    pub signature: Option<PrSignature>,
}

/// What a review says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewVerdict {
    Approve,
    RequestChanges,
    Comment,
}

/// How a pull request is merged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeMethod {
    /// A merge commit.
    Merge,
    Squash,
    Rebase,
}

/// A pull request to open (see `Repo::create_pull_request`).
#[derive(Debug, Clone, Deserialize)]
pub struct NewPullRequest {
    /// The local branch it is made from.
    pub branch: String,
    /// The remote the branch is pushed to: a fork names it `owner:branch`.
    pub remote: String,
    /// The branch it is to merge into, on GitHub.
    pub base: String,
    pub title: String,
    pub body: String,
    pub draft: bool,
}

/// A title and description to start a new pull request from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrDraft {
    pub title: String,
    pub body: String,
}

/// What the repository on GitHub allows when merging, and its default branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitHubRepoSettings {
    pub default_branch: String,
    pub merge_commit: bool,
    pub squash: bool,
    pub rebase: bool,
    /// The repository deletes a merged pull request's branch by itself.
    pub delete_branch_on_merge: bool,
}

/// A new comment on one line of a pull request's diff.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineComment {
    pub path: String,
    pub line: u32,
    /// `RIGHT` (a line of the new file: added or unchanged) or `LEFT` (a
    /// removed one).
    pub side: DiffSide,
    /// The pull request's head commit the line was seen in.
    pub commit_id: String,
    pub body: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum DiffSide {
    Left,
    Right,
}

/// A `gh auth login` waiting for the user to enter its one-time code on
/// GitHub. Dropping it stops `gh`.
pub struct GhLogin {
    child: Option<Child>,
    lines: Receiver<String>,
    output: Vec<String>,
    code: String,
    url: String,
    cancel: Arc<AtomicBool>,
}

/// A finished `gh` run.
struct Output {
    stdout: Vec<u8>,
    stderr: String,
}

impl Output {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).trim().to_string()
    }

    /// stdout and stderr together: `gh pr checkout` reports on stderr.
    fn combined(&self) -> String {
        let out = self.text();
        let err = self.stderr.trim();
        match (out.is_empty(), err.is_empty()) {
            (_, true) => out,
            (true, false) => err.to_string(),
            (false, false) => format!("{out}\n{err}"),
        }
    }
}

impl Gh {
    pub fn system() -> Self {
        Self { path: spawn_path() }
    }

    /// `gh` from the folders of `path` (a PATH value) alone, which it is also
    /// given as its PATH.
    pub fn with_search_path(path: impl Into<OsString>) -> Self {
        Self { path: path.into() }
    }

    pub fn installed(&self) -> bool {
        self.program().is_some()
    }

    fn program(&self) -> Option<PathBuf> {
        std::env::split_paths(&self.path)
            .map(|dir| dir.join("gh"))
            .find(|p| is_executable(p))
    }

    fn command(&self, dir: Option<&Path>) -> Result<Command> {
        let program = self
            .program()
            .ok_or_else(|| Error::Message(NOT_INSTALLED.into()))?;
        let mut cmd = Command::new(program);
        cmd.env("PATH", &self.path)
            // There is no terminal to answer a question on: without these gh
            // would ask anyway, or wait for Enter, and hang until the timeout.
            .env("GH_PROMPT_DISABLED", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .env("GH_SPINNER_DISABLED", "1")
            .env("NO_COLOR", "1");
        if let Some(dir) = dir {
            cmd.current_dir(dir);
        }
        // Its own process group, so a timeout or Cancel also stops the git a
        // checkout started (see `kill`).
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
        Ok(cmd)
    }

    /// Run `gh <args>` in `dir` with `input` on stdin, and wait for it — at
    /// most `timeout`, and only until `cancel` goes up. Its exit status isn't
    /// judged here; see [`Gh::call`].
    fn run(
        &self,
        dir: Option<&Path>,
        args: &[&str],
        input: Option<&[u8]>,
        timeout: Duration,
        cancel: Option<&AtomicBool>,
    ) -> Result<(bool, Output)> {
        let mut cmd = self.command(dir)?;
        cmd.args(args)
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| Error::Message(format!("failed to run gh: {e}")))?;
        if let Some(input) = input {
            let mut stdin = child.stdin.take().expect("stdin is piped");
            let input = input.to_vec();
            // On a thread of its own: a body bigger than the pipe would block
            // here while gh blocks on output nobody reads yet. Dropping stdin
            // at the end is gh's end of input.
            thread::spawn(move || {
                let _ = stdin.write_all(&input);
            });
        }
        let stdout = drain(child.stdout.take().expect("stdout is piped"));
        let stderr = drain(child.stderr.take().expect("stderr is piped"));
        let deadline = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {}
                Err(e) => return Err(Error::Message(format!("failed to run gh: {e}"))),
            }
            if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
                return Err(kill(child));
            }
            if Instant::now() >= deadline {
                kill(child);
                return Err(Error::Message(format!(
                    "gh didn't finish within {} seconds, so it was stopped.",
                    timeout.as_secs()
                )));
            }
            thread::sleep(POLL);
        };
        let output = Output {
            stdout: stdout.join().unwrap_or_default(),
            stderr: String::from_utf8_lossy(&stderr.join().unwrap_or_default()).into_owned(),
        };
        Ok((status.success(), output))
    }

    /// [`Gh::run`], with a failure turned into an error that says what to do
    /// about it. `repo`: the `--repo` the command named, for the message when
    /// GitHub doesn't know it.
    fn call(
        &self,
        dir: Option<&Path>,
        args: &[&str],
        input: Option<&[u8]>,
        timeout: Duration,
        cancel: Option<&AtomicBool>,
        repo: Option<&str>,
    ) -> Result<Output> {
        let (ok, output) = self.run(dir, args, input, timeout, cancel)?;
        if ok {
            Ok(output)
        } else {
            Err(gh_failure(&output.combined(), repo))
        }
    }

    /// Who `gh` is signed in to github.com as. Asks GitHub, which checks the
    /// token is still good.
    pub fn account(&self) -> Result<GhAccount> {
        if !self.installed() {
            return Ok(GhAccount::default());
        }
        // Exits 1 when signed out, which is an answer here, not a failure.
        let (_, out) = self.run(
            None,
            &["auth", "status", "--hostname", GITHUB_HOST],
            None,
            TIMEOUT,
            None,
        )?;
        // gh 2.40 and later print the status on stdout, earlier ones on stderr.
        let text = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), out.stderr);
        Ok(GhAccount {
            installed: true,
            ..parse_auth_status(&text)
        })
    }

    /// Start `gh auth login`'s device flow — the browser sign-in that needs no
    /// terminal: `gh` prints a one-time code, the user enters it at GitHub's
    /// device page, and `gh` stores the token it then gets. Returns once the
    /// code is known; [`GhLogin::wait`] waits for the rest.
    pub fn start_login(&self) -> Result<GhLogin> {
        let mut cmd = self.command(None)?;
        cmd.args([
            "auth",
            "login",
            "--hostname",
            GITHUB_HOST,
            "--web",
            "--git-protocol",
            "https",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| Error::Message(format!("failed to run gh: {e}")))?;
        let (tx, lines) = mpsc::channel();
        let pipes: [Box<dyn Read + Send>; 2] = [
            Box::new(child.stdout.take().expect("stdout is piped")),
            Box::new(child.stderr.take().expect("stderr is piped")),
        ];
        for pipe in pipes {
            let tx = tx.clone();
            thread::spawn(move || {
                for line in BufReader::new(pipe).lines() {
                    let Ok(line) = line else { break };
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            });
        }
        drop(tx);
        let mut login = GhLogin {
            child: Some(child),
            lines,
            output: Vec::new(),
            code: String::new(),
            url: DEVICE_URL.to_string(),
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let deadline = Instant::now() + CODE_TIMEOUT;
        loop {
            match login.lines.recv_timeout(POLL) {
                Ok(line) => {
                    if let Some(code) = device_code(&line) {
                        login.code = code;
                    }
                    if let Some(url) = device_url(&line) {
                        login.url = url;
                    }
                    login.output.push(line);
                    if !login.code.is_empty() {
                        // The URL comes on the next line, printed with the code.
                        while let Ok(line) = login.lines.recv_timeout(POLL) {
                            if let Some(url) = device_url(&line) {
                                login.url = url;
                            }
                            login.output.push(line);
                        }
                        return Ok(login);
                    }
                }
                Err(RecvTimeoutError::Timeout) if Instant::now() < deadline => {}
                Err(RecvTimeoutError::Timeout) => {
                    return Err(Error::Message(
                        "gh didn't show a sign-in code, so the sign-in was stopped.".into(),
                    ))
                }
                // Both pipes closed: gh is done, without a code.
                Err(RecvTimeoutError::Disconnected) => {
                    let mut child = login.child.take().expect("not taken before");
                    let _ = child.wait();
                    return Err(gh_failure(&login.output.join("\n"), None));
                }
            }
        }
    }

    /// `gh auth logout` from github.com. gh wants to be told which account
    /// when it has more than one there; `login` is the one to sign out.
    pub fn logout(&self, login: Option<&str>) -> Result<String> {
        let args = ["auth", "logout", "--hostname", GITHUB_HOST];
        let (ok, out) = self.run(None, &args, None, TIMEOUT, None)?;
        if ok {
            return Ok(out.combined());
        }
        let user = login.filter(|u| !u.starts_with('-') && out.combined().contains("--user"));
        let Some(user) = user else {
            return Err(gh_failure(&out.combined(), None));
        };
        let mut args = args.to_vec();
        args.extend(["--user", user]);
        Ok(self
            .call(None, &args, None, TIMEOUT, None, None)?
            .combined())
    }
}

impl GhLogin {
    /// The code to enter on GitHub.
    pub fn code(&self) -> &str {
        &self.code
    }

    /// The page to enter it on.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Raising it stops the sign-in: `wait` kills `gh` and returns
    /// [`Error::Cancelled`].
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }

    /// Wait for `gh` to finish — the user approved, or GitHub refused — at
    /// most `timeout`. Returns what `gh` said last.
    pub fn wait(mut self, timeout: Duration) -> Result<String> {
        let deadline = Instant::now() + timeout;
        loop {
            while let Ok(line) = self.lines.try_recv() {
                self.output.push(line);
            }
            let child = self.child.as_mut().expect("taken only on return");
            match child.try_wait() {
                Ok(Some(status)) => {
                    // What it printed as it exited.
                    while let Ok(line) = self.lines.recv_timeout(POLL) {
                        self.output.push(line);
                    }
                    self.child = None;
                    let text = self.output.join("\n");
                    return if status.success() {
                        Ok(text.lines().last().unwrap_or("").trim().to_string())
                    } else {
                        Err(gh_failure(&text, None))
                    };
                }
                Ok(None) => {}
                Err(e) => return Err(Error::Message(format!("failed to run gh: {e}"))),
            }
            if self.cancel.load(Ordering::SeqCst) {
                return Err(kill(self.child.take().expect("still running")));
            }
            if Instant::now() >= deadline {
                kill(self.child.take().expect("still running"));
                return Err(Error::Message(format!(
                    "The sign-in wasn't approved within {} minutes, so it was stopped.",
                    timeout.as_secs() / 60
                )));
            }
            thread::sleep(POLL);
        }
    }
}

impl Drop for GhLogin {
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            kill(child);
        }
    }
}

/// The GitHub repository a local one's pull requests are in.
#[derive(Debug, Clone, PartialEq, Eq)]
struct GitHubRepo {
    host: String,
    /// `owner/name`.
    path: String,
}

impl GitHubRepo {
    /// The `--repo` value: `owner/name`, with the host in front when it isn't
    /// github.com (GitHub Enterprise).
    fn repo_arg(&self) -> String {
        if self.host == GITHUB_HOST {
            self.path.clone()
        } else {
            format!("{}/{}", self.host, self.path)
        }
    }

    /// `gh api` and its `--hostname` when needed, up to the method.
    fn api<'a>(&'a self, args: &mut Vec<&'a str>) {
        args.push("api");
        if self.host != GITHUB_HOST {
            args.extend(["--hostname", &self.host]);
        }
    }
}

impl Repo {
    /// The GitHub repository this one's pull requests are in (`owner/name`,
    /// with a host in front for GitHub Enterprise), or none without a GitHub
    /// remote. Read from the remotes alone; no network.
    pub fn github_repo(&self) -> Option<String> {
        self.find_github_repo().map(|r| r.repo_arg())
    }

    /// Like `gh`: the remote it was told is the base (`gh repo set-default`
    /// sets `remote.<name>.gh-resolved`), else `upstream` — in a fork, where
    /// the pull requests are — then `github`, then `origin`, then any other.
    fn find_github_repo(&self) -> Option<GitHubRepo> {
        self.find_github_remote().map(|(_, repo)| repo)
    }

    /// The name of the remote `find_github_remote` picks.
    pub(crate) fn github_remote_name(&self) -> Option<String> {
        self.find_github_remote().map(|(name, _)| name)
    }

    /// `find_github_repo` with the name of the remote it was found on.
    fn find_github_remote(&self) -> Option<(String, GitHubRepo)> {
        let names = self.inner.remotes().ok()?;
        let config = self.inner.config().ok();
        let rank = |name: &str| {
            let resolved = config
                .as_ref()
                .and_then(|c| c.get_string(&format!("remote.{name}.gh-resolved")).ok());
            if resolved.as_deref() == Some("base") {
                return 0;
            }
            match name {
                "upstream" => 1,
                "github" => 2,
                "origin" => 3,
                _ => 4,
            }
        };
        let mut names: Vec<&str> = names.iter().flatten().collect();
        names.sort_by_key(|n| (rank(n), *n));
        names.into_iter().find_map(|name| {
            let remote = self.inner.find_remote(name).ok()?;
            Some((name.to_string(), github_repo_from_url(remote.url()?)?))
        })
    }

    fn github_target(&self) -> Result<GitHubRepo> {
        self.find_github_repo()
            .ok_or_else(|| Error::Message(NO_GITHUB_REMOTE.into()))
    }

    /// Run `gh` in this working tree for `target`, honouring the network
    /// hooks' cancel flag.
    fn gh_call(
        &self,
        gh: &Gh,
        target: &GitHubRepo,
        args: &[&str],
        input: Option<&[u8]>,
        timeout: Duration,
    ) -> Result<Output> {
        gh.call(
            Some(self.workdir()),
            args,
            input,
            timeout,
            self.net.cancel.as_deref(),
            Some(&target.repo_arg()),
        )
    }

    /// The open pull requests, newest first, the way `filter` picks them (at
    /// most 100); for `Merged`, the last 20 merged, the latest merge first.
    pub fn pull_requests(&self, gh: &Gh, filter: PrFilter) -> Result<Vec<PullRequest>> {
        let target = self.github_target()?;
        let repo = target.repo_arg();
        let merged = filter == PrFilter::Merged;
        let mut args = vec![
            "pr",
            "list",
            "--repo",
            &repo,
            "--state",
            if merged { "merged" } else { "open" },
            "--limit",
            if merged { MERGED_LIMIT } else { "100" },
            "--json",
            LIST_FIELDS,
        ];
        match filter {
            PrFilter::All => {}
            PrFilter::Mine => args.extend(["--author", "@me"]),
            PrFilter::ReviewRequested => args.extend(["--search", "review-requested:@me"]),
            // Merging updates it: the last updated are the last merged, near
            // enough to sort by when they were.
            PrFilter::Merged => args.extend(["--search", "sort:updated-desc"]),
        }
        let out = self.gh_call(gh, &target, &args, None, TIMEOUT)?;
        let raw: Vec<RawPr> = parse_json(&out.stdout)?;
        let mut prs: Vec<PullRequest> = raw.into_iter().map(PullRequest::from).collect();
        if merged {
            // ISO times sort as text; a merged one always has its time.
            prs.sort_by(|a, b| b.merged_at.cmp(&a.merged_at));
            return Ok(prs);
        }
        // Which threads are resolved is GraphQL's alone; the list does without.
        if let Ok(open) = self.unresolved_threads(gh, &target) {
            for pr in &mut prs {
                pr.unresolved_threads = open.get(&pr.number).copied();
            }
        }
        Ok(prs)
    }

    /// How many line-comment threads of each open pull request (the 100
    /// last updated, as the list has them) aren't resolved, by number.
    fn unresolved_threads(&self, gh: &Gh, target: &GitHubRepo) -> Result<HashMap<u64, u32>> {
        let (owner, name) = target
            .path
            .split_once('/')
            .ok_or_else(|| Error::Message(format!("not owner/name: {}", target.path)))?;
        let query = "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { \
            pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) { \
            nodes { number reviewThreads(first: 100) { nodes { isResolved } } } } } }";
        let mut args = Vec::new();
        target.api(&mut args);
        let owner_arg = format!("owner={owner}");
        let name_arg = format!("name={name}");
        let query_arg = format!("query={query}");
        args.extend([
            "graphql", "-F", &owner_arg, "-F", &name_arg, "-f", &query_arg,
        ]);
        let out = self.gh_call(gh, target, &args, None, TIMEOUT)?;
        let raw: RawOpenThreadsAnswer = parse_json(&out.stdout)?;
        Ok(raw
            .data
            .repository
            .pull_requests
            .nodes
            .into_iter()
            .map(|pr| {
                let open = pr
                    .review_threads
                    .nodes
                    .iter()
                    .filter(|t| !t.is_resolved)
                    .count();
                (pr.number, open as u32)
            })
            .collect())
    }

    /// Pull request `number` with its checks, reviews and conversation: one
    /// `gh pr view`, `gh api` for the comments on lines, which it leaves out,
    /// and GraphQL for the threads those comments are in. The three run at
    /// once: one after another they took three round trips to GitHub.
    pub fn pull_request(&self, gh: &Gh, number: u64) -> Result<PullRequestDetail> {
        let target = self.github_target()?;
        let place = self.gh_place();
        let repo = target.repo_arg();
        let n = number.to_string();
        let endpoint = format!("repos/{}/pulls/{n}/comments?per_page=100", target.path);
        let mut api_args = Vec::new();
        target.api(&mut api_args);
        api_args.extend(["--paginate", &endpoint]);
        let (view, comments, threads) = thread::scope(|s| {
            let comments = s.spawn(|| place.call(gh, &target, &api_args));
            let threads = s.spawn(|| review_threads(&place, gh, &target, number));
            let view = place.call(
                gh,
                &target,
                &["pr", "view", &n, "--repo", &repo, "--json", VIEW_FIELDS],
            );
            (view, comments.join(), threads.join())
        });
        let raw: RawPrDetail = parse_json(&view?.stdout)?;
        let comments =
            comments.map_err(|_| Error::Message("reading the line comments stopped".into()))??;
        let review_comments = parse_review_comments(&comments.stdout)?;
        let threads = threads.ok().and_then(|t| t.ok());
        let read_threads = threads.is_some();
        let owner = target.path.split('/').next().unwrap_or_default();
        let mut detail = raw.into_detail(owner, review_comments, threads.unwrap_or_default());
        detail.signature = read_threads.then(|| PrSignature::of(&detail));
        Ok(detail)
    }

    /// Where and how [`Repo::gh_call`] runs `gh`, apart from the repository:
    /// `git2::Repository` can't be shared between threads, this can.
    fn gh_place(&self) -> GhPlace {
        GhPlace {
            dir: self.workdir().to_path_buf(),
            cancel: self.net.cancel.clone(),
        }
    }

    /// Mark the line-comment thread `thread_id` (a `PrReviewThread::id`)
    /// resolved, or open again with `resolve` false.
    pub fn resolve_review_thread(&self, gh: &Gh, thread_id: &str, resolve: bool) -> Result<()> {
        let target = self.github_target()?;
        let mutation = if resolve {
            "resolveReviewThread"
        } else {
            "unresolveReviewThread"
        };
        let query = format!(
            "query=mutation($id: ID!) {{ {mutation}(input: {{threadId: $id}}) {{ thread {{ isResolved }} }} }}"
        );
        let id = format!("id={thread_id}");
        let mut args = Vec::new();
        target.api(&mut args);
        args.extend(["graphql", "-F", &id, "-f", &query]);
        self.gh_call(gh, &target, &args, None, TIMEOUT)?;
        Ok(())
    }

    /// The changed files of pull request `number` with their diffs, from
    /// `gh pr diff`, cut at the same line cap as a commit's.
    pub fn pull_request_files(&self, gh: &Gh, number: u64) -> Result<Vec<FileDiff>> {
        let target = self.github_target()?;
        let repo = target.repo_arg();
        let n = number.to_string();
        let out = self.gh_call(
            gh,
            &target,
            &["pr", "diff", &n, "--repo", &repo, "--color", "never"],
            None,
            TIMEOUT,
        )?;
        parse_pr_diff(&out.stdout, self.text_encoding())
    }

    /// The changed files of commit `oid` of the GitHub repository, from its
    /// diff there: a pull request's commit needn't be fetched here.
    pub fn github_commit_files(&self, gh: &Gh, oid: &str) -> Result<Vec<FileDiff>> {
        if !(7..=40).contains(&oid.len()) || !oid.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(Error::Message(format!("not a commit id: {oid}")));
        }
        let target = self.github_target()?;
        let endpoint = format!("repos/{}/commits/{oid}", target.path);
        let mut args = Vec::new();
        target.api(&mut args);
        args.extend(["-H", "Accept: application/vnd.github.diff", &endpoint]);
        let out = self.gh_call(gh, &target, &args, None, TIMEOUT)?;
        parse_pr_diff(&out.stdout, self.text_encoding())
    }

    /// `gh pr checkout`: a local branch for the pull request's head, set to
    /// track it (in the author's fork, for one from a fork), checked out here.
    pub fn checkout_pull_request(&self, gh: &Gh, number: u64) -> Result<String> {
        let target = self.github_target()?;
        let repo = target.repo_arg();
        let n = number.to_string();
        let args = ["pr", "checkout", &n, "--repo", &repo];
        Ok(self
            .gh_call(gh, &target, &args, None, CHECKOUT_TIMEOUT)?
            .combined())
    }

    /// Make pull request `number`'s head commit `head` (its full id)
    /// available locally: nothing when it already is, else fetch
    /// `pull/<number>/head` into the private ref `refs/gitp/pr/<number>/head`
    /// — from the first GitHub remote, or `origin` when none is one — so a
    /// thread command can read the files at that commit, checked out or not.
    pub fn ensure_pull_request_head(&self, number: u64, head: &str) -> Result<()> {
        if head.len() != 40 || !head.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::Message(format!("not a commit id: {head}")));
        }
        if self.resolve_commit(head).is_ok() {
            return Ok(());
        }
        let remote = self
            .find_github_remote()
            .map(|(name, _)| name)
            .unwrap_or_else(|| "origin".to_string());
        // Forced: a rebased pull request moves its head off the old one.
        let refspec = format!("+pull/{number}/head:refs/gitp/pr/{number}/head");
        self.run_git_network(&["fetch", &remote, &refspec])?;
        self.resolve_commit(head).map(|_| ()).map_err(|_| {
            Error::Message(format!(
                "#{number}'s head {head} is not what the fetch of pull/{number}/head brought"
            ))
        })
    }

    /// Check pull request `number` out in a new worktree at `path`: the
    /// worktree is made detached at HEAD, and `gh pr checkout` run in it puts
    /// it on the pull request's branch. If that fails the worktree goes again.
    /// Returns its absolute path.
    pub fn checkout_pull_request_in_worktree(
        &self,
        gh: &Gh,
        number: u64,
        path: &str,
    ) -> Result<PathBuf> {
        let target = self.github_target()?;
        let repo = target.repo_arg();
        let full = self.add_worktree(path, &WorktreeTarget::Detached { rev: "HEAD".into() })?;
        let n = number.to_string();
        let checkout = gh.call(
            Some(&full),
            &["pr", "checkout", &n, "--repo", &repo],
            None,
            CHECKOUT_TIMEOUT,
            self.net.cancel.as_deref(),
            Some(&repo),
        );
        if let Err(e) = checkout {
            let _ = self.remove_worktree(&full, true);
            return Err(e);
        }
        Ok(full)
    }

    /// Open a pull request with `gh pr create`. The branch must be on GitHub
    /// already (push it first). The title and branches go in as `--opt=value`,
    /// so text that starts with a dash is never read as an option, and the
    /// description goes in on stdin. Returns the new pull request's number.
    pub fn create_pull_request(&self, gh: &Gh, pr: &NewPullRequest) -> Result<u64> {
        let title = pr.title.trim();
        if title.is_empty() {
            return Err(Error::Message("Give the pull request a title.".into()));
        }
        let target = self.github_target()?;
        let repo = target.repo_arg();
        // Pushed to another GitHub repository than the one the pull request
        // goes to — a fork — the branch is named with its owner.
        let pushed_to = self
            .inner
            .find_remote(&pr.remote)
            .ok()
            .and_then(|r| r.url().and_then(github_repo_from_url));
        let head = match pushed_to {
            Some(fork) if fork.path != target.path => {
                let owner = fork.path.split('/').next().unwrap_or_default();
                format!("--head={owner}:{}", pr.branch)
            }
            _ => format!("--head={}", pr.branch),
        };
        let base = format!("--base={}", pr.base);
        let title = format!("--title={title}");
        let mut args = vec![
            "pr",
            "create",
            "--repo",
            &repo,
            &head,
            &base,
            &title,
            "--body-file",
            "-",
        ];
        if pr.draft {
            args.push("--draft");
        }
        let out = self.gh_call(gh, &target, &args, Some(pr.body.as_bytes()), TIMEOUT)?;
        let said = out.text();
        said.lines()
            .rev()
            .find_map(|line| line.trim().rsplit_once("/pull/")?.1.parse().ok())
            .ok_or_else(|| {
                Error::Message(format!(
                    "gh didn't say which pull request it opened: {said}"
                ))
            })
    }

    /// The repository's default branch and which merges it allows.
    pub fn github_repo_settings(&self, gh: &Gh) -> Result<GitHubRepoSettings> {
        let target = self.github_target()?;
        let repo = target.repo_arg();
        let args = ["repo", "view", &repo, "--json", REPO_SETTINGS_FIELDS];
        let out = self.gh_call(gh, &target, &args, None, TIMEOUT)?;
        let raw: RawRepoSettings = parse_json(&out.stdout)?;
        Ok(GitHubRepoSettings {
            default_branch: raw.default_branch_ref.map(|b| b.name).unwrap_or_default(),
            merge_commit: raw.merge_commit_allowed,
            squash: raw.squash_merge_allowed,
            rebase: raw.rebase_merge_allowed,
            delete_branch_on_merge: raw.delete_branch_on_merge,
        })
    }

    /// Merge pull request `number` on GitHub. With `delete_branch`, its
    /// branch on GitHub goes too: given `--repo`, gh leaves local branches and
    /// the checkout alone.
    pub fn merge_pull_request(
        &self,
        gh: &Gh,
        number: u64,
        method: MergeMethod,
        delete_branch: bool,
    ) -> Result<String> {
        let target = self.github_target()?;
        let repo = target.repo_arg();
        let n = number.to_string();
        let flag = match method {
            MergeMethod::Merge => "--merge",
            MergeMethod::Squash => "--squash",
            MergeMethod::Rebase => "--rebase",
        };
        let mut args = vec!["pr", "merge", &n, "--repo", &repo, flag];
        if delete_branch {
            args.push("--delete-branch");
        }
        Ok(self.gh_call(gh, &target, &args, None, TIMEOUT)?.combined())
    }

    /// A title and description for a pull request from `branch` into `base`
    /// (a branch on GitHub), the way GitHub starts one: one commit gives its
    /// message, several the branch name as a title and their list; the
    /// repository's pull request template, if it has one, is the description.
    /// No network: the commits are those not on the GitHub remote's `base` as
    /// last fetched — all of the branch's when that isn't there.
    pub fn pull_request_draft(&self, branch: &str, base: &str) -> Result<PrDraft> {
        let tip = self
            .inner
            .find_branch(branch, git2::BranchType::Local)?
            .get()
            .peel_to_commit()?;
        let base = self.find_github_remote().and_then(|(remote, _)| {
            let r = self
                .inner
                .find_reference(&format!("refs/remotes/{remote}/{base}"))
                .ok()?;
            r.peel_to_commit().ok().map(|c| c.id())
        });
        let mut commits = Vec::new();
        if let Some(base) = base {
            let mut walk = self.inner.revwalk()?;
            walk.push(tip.id())?;
            walk.hide(base)?;
            walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::REVERSE)?;
            for oid in walk {
                commits.push(self.inner.find_commit(oid?)?);
            }
        }
        let template = PR_TEMPLATES
            .iter()
            .find_map(|path| std::fs::read_to_string(self.workdir().join(path)).ok());
        let (title, body) = match commits.as_slice() {
            [one] => (
                one.summary().unwrap_or_default().to_string(),
                one.body().unwrap_or_default().trim().to_string(),
            ),
            many => (
                title_from_branch(branch),
                many.iter()
                    .map(|c| format!("- {}", c.summary().unwrap_or_default()))
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
        };
        Ok(PrDraft {
            title,
            body: template.unwrap_or(body),
        })
    }

    /// Comment on pull request `number`. Returns the new comment's URL.
    pub fn comment_on_pull_request(&self, gh: &Gh, number: u64, body: &str) -> Result<String> {
        let body = required_body(body)?;
        let target = self.github_target()?;
        let repo = target.repo_arg();
        let n = number.to_string();
        let args = ["pr", "comment", &n, "--repo", &repo, "--body-file", "-"];
        Ok(self
            .gh_call(gh, &target, &args, Some(body.as_bytes()), TIMEOUT)?
            .text())
    }

    /// Review pull request `number`. An approval may leave `body` empty; a
    /// request for changes or a comment needs one.
    pub fn review_pull_request(
        &self,
        gh: &Gh,
        number: u64,
        verdict: ReviewVerdict,
        body: &str,
    ) -> Result<String> {
        let body = body.trim();
        if body.is_empty() && verdict != ReviewVerdict::Approve {
            return Err(Error::Message(
                "Write what the review says: GitHub needs a message to request changes or comment."
                    .into(),
            ));
        }
        let target = self.github_target()?;
        let repo = target.repo_arg();
        let n = number.to_string();
        let flag = match verdict {
            ReviewVerdict::Approve => "--approve",
            ReviewVerdict::RequestChanges => "--request-changes",
            ReviewVerdict::Comment => "--comment",
        };
        let mut args = vec!["pr", "review", &n, "--repo", &repo, flag];
        let input = (!body.is_empty()).then_some(body.as_bytes());
        if input.is_some() {
            args.extend(["--body-file", "-"]);
        }
        Ok(self.gh_call(gh, &target, &args, input, TIMEOUT)?.combined())
    }

    /// The pull request a commit came in with, and its page: `number` when the
    /// commit message names it (a squash merge's "(#3019)"), with no call to
    /// GitHub; otherwise the first one GitHub links to the commit. `None` when
    /// it has none, or the repository isn't on GitHub.
    pub fn commit_pull_request(
        &self,
        gh: &Gh,
        commit: &str,
        number: Option<u64>,
    ) -> Result<Option<CommitPullRequest>> {
        let Some(target) = self.find_github_repo() else {
            return Ok(None);
        };
        let url = |n: u64| format!("https://{}/{}/pull/{n}", target.host, target.path);
        if let Some(n) = number {
            return Ok(Some(CommitPullRequest {
                number: n,
                url: url(n),
            }));
        }
        if commit.len() != 40 || !commit.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::Message(format!("not a commit id: {commit}")));
        }
        let endpoint = format!("repos/{}/commits/{commit}/pulls", target.path);
        let args = ["api", "--method", "GET", &endpoint];
        let out = self.gh_call(gh, &target, &args, None, TIMEOUT)?;
        let found: Vec<RawCommitPull> = parse_json(&out.stdout)?;
        Ok(found.first().map(|p| CommitPullRequest {
            number: p.number,
            url: url(p.number),
        }))
    }

    /// The diff of pull request `number` as `gh pr diff` prints it.
    pub fn pull_request_diff(&self, gh: &Gh, number: u64) -> Result<String> {
        let target = self.github_target()?;
        let repo = target.repo_arg();
        let n = number.to_string();
        let args = ["pr", "diff", &n, "--repo", &repo];
        Ok(
            String::from_utf8_lossy(&self.gh_call(gh, &target, &args, None, TIMEOUT)?.stdout)
                .into_owned(),
        )
    }

    /// Run the user's review `command` over pull request `number`'s diff and
    /// return the review it made — in the shape the Drafts tab reads.
    ///
    /// The command is a shell line, run by a login shell so it finds the same
    /// programs a terminal would (`claude`, say). The diff arrives on its
    /// stdin; `GITP_PR_NUMBER`, `GITP_PR_REPO` and `GITP_PR_URL` are set. It
    /// gets [`REVIEW_TIMEOUT`], and Cancel stops it like a fetch.
    ///
    /// A command that writes its review to a file — a review skill saving
    /// `review/<sprint>/pr-review-<slug>.html` — is read from that file, the
    /// newest one written while it ran; otherwise the review is what it printed.
    pub fn generate_review_drafts(
        &self,
        gh: &Gh,
        number: u64,
        command: &str,
    ) -> Result<GeneratedReview> {
        let command = command.trim();
        if command.is_empty() {
            return Err(Error::Message(
                "Set a review command in Settings → Git first.".into(),
            ));
        }
        let target = self.github_target()?;
        let diff = self.pull_request_diff(gh, number)?;
        if diff.trim().is_empty() {
            return Err(Error::Message(
                "The pull request has no diff to review.".into(),
            ));
        }
        let url = format!("https://{}/{}/pull/{number}", target.host, target.path);
        let env = [
            ("GITP_PR_NUMBER", number.to_string()),
            ("GITP_PR_REPO", target.repo_arg()),
            ("GITP_PR_URL", url),
        ];
        let started = SystemTime::now();
        let out = run_shell(
            self.workdir(),
            command,
            diff.as_bytes(),
            &env,
            REVIEW_TIMEOUT,
            &self.net,
        )?;
        if let Some(file) = review_file_written_since(self.workdir(), started) {
            let text = std::fs::read_to_string(&file)
                .map_err(|e| Error::Message(format!("couldn't read {}: {e}", file.display())))?;
            return Ok(GeneratedReview {
                text,
                file: Some(file.to_string_lossy().into_owned()),
            });
        }
        if out.stdout.trim().is_empty() {
            return Err(Error::Message(format!(
                "The review command printed nothing.{}",
                if out.stderr.trim().is_empty() {
                    String::new()
                } else {
                    format!("\n\n{}", out.stderr.trim())
                }
            )));
        }
        Ok(GeneratedReview {
            text: out.stdout,
            file: None,
        })
    }

    /// Review pull request `number` in one go: the verdict, an optional
    /// message and `comments` on lines of its diff, posted together as one
    /// review (`POST /pulls/{n}/reviews`), so the author gets one
    /// notification and one review to answer. Returns the review's URL.
    /// Without comments it is a plain [`Repo::review_pull_request`].
    pub fn review_with_comments(
        &self,
        gh: &Gh,
        number: u64,
        verdict: ReviewVerdict,
        body: &str,
        comments: &[LineComment],
    ) -> Result<String> {
        let body = body.trim();
        if comments.is_empty() {
            return self.review_pull_request(gh, number, verdict, body);
        }
        if body.is_empty() && verdict == ReviewVerdict::RequestChanges {
            return Err(Error::Message(
                "Write what the review says: GitHub needs a message to request changes.".into(),
            ));
        }
        for c in comments {
            required_body(&c.body)?;
        }
        let target = self.github_target()?;
        let endpoint = format!("repos/{}/pulls/{number}/reviews", target.path);
        let event = match verdict {
            ReviewVerdict::Approve => "APPROVE",
            ReviewVerdict::RequestChanges => "REQUEST_CHANGES",
            ReviewVerdict::Comment => "COMMENT",
        };
        let input = serde_json::json!({
            "commit_id": comments[0].commit_id,
            "event": event,
            "body": body,
            "comments": comments.iter().map(|c| serde_json::json!({
                "path": c.path,
                "line": c.line,
                "side": c.side,
                "body": c.body.trim(),
            })).collect::<Vec<_>>(),
        })
        .to_string();
        let mut args = Vec::new();
        target.api(&mut args);
        args.extend(["--method", "POST", &endpoint, "--input", "-"]);
        let out = self.gh_call(gh, &target, &args, Some(input.as_bytes()), TIMEOUT)?;
        #[derive(Deserialize)]
        struct RawReview {
            #[serde(default)]
            html_url: String,
        }
        let made: RawReview = parse_json(&out.stdout)?;
        Ok(made.html_url)
    }

    /// Reply in the thread of line comment `comment_id` on pull request
    /// `number`.
    pub fn reply_to_review_comment(
        &self,
        gh: &Gh,
        number: u64,
        comment_id: u64,
        body: &str,
    ) -> Result<PrReviewComment> {
        let body = required_body(body)?;
        let target = self.github_target()?;
        let endpoint = format!(
            "repos/{}/pulls/{number}/comments/{comment_id}/replies",
            target.path
        );
        let input = serde_json::json!({ "body": body }).to_string();
        self.post_review_comment(gh, &target, &endpoint, &input)
    }

    /// Comment on one line of pull request `number`'s diff.
    pub fn comment_on_line(
        &self,
        gh: &Gh,
        number: u64,
        comment: &LineComment,
    ) -> Result<PrReviewComment> {
        let body = required_body(&comment.body)?;
        let target = self.github_target()?;
        let endpoint = format!("repos/{}/pulls/{number}/comments", target.path);
        let input = serde_json::json!({
            "body": body,
            "commit_id": comment.commit_id,
            "path": comment.path,
            "line": comment.line,
            "side": comment.side,
        })
        .to_string();
        self.post_review_comment(gh, &target, &endpoint, &input)
    }

    /// POST `input` (JSON, on stdin) to `endpoint`, which answers with the
    /// line comment it made.
    fn post_review_comment(
        &self,
        gh: &Gh,
        target: &GitHubRepo,
        endpoint: &str,
        input: &str,
    ) -> Result<PrReviewComment> {
        let mut args = Vec::new();
        target.api(&mut args);
        args.extend(["--method", "POST", endpoint, "--input", "-"]);
        let out = self.gh_call(gh, target, &args, Some(input.as_bytes()), TIMEOUT)?;
        let raw: RawReviewComment = parse_json(&out.stdout)?;
        Ok(raw.into())
    }
}

/// A commit's pull request: its number and page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommitPullRequest {
    pub number: u64,
    pub url: String,
}

#[derive(Deserialize)]
struct RawCommitPull {
    number: u64,
}

/// How long a review command may run: a model reading a big diff takes
/// minutes, and a review skill that also reads the story and the callers can
/// take most of an hour.
pub const REVIEW_TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// How long one "Explain more" may take.
pub const EXPLAIN_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// What a review command made: the review's text, and the file it came from
/// when the command wrote one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GeneratedReview {
    pub text: String,
    pub file: Option<String>,
}

/// The `pr-review-*.html` and `.md` files under `dir/review/` and one folder
/// below it (the sprint folder), each with when it was last written.
fn review_files_in(dir: &Path) -> Vec<(PathBuf, SystemTime)> {
    let root = dir.join("review");
    let mut found = Vec::new();
    let mut look = |folder: &Path| {
        let Ok(entries) = std::fs::read_dir(folder) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_review = name.starts_with("pr-review-")
                && (name.ends_with(".html") || name.ends_with(".md"));
            if let Some(modified) = is_review
                .then(|| entry.metadata().and_then(|m| m.modified()).ok())
                .flatten()
            {
                found.push((entry.path(), modified));
            }
        }
    };
    look(&root);
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                look(&entry.path());
            }
        }
    }
    found
}

/// Whether `a` is a better pick than `b`: newer, or as new and the HTML page
/// beside its Markdown copy — the page is the one the skill always writes.
fn preferred(a: &(PathBuf, SystemTime), b: &(PathBuf, SystemTime)) -> bool {
    let html = |p: &Path| p.extension().is_some_and(|e| e == "html");
    a.1 > b.1 || (a.1 == b.1 && html(&a.0) && !html(&b.0))
}

/// The newest review file under `dir` written at or after `since`.
pub(crate) fn review_file_written_since(dir: &Path, since: SystemTime) -> Option<PathBuf> {
    let mut best: Option<(PathBuf, SystemTime)> = None;
    for f in review_files_in(dir) {
        if f.1 >= since && best.as_ref().is_none_or(|b| preferred(&f, b)) {
            best = Some(f);
        }
    }
    best.map(|(p, _)| p)
}

/// A review saved under the repository's `review/` folder, and the pull
/// request it reviews.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReviewFile {
    pub path: String,
    pub number: u64,
}

/// How much of a review file is read to find its pull request: the link is in
/// the header, at the top of the Markdown — a page that inlines its libraries
/// is megabytes past it.
const REVIEW_HEAD: u64 = 64 * 1024;

/// The pull request a review file reviews: the number of the first
/// `github.com/…/pull/<n>` link near its top.
fn reviewed_pull_request(path: &Path) -> Option<u64> {
    let mut head = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(REVIEW_HEAD)
        .read_to_end(&mut head)
        .ok()?;
    let text = String::from_utf8_lossy(&head);
    let mut rest = text.as_ref();
    while let Some(at) = rest.find("/pull/") {
        let before = &rest[..at];
        rest = &rest[at + "/pull/".len()..];
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if before
            .rsplit(['(', '"', ' ', '<', '['])
            .next()
            .is_some_and(|u| u.contains("github"))
        {
            if let Ok(n) = digits.parse() {
                return Some(n);
            }
        }
    }
    None
}

impl Repo {
    /// The reviews saved under the working tree's `review/` folder (where the
    /// review skills write them), the newest one for each pull request. A
    /// file is matched by the pull request it links, not its name: two pull
    /// requests of one ticket share a file name.
    pub fn review_files(&self) -> Vec<ReviewFile> {
        let mut best: std::collections::HashMap<u64, (PathBuf, SystemTime)> =
            std::collections::HashMap::new();
        for f in review_files_in(self.workdir()) {
            let Some(n) = reviewed_pull_request(&f.0) else {
                continue;
            };
            if best.get(&n).is_none_or(|b| preferred(&f, b)) {
                best.insert(n, f);
            }
        }
        let mut out: Vec<ReviewFile> = best
            .into_iter()
            .map(|(number, (p, _))| ReviewFile {
                path: p.to_string_lossy().into_owned(),
                number,
            })
            .collect();
        out.sort_by_key(|f| f.number);
        out
    }

    /// Run `command` to explain finding `finding` (`f3`) of the saved review
    /// of pull request `number` again, in simpler words: the review board's
    /// "Explain more". The command gets the review's slug (`UBIID-9868`, from
    /// `pr-review-UBIID-9868.html`), the finding and the file in its
    /// environment, and is expected to add the explanation to the file.
    pub fn explain_review_finding(&self, number: u64, finding: &str, command: &str) -> Result<()> {
        let command = command.trim();
        if command.is_empty() {
            return Err(Error::Message("No explain command is set.".into()));
        }
        let valid = finding.len() > 1
            && finding.len() <= 4
            && finding.starts_with('f')
            && finding[1..].bytes().all(|b| b.is_ascii_digit());
        if !valid {
            return Err(Error::Message(format!(
                "{finding} is not a finding of a review"
            )));
        }
        let file = self
            .review_files()
            .into_iter()
            .find(|f| f.number == number)
            .ok_or_else(|| Error::Message(format!("#{number} has no saved review")))?;
        let slug = Path::new(&file.path)
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.strip_prefix("pr-review-"))
            .filter(|s| {
                !s.is_empty()
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
            .ok_or_else(|| Error::Message(format!("{} has no review slug in its name", file.path)))?
            .to_string();
        let env = [
            ("GITP_REVIEW_SLUG", slug),
            ("GITP_REVIEW_FINDING", finding.to_string()),
            ("GITP_REVIEW_FILE", file.path.clone()),
        ];
        run_shell(
            self.workdir(),
            command,
            b"",
            &env,
            EXPLAIN_TIMEOUT,
            &self.net,
        )?;
        Ok(())
    }
}

/// One line-comment thread as the pull request view has it, for a Claude
/// turn on it.
#[derive(Debug, Clone, Deserialize)]
pub struct ThreadInput {
    pub number: u64,
    /// The pull request's head commit, full id.
    pub head: String,
    /// The pull request's author login.
    pub author: String,
    /// The pull request's title, kept in the conversation for the search.
    #[serde(default)]
    pub title: Option<String>,
    /// The thread's comments, root first.
    pub comments: Vec<PrReviewComment>,
}

impl Repo {
    /// Run `command` for one turn of `kind` on the thread of `input` — Check,
    /// Explain simply, a follow-up, or a reply draft — with `user_text` on
    /// its stdin, and keep the turn in the thread's conversation.
    ///
    /// The command gets the pull request, the thread and the head commit in
    /// its environment (`GITP_PR_*`, `GITP_THREAD_*`, `GITP_GH_LOGIN`,
    /// `GITP_CLAUDE_SESSION`, `GITP_TURN_KIND`), and the thread with its
    /// conversation so far as JSON in the file `GITP_THREAD_FILE` names. Its
    /// stdout is the answer: the `result` of a `claude -p --output-format
    /// json` answer, whose `session_id` is kept for the next turn, or else
    /// the whole text. A follow-up's question is kept even when the run
    /// fails. The head is fetched first when it isn't local.
    pub fn thread_claude_turn(
        &self,
        gh: &Gh,
        input: &ThreadInput,
        kind: TurnKind,
        user_text: &str,
        command: &str,
    ) -> Result<ThreadConversation> {
        if kind == TurnKind::Fix {
            // A fix has a worktree, checks and an undo: only fix_thread runs it.
            return Err(Error::Message(
                "A fix runs through Fix on the thread, not as a plain turn.".into(),
            ));
        }
        self.run_turn(gh, input, kind, user_text, command, TurnPlace::main(self))
    }

    /// Fix the thread of `input` as the user's last follow-up chose, in the
    /// worktree that has the pull request's `branch` checked out: run
    /// `fix_command` there (with `GITP_FIX_*` in its environment and the
    /// chosen option on stdin), which makes the change and commits it once;
    /// then `reply_command` in this repository for the reply draft. The
    /// worktree must be clean and must hold the pull request's head. Any
    /// failure of the fix — the command, or a tree that isn't exactly one
    /// commit ahead and clean afterwards — is undone, back to the commit the
    /// run started from.
    pub fn fix_thread(
        &self,
        gh: &Gh,
        input: &ThreadInput,
        branch: &str,
        fix_command: &str,
        reply_command: &str,
    ) -> Result<ThreadConversation> {
        let Some(root) = input.comments.first() else {
            return Err(Error::Message("The thread has no comments.".into()));
        };
        let conversation = self.thread_conversation(input.number, root.id)?;
        let option = conversation
            .as_ref()
            .and_then(|c| c.turns.iter().rev().find(|t| t.role == TurnRole::User))
            .map(|t| t.text.clone())
            .filter(|t| !t.trim().is_empty())
            .ok_or_else(|| {
                Error::Message("Send the option you want as a follow-up first.".into())
            })?;
        let worktree = self
            .worktrees()?
            .into_iter()
            .find(|w| w.branch.as_deref() == Some(branch))
            .ok_or_else(|| {
                Error::Message(format!(
                    "Check the pull request out first: its branch {branch} is in no worktree."
                ))
            })?;
        let dir = PathBuf::from(&worktree.path);
        require_clean(&dir)?;
        self.ensure_pull_request_head(input.number, &input.head)?;
        require_contains(&dir, &input.head)?;
        let before = git_in(&dir, &["rev-parse", "HEAD"])?;
        let place = TurnPlace {
            dir: dir.clone(),
            extra_env: vec![
                ("GITP_FIX_WORKTREE", dir.to_string_lossy().into_owned()),
                ("GITP_FIX_BRANCH", branch.to_string()),
                ("GITP_FIX_HEAD_BEFORE", before.clone()),
            ],
            timeout: FIX_TIMEOUT,
            fix_session: true,
        };
        let fixed = run_verified_fix(&dir, branch, &before, || {
            self.run_turn(gh, input, TurnKind::Fix, &option, fix_command, place)
        });
        let (mut c, after) = match fixed {
            Ok(ok) => ok,
            Err(e) => {
                // The failed turn, if it was saved, goes; a bookkeeping
                // error here must not hide the real one.
                if let Ok(Some(mut saved)) = self.thread_conversation(input.number, root.id) {
                    saved
                        .turns
                        .retain(|t| t.kind != TurnKind::Fix || t.commit.is_some());
                    let _ = self.save_thread_conversation(&saved);
                }
                return Err(e);
            }
        };
        if let Some(fix) = c.turns.iter_mut().rev().find(|t| t.kind == TurnKind::Fix) {
            fix.commit = Some(after.clone());
            fix.head = Some(after);
            fix.worktree = Some(dir.to_string_lossy().into_owned());
        }
        self.save_thread_conversation(&c)?;
        self.run_turn(
            gh,
            input,
            TurnKind::ReplyDraft,
            &option,
            reply_command,
            TurnPlace::main(self),
        )
    }

    fn run_turn(
        &self,
        gh: &Gh,
        input: &ThreadInput,
        kind: TurnKind,
        user_text: &str,
        command: &str,
        place: TurnPlace,
    ) -> Result<ThreadConversation> {
        let command = command.trim();
        if command.is_empty() {
            return Err(Error::Message(
                "Set a thread command in Settings → Git first.".into(),
            ));
        }
        let Some(root) = input.comments.first() else {
            return Err(Error::Message("The thread has no comments.".into()));
        };
        let target = self.github_target()?;
        let number = input.number;
        let mut conversation = self
            .thread_conversation(number, root.id)?
            .unwrap_or_else(|| ThreadConversation {
                version: 1,
                pr: number,
                thread: root.id,
                path: root.path.clone(),
                title: None,
                line: None,
                comments: Vec::new(),
                session: None,
                fix_session: None,
                turns: Vec::new(),
            });
        // The thread as it is now, for the search: edits and new replies too.
        if input.title.is_some() {
            conversation.title = input.title.clone();
        }
        conversation.line = root.line.or(root.original_line);
        conversation.comments = input
            .comments
            .iter()
            .map(|c| ThreadComment {
                author: c.author.clone(),
                body: c.body.clone(),
            })
            .collect();
        if kind == TurnKind::Followup {
            conversation
                .turns
                .push(ThreadTurn::user(kind, user_text.to_string()));
            self.save_thread_conversation(&conversation)?;
        }
        // After the question is kept: a fetch that fails must not lose it.
        self.ensure_pull_request_head(number, &input.head)?;
        let thread_json = serde_json::json!({
            "path": root.path,
            "line": root.line,
            "original_line": root.original_line,
            "diff_hunk": root.diff_hunk,
            "comments": input.comments.iter().map(|c| serde_json::json!({
                "author": c.author, "created_at": c.created_at, "body": c.body,
            })).collect::<Vec<_>>(),
            "turns": conversation.turns,
        });
        let file = std::env::temp_dir().join(format!(
            "gitp-thread-{}-{}-{}.json",
            std::process::id(),
            root.id,
            now_millis()
        ));
        std::fs::write(&file, thread_json.to_string())
            .map_err(|e| Error::Message(format!("can't write {}: {e}", file.display())))?;
        let login = gh.account().ok().and_then(|a| a.login).unwrap_or_default();
        let line = root
            .line
            .or(root.original_line)
            .map(|l| l.to_string())
            .unwrap_or_default();
        let kind_name = match kind {
            TurnKind::Check => "check",
            TurnKind::Explain => "explain",
            TurnKind::Followup => "followup",
            TurnKind::ReplyDraft => "reply-draft",
            TurnKind::Fix => "fix",
        };
        let mut env = vec![
            ("GITP_PR_NUMBER", number.to_string()),
            ("GITP_PR_REPO", target.repo_arg()),
            (
                "GITP_PR_URL",
                format!("https://{}/{}/pull/{number}", target.host, target.path),
            ),
            ("GITP_PR_HEAD", input.head.clone()),
            ("GITP_PR_AUTHOR", input.author.clone()),
            ("GITP_GH_LOGIN", login),
            ("GITP_THREAD_ID", root.id.to_string()),
            ("GITP_THREAD_PATH", root.path.clone()),
            ("GITP_THREAD_LINE", line),
            ("GITP_THREAD_FILE", file.to_string_lossy().into_owned()),
            (
                "GITP_CLAUDE_SESSION",
                if place.fix_session {
                    conversation.fix_session.clone()
                } else {
                    conversation.session.clone()
                }
                .unwrap_or_default(),
            ),
            ("GITP_TURN_KIND", kind_name.to_string()),
        ];
        env.extend(place.extra_env.iter().map(|(k, v)| (*k, v.clone())));
        let run = |env: &[(&str, String)]| {
            run_shell(
                &place.dir,
                command,
                user_text.as_bytes(),
                env,
                place.timeout,
                &self.net,
            )
        };
        let mut out = run(&env);
        // A kept session Claude Code no longer has (cleaned up after its
        // retention period, or made from another working directory) fails
        // the resume: run once more as a fresh conversation. The thread file
        // carries the turns so far either way.
        let kept = if place.fix_session {
            &mut conversation.fix_session
        } else {
            &mut conversation.session
        };
        // A fix runs again only on the explicit message: it may have changed
        // the tree already, and a blind retry would build on that.
        let lost_session = match (&out, &*kept) {
            (Err(Error::Message(text)), Some(session)) => {
                text.contains("No conversation found")
                    || (!place.fix_session && text.contains(session.as_str()))
            }
            _ => false,
        };
        if lost_session && !self.cancelled() {
            if let Some(session) = env.iter_mut().find(|(k, _)| *k == "GITP_CLAUDE_SESSION") {
                session.1.clear();
            }
            out = run(&env);
            if out.is_ok() {
                *kept = None;
            }
        }
        let _ = std::fs::remove_file(&file);
        let out = out?;
        let (text, session) = claude_answer(&out.stdout)?;
        if text.trim().is_empty() {
            return Err(Error::Message(format!(
                "The thread command printed nothing.{}",
                if out.stderr.trim().is_empty() {
                    String::new()
                } else {
                    format!("\n\n{}", out.stderr.trim())
                }
            )));
        }
        if session.is_some() {
            if place.fix_session {
                conversation.fix_session = session;
            } else {
                conversation.session = session;
            }
        }
        conversation
            .turns
            .push(ThreadTurn::claude(kind, input.head.clone(), text));
        self.save_thread_conversation(&conversation)?;
        Ok(conversation)
    }
}

/// How long a fix may take: a change, a test and a commit.
pub const FIX_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Where a thread turn runs and what it gets beyond the thread: the main
/// working directory for most, the pull request branch's worktree for a fix.
struct TurnPlace {
    dir: PathBuf,
    extra_env: Vec<(&'static str, String)>,
    timeout: Duration,
    /// Resume (and keep) the conversation's fix session, not its main one.
    fix_session: bool,
}

impl TurnPlace {
    fn main(repo: &Repo) -> Self {
        Self {
            dir: repo.workdir().to_path_buf(),
            extra_env: Vec::new(),
            timeout: EXPLAIN_TIMEOUT,
            fix_session: false,
        }
    }
}

/// `git <args>` in `dir`, with prompts off: its trimmed stdout, or on
/// failure its trimmed stderr (stdout when there is none) as the error.
pub(crate) fn git_in(dir: &Path, args: &[&str]) -> Result<String> {
    let out = crate::git_bin::git_command()
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(args)
        .output()
        .map_err(|e| Error::Message(format!("failed to run git: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(Error::Message(if stderr.is_empty() {
            stdout
        } else {
            stderr
        }))
    }
}

/// Refuse a worktree with any change, untracked files included (ignored
/// ones aside): a fix's commit must never sweep up the user's own work.
pub(crate) fn require_clean(dir: &Path) -> Result<()> {
    if git_in(dir, &["status", "--porcelain", "--untracked-files=all"])?.is_empty() {
        Ok(())
    } else {
        Err(Error::Message(format!(
            "Commit or stash the changes in {} first.",
            dir.display()
        )))
    }
}

/// Refuse a worktree whose HEAD lacks the pull request's `head`.
pub(crate) fn require_contains(dir: &Path, head: &str) -> Result<()> {
    match git_in(dir, &["merge-base", "--is-ancestor", head, "HEAD"]) {
        Ok(_) => Ok(()),
        // Exit 1 is "not an ancestor", silently; anything said is a real error.
        Err(Error::Message(text)) if text.is_empty() => Err(Error::Message(
            "The local branch is behind GitHub: pull it first.".into(),
        )),
        Err(other) => Err(Error::Message(format!(
            "couldn't compare the branch with the pull request's head: {other}"
        ))),
    }
}

/// Run a fix in the worktree `dir` of `branch`, which was clean at `before`,
/// and check what it left: still on the branch, exactly one new commit whose
/// only parent is `before`, nothing uncommitted. Any failure — the run's or
/// a check's — is undone back to `before`. Returns the run's value and the
/// new commit.
pub(crate) fn run_verified_fix<T>(
    dir: &Path,
    branch: &str,
    before: &str,
    run: impl FnOnce() -> Result<T>,
) -> Result<(T, String)> {
    let checked = run().and_then(|value| {
        if git_in(dir, &["rev-parse", "--abbrev-ref", "HEAD"])? != branch {
            return Err(Error::Message(format!(
                "The fix left the worktree off {branch}."
            )));
        }
        let after = git_in(dir, &["rev-parse", "HEAD"])?;
        // Exactly one new commit whose only parent is where the run
        // started: not none, not two, not an amend, not a merge.
        let parents = git_in(dir, &["rev-list", "--parents", "-n", "1", &after])?;
        if parents != format!("{after} {before}") {
            let made = git_in(dir, &["rev-list", "--count", &format!("{before}..{after}")])
                .unwrap_or_else(|_| "?".into());
            return Err(Error::Message(format!(
                "The fix must make exactly one commit on top of {}; it made {made}{}.",
                &before[..7],
                if after == before {
                    " (none)"
                } else if made == "1" {
                    " (amended or rebased)"
                } else {
                    ""
                }
            )));
        }
        if !git_in(dir, &["status", "--porcelain", "--untracked-files=all"])?.is_empty() {
            return Err(Error::Message(
                "The fix left uncommitted changes behind.".into(),
            ));
        }
        Ok((value, after))
    });
    checked.map_err(|e| match undo_fix(dir, branch, before) {
        Ok(()) => e,
        Err(undo) => Error::Message(format!(
            "{e}\n\nAnd the undo failed in {}: {undo}",
            dir.display()
        )),
    })
}

/// Put the worktree back where a fix started: on `branch` at `before`, with
/// nothing untracked. Tried a few times: a test runner or git the run left
/// behind may still hold the index for a moment after it was stopped.
pub(crate) fn undo_fix(dir: &Path, branch: &str, before: &str) -> Result<()> {
    let mut last = Ok(());
    for _ in 0..20 {
        last = git_in(dir, &["checkout", "-q", "-f", branch])
            .and_then(|_| git_in(dir, &["reset", "-q", "--hard", before]))
            .and_then(|_| git_in(dir, &["clean", "-fdq"]))
            .map(|_| ());
        if last.is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    last
}

/// What a thread command printed: the answer, and the session to resume
/// when it was a `claude -p --output-format json` answer. Such an answer
/// that reports an error is the error.
pub(crate) fn claude_answer(stdout: &str) -> Result<(String, Option<String>)> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(stdout.trim()) else {
        return Ok((stdout.to_string(), None));
    };
    if json.get("is_error").and_then(|e| e.as_bool()) == Some(true) {
        let said = ["result", "subtype"]
            .iter()
            .find_map(|k| json.get(k).and_then(|v| v.as_str()))
            .filter(|t| !t.trim().is_empty())
            .unwrap_or("Claude reported an error.");
        return Err(Error::Message(said.to_string()));
    }
    let Some(result) = json.get("result").and_then(|r| r.as_str()) else {
        return Ok((stdout.to_string(), None));
    };
    let session = json
        .get("session_id")
        .and_then(|s| s.as_str())
        .map(str::to_string);
    Ok((result.to_string(), session))
}

/// Run shell line `command` in `dir` with `input` on stdin and `env` set,
/// waiting at most `timeout` and only until the hooks' cancel goes up. Fails
/// with the command's stderr when it exits non-zero.
///
/// A run that doesn't resume a Claude session (no `GITP_CLAUDE_SESSION` in
/// `env`) is offered a fresh one in `GITP_CLAUDE_NEW_SESSION`, for
/// `claude --session-id`; either way the hooks hear which session it is.
pub(crate) fn run_shell(
    dir: &Path,
    command: &str,
    input: &[u8],
    env: &[(&str, String)],
    timeout: Duration,
    hooks: &NetworkHooks,
) -> Result<ShellOutput> {
    let cancel = hooks.cancel.as_deref();
    let mut cmd = Command::new("/bin/sh");
    cmd.args(["-lc", command])
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let resumed = env
        .iter()
        .find(|(k, v)| *k == "GITP_CLAUDE_SESSION" && !v.is_empty())
        .map(|(_, v)| v.clone());
    let run = ClaudeRun {
        resumed: resumed.is_some(),
        session: resumed.unwrap_or_else(new_session_id),
        dir: dir.to_path_buf(),
    };
    cmd.env(
        "GITP_CLAUDE_NEW_SESSION",
        if run.resumed {
            ""
        } else {
            run.session.as_str()
        },
    );
    if let Some(tell) = &hooks.on_claude_run {
        tell(&run);
    }
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd
        .spawn()
        .map_err(|e| Error::Message(format!("failed to run the review command: {e}")))?;
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let input = input.to_vec();
    thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let stdout = drain(child.stdout.take().expect("stdout is piped"));
    let stderr = drain(child.stderr.take().expect("stderr is piped"));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => {
                return Err(Error::Message(format!(
                    "failed to run the review command: {e}"
                )))
            }
        }
        if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
            return Err(kill(child));
        }
        if Instant::now() >= deadline {
            kill(child);
            return Err(Error::Message(format!(
                "The review command didn't finish within {} minutes, so it was stopped.",
                timeout.as_secs() / 60
            )));
        }
        thread::sleep(POLL);
    };
    let out = ShellOutput {
        stdout: String::from_utf8_lossy(&stdout.join().unwrap_or_default()).into_owned(),
        stderr: String::from_utf8_lossy(&stderr.join().unwrap_or_default()).into_owned(),
    };
    if status.success() {
        Ok(out)
    } else {
        let detail = if out.stderr.trim().is_empty() {
            out.stdout.trim().to_string()
        } else {
            out.stderr.trim().to_string()
        };
        Err(Error::Message(format!(
            "The review command failed{}.{}",
            status
                .code()
                .map(|c| format!(" (exit code {c})"))
                .unwrap_or_default(),
            if detail.is_empty() {
                String::new()
            } else {
                format!("\n\n{detail}")
            }
        )))
    }
}

pub(crate) struct ShellOutput {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

const LIST_FIELDS: &str = "number,title,author,isDraft,reviewDecision,statusCheckRollup,\
     headRefName,baseRefName,updatedAt,url,labels,latestReviews,mergedAt,mergeable";

/// What `gh` needs from a [`Repo`] to run for it: its folder, and the flag
/// that cancels its network commands.
struct GhPlace {
    dir: PathBuf,
    cancel: Option<Arc<AtomicBool>>,
}

impl GhPlace {
    fn call(&self, gh: &Gh, target: &GitHubRepo, args: &[&str]) -> Result<Output> {
        gh.call(
            Some(&self.dir),
            args,
            None,
            TIMEOUT,
            self.cancel.as_deref(),
            Some(&target.repo_arg()),
        )
    }
}

/// The line-comment threads of pull request `number` with whether each
/// is resolved, from GraphQL (REST doesn't say). The first hundred.
fn review_threads(
    place: &GhPlace,
    gh: &Gh,
    target: &GitHubRepo,
    number: u64,
) -> Result<Vec<PrReviewThread>> {
    let (owner, name) = target
        .path
        .split_once('/')
        .ok_or_else(|| Error::Message(format!("not owner/name: {}", target.path)))?;
    let query = "query($owner: String!, $name: String!, $number: Int!) { \
        repository(owner: $owner, name: $name) { pullRequest(number: $number) { \
        reviewThreads(first: 100) { nodes { id isResolved \
        comments(first: 100) { nodes { databaseId } } } } } } }";
    let n = number.to_string();
    let mut args = Vec::new();
    target.api(&mut args);
    let owner_arg = format!("owner={owner}");
    let name_arg = format!("name={name}");
    let number_arg = format!("number={n}");
    let query_arg = format!("query={query}");
    args.extend([
        "graphql",
        "-F",
        &owner_arg,
        "-F",
        &name_arg,
        "-F",
        &number_arg,
        "-f",
        &query_arg,
    ]);
    let out = place.call(gh, target, &args)?;
    let raw: RawThreadsAnswer = parse_json(&out.stdout)?;
    Ok(raw
        .data
        .repository
        .pull_request
        .review_threads
        .nodes
        .into_iter()
        .map(|t| PrReviewThread {
            id: t.id,
            resolved: t.is_resolved,
            comment_ids: t
                .comments
                .nodes
                .into_iter()
                .filter_map(|c| c.database_id)
                .collect(),
        })
        .collect())
}

const VIEW_FIELDS: &str = "number,title,body,state,isDraft,author,baseRefName,headRefName,\
     headRefOid,labels,url,createdAt,reviewDecision,statusCheckRollup,reviews,comments,commits,\
     additions,deletions,changedFiles,mergeable,mergeStateStatus,updatedAt,reviewRequests";

const REPO_SETTINGS_FIELDS: &str = "defaultBranchRef,mergeCommitAllowed,squashMergeAllowed,\
     rebaseMergeAllowed,deleteBranchOnMerge";

/// Where GitHub looks for a repository's pull request template.
pub(crate) const PR_TEMPLATES: [&str; 6] = [
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
    "docs/pull_request_template.md",
    "docs/PULL_REQUEST_TEMPLATE.md",
];

/// A pull request title from a branch name, as GitHub would offer it but
/// keeping a ticket key whole: `feature/UBIID-8520-delete-old-data` gives
/// "UBIID-8520 Delete old data".
fn title_from_branch(branch: &str) -> String {
    let name = branch.rsplit('/').next().unwrap_or(branch);
    let words: Vec<&str> = name.split(['-', '_']).filter(|w| !w.is_empty()).collect();
    let is_key = |w: &str| {
        w.len() >= 2
            && w.starts_with(|c: char| c.is_ascii_uppercase())
            && w.chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
    };
    let (key, rest) = match words.as_slice() {
        [project, number, rest @ ..]
            if is_key(project) && number.chars().all(|c| c.is_ascii_digit()) =>
        {
            (Some(format!("{project}-{number}")), rest)
        }
        all => (None, all),
    };
    let mut text = rest.join(" ");
    if let Some(first) = text.chars().next() {
        text.replace_range(..first.len_utf8(), &first.to_uppercase().to_string());
    }
    match key {
        Some(key) if text.is_empty() => key,
        Some(key) => format!("{key} {text}"),
        None => text,
    }
}

fn required_body(body: &str) -> Result<&str> {
    let body = body.trim();
    if body.is_empty() {
        Err(Error::Message("Write a comment first.".into()))
    } else {
        Ok(body)
    }
}

fn drain(mut pipe: impl Read + Send + 'static) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = pipe.read_to_end(&mut buf);
        buf
    })
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    path.is_file()
}

/// What to tell the user about a `gh` that failed with `text`.
fn gh_failure(text: &str, repo: Option<&str>) -> Error {
    let text = text.trim();
    let lower = text.to_lowercase();
    let message = if lower.contains("gh auth login")
        || lower.contains("not logged in")
        || lower.contains("authentication required")
        || lower.contains("http 401")
        || lower.contains("bad credentials")
    {
        NOT_SIGNED_IN.to_string()
    } else if lower.contains("rate limit") {
        format!("{RATE_LIMITED}\n\n{text}")
    } else if let Some(repo) = repo.filter(|_| lower.contains("could not resolve to a repository"))
    {
        format!("GitHub has no repository {repo} that your account can see.\n\n{text}")
    } else if text.is_empty() {
        "gh failed without saying why.".to_string()
    } else {
        text.to_string()
    };
    Error::Message(message)
}

/// The account in `gh auth status`'s report. gh 2.40 and later write
///
/// ```text
///   ✓ Logged in to github.com account octocat (keyring)
///   - Active account: true
///   - Token scopes: 'gist', 'read:org', 'repo'
/// ```
///
/// — one such block per account — and earlier ones `Logged in to github.com as
/// octocat (…)` with the scopes unquoted. The active account is the one
/// shown.
fn parse_auth_status(text: &str) -> GhAccount {
    // (login, active, scopes) per account, in order.
    let mut accounts: Vec<(String, bool, Vec<String>)> = Vec::new();
    let mut problems = Vec::new();
    for line in text.lines().map(str::trim) {
        if let Some((_, rest)) = line.split_once("Logged in to ") {
            let mut words = rest.split_whitespace().skip(1);
            if let (Some("account" | "as"), Some(login)) = (words.next(), words.next()) {
                accounts.push((login.to_string(), false, Vec::new()));
            }
        } else if let Some((_, value)) = line.split_once("Active account:") {
            if let Some(account) = accounts.last_mut() {
                account.1 = value.trim() == "true";
            }
        } else if let Some((_, scopes)) = line.split_once("Token scopes:") {
            if let Some(account) = accounts.last_mut() {
                account.2 = scopes
                    .split(',')
                    .map(|s| s.trim().trim_matches('\'').to_string())
                    .filter(|s| !s.is_empty() && s != "none")
                    .collect();
            }
        } else if line.contains("Failed to log in") || line.contains("invalid") {
            problems.push(line.trim_start_matches(['X', '✗', '-', ' ']).to_string());
        }
    }
    let chosen = accounts
        .iter()
        .position(|a| a.1)
        .or((!accounts.is_empty()).then_some(0));
    match chosen {
        Some(i) => {
            let (login, _, scopes) = accounts.swap_remove(i);
            GhAccount {
                signed_in: true,
                login: Some(login),
                scopes,
                ..GhAccount::default()
            }
        }
        None => GhAccount {
            message: (!problems.is_empty()).then(|| problems.join("\n")),
            ..GhAccount::default()
        },
    }
}

/// The one-time code in `gh auth login`'s "! First copy your one-time code:
/// ABCD-1234".
fn device_code(line: &str) -> Option<String> {
    let (_, rest) = line.split_once("one-time code:")?;
    let code = rest.split_whitespace().next()?;
    code.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
        .then(|| code.to_string())
}

/// The device page in a line of `gh auth login` naming it.
fn device_url(line: &str) -> Option<String> {
    line.split_whitespace()
        .find(|w| w.starts_with("https://") && w.contains("/login/device"))
        .map(|w| w.trim_end_matches(['.', ',', ')']).to_string())
}

/// The GitHub repository a remote URL points at, if it is one. An ssh alias
/// of github.com (`git@github.com-work:…`, set up in ~/.ssh/config for a
/// second account) still means github.com; any other host with "github" in
/// its name is taken for GitHub Enterprise.
fn github_repo_from_url(url: &str) -> Option<GitHubRepo> {
    let (host, base) = parse_remote_url(url)?;
    if !host.contains("github") {
        return None;
    }
    let path = base
        .strip_prefix(&format!("https://{host}/"))?
        .trim_end_matches('/');
    let (owner, name) = path.split_once('/')?;
    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }
    let host = if host.starts_with(GITHUB_HOST) || host == "ssh.github.com" {
        GITHUB_HOST.to_string()
    } else {
        host
    };
    Some(GitHubRepo {
        host,
        path: format!("{owner}/{name}"),
    })
}

fn parse_json<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes)
        .map_err(|e| Error::Message(format!("couldn't read gh's answer: {e}")))
}

/// `gh api --paginate` prints each page's array in turn: `[…][…]`.
fn parse_review_comments(bytes: &[u8]) -> Result<Vec<PrReviewComment>> {
    let mut out = Vec::new();
    for page in serde_json::Deserializer::from_slice(bytes).into_iter::<Vec<RawReviewComment>>() {
        let page = page.map_err(|e| Error::Message(format!("couldn't read gh's answer: {e}")))?;
        out.extend(page.into_iter().map(PrReviewComment::from));
    }
    Ok(out)
}

#[derive(Deserialize)]
struct RawOpenThreadsAnswer {
    data: RawOpenThreadsData,
}
#[derive(Deserialize)]
struct RawOpenThreadsData {
    repository: RawOpenThreadsRepo,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawOpenThreadsRepo {
    pull_requests: RawNodes<RawOpenThreadsPr>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawOpenThreadsPr {
    number: u64,
    review_threads: RawNodes<RawThreadState>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawThreadState {
    is_resolved: bool,
}

#[derive(Deserialize)]
struct RawThreadsAnswer {
    data: RawThreadsData,
}
#[derive(Deserialize)]
struct RawThreadsData {
    repository: RawThreadsRepo,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawThreadsRepo {
    pull_request: RawThreadsPr,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawThreadsPr {
    review_threads: RawNodes<RawThread>,
}
#[derive(Deserialize)]
struct RawNodes<T> {
    nodes: Vec<T>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawThread {
    id: String,
    is_resolved: bool,
    comments: RawNodes<RawThreadComment>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawThreadComment {
    database_id: Option<u64>,
}

/// `gh pr diff`'s unified diff as the same per-file hunks a commit's diff
/// has, read by libgit2's own patch parser.
pub(crate) fn parse_pr_diff(bytes: &[u8], enc: TextEncoding) -> Result<Vec<FileDiff>> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(Vec::new());
    }
    let diff = git2::Diff::from_buffer(bytes)?;
    collect_files(&diff, Some(MAX_DIFF_LINES), enc)
}

// --- gh's JSON --------------------------------------------------------------

#[derive(Deserialize)]
struct RawUser {
    login: String,
}

/// A deleted account comes back as null; GitHub shows it as "ghost".
fn login(user: Option<RawUser>) -> String {
    user.map_or_else(|| "ghost".to_string(), |u| u.login)
}

/// An empty decision is no decision.
fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|s| !s.is_empty())
}

/// A check run (GitHub Actions and other apps) or a commit status (older CI),
/// as `statusCheckRollup` mixes them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCheck {
    #[serde(rename = "__typename", default)]
    typename: String,
    name: Option<String>,
    context: Option<String>,
    status: Option<String>,
    conclusion: Option<String>,
    state: Option<String>,
    details_url: Option<String>,
    target_url: Option<String>,
}

impl RawCheck {
    fn state(&self) -> &'static str {
        if self.typename == "StatusContext" || self.status.is_none() && self.state.is_some() {
            return match self.state.as_deref() {
                Some("SUCCESS") => "success",
                Some("FAILURE" | "ERROR") => "failure",
                _ => "pending",
            };
        }
        if self.status.as_deref() != Some("COMPLETED") {
            return "pending";
        }
        match self.conclusion.as_deref() {
            Some("SUCCESS") => "success",
            Some("NEUTRAL") => "neutral",
            Some("SKIPPED") => "skipped",
            Some(
                "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE"
                | "STALE",
            ) => "failure",
            _ => "neutral",
        }
    }

    fn into_check(self) -> PrCheck {
        let state = self.state().to_string();
        PrCheck {
            name: self.name.or(self.context).unwrap_or_default(),
            state,
            url: non_empty(self.details_url.or(self.target_url)),
        }
    }
}

/// The checks in one word: any failure fails them, else anything still
/// running leaves them pending.
fn rollup(checks: &[RawCheck]) -> Option<String> {
    let states: Vec<&str> = checks.iter().map(RawCheck::state).collect();
    let word = if states.is_empty() {
        return None;
    } else if states.contains(&"failure") {
        "failure"
    } else if states.contains(&"pending") {
        "pending"
    } else {
        "success"
    };
    Some(word.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPr {
    number: u64,
    title: String,
    author: Option<RawUser>,
    #[serde(default)]
    is_draft: bool,
    review_decision: Option<String>,
    #[serde(default)]
    status_check_rollup: Vec<RawCheck>,
    head_ref_name: String,
    base_ref_name: String,
    #[serde(default)]
    updated_at: String,
    url: String,
    #[serde(default)]
    labels: Vec<PrLabel>,
    #[serde(default)]
    latest_reviews: Vec<RawReview>,
    merged_at: Option<String>,
    #[serde(default)]
    mergeable: String,
}

impl From<RawPr> for PullRequest {
    fn from(r: RawPr) -> Self {
        PullRequest {
            checks: rollup(&r.status_check_rollup),
            number: r.number,
            title: r.title,
            author: login(r.author),
            is_draft: r.is_draft,
            review_decision: non_empty(r.review_decision),
            head: r.head_ref_name,
            base: r.base_ref_name,
            updated_at: r.updated_at,
            url: r.url,
            labels: r.labels,
            merged_at: non_empty(r.merged_at),
            approvals: r
                .latest_reviews
                .iter()
                .filter(|v| v.state == "APPROVED")
                .count() as u32,
            unresolved_threads: None,
            conflicting: r.mergeable == "CONFLICTING",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawReview {
    author: Option<RawUser>,
    #[serde(default)]
    state: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    submitted_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawComment {
    #[serde(default)]
    id: String,
    author: Option<RawUser>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPrDetail {
    number: u64,
    title: String,
    #[serde(default)]
    body: String,
    state: String,
    #[serde(default)]
    is_draft: bool,
    author: Option<RawUser>,
    base_ref_name: String,
    head_ref_name: String,
    #[serde(default)]
    head_ref_oid: String,
    #[serde(default)]
    labels: Vec<PrLabel>,
    url: String,
    #[serde(default)]
    created_at: String,
    review_decision: Option<String>,
    #[serde(default)]
    status_check_rollup: Vec<RawCheck>,
    #[serde(default)]
    reviews: Vec<RawReview>,
    #[serde(default)]
    comments: Vec<RawComment>,
    #[serde(default)]
    commits: Vec<RawPrCommit>,
    #[serde(default)]
    additions: u64,
    #[serde(default)]
    deletions: u64,
    #[serde(default)]
    changed_files: u64,
    #[serde(default)]
    mergeable: String,
    #[serde(default)]
    merge_state_status: String,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    review_requests: Vec<reviewers::RawRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPrCommit {
    oid: String,
    #[serde(default)]
    message_headline: String,
    #[serde(default)]
    message_body: String,
    #[serde(default)]
    committed_date: String,
    #[serde(default)]
    authors: Vec<RawCommitAuthor>,
}

#[derive(Deserialize)]
struct RawCommitAuthor {
    #[serde(default)]
    login: String,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRepoSettings {
    default_branch_ref: Option<RawBranchName>,
    #[serde(default)]
    merge_commit_allowed: bool,
    #[serde(default)]
    squash_merge_allowed: bool,
    #[serde(default)]
    rebase_merge_allowed: bool,
    #[serde(default)]
    delete_branch_on_merge: bool,
}

#[derive(Deserialize)]
struct RawBranchName {
    name: String,
}

impl RawPrDetail {
    fn into_detail(
        self,
        owner: &str,
        review_comments: Vec<PrReviewComment>,
        review_threads: Vec<PrReviewThread>,
    ) -> PullRequestDetail {
        PullRequestDetail {
            number: self.number,
            title: self.title,
            body: self.body,
            state: self.state,
            is_draft: self.is_draft,
            author: login(self.author),
            base: self.base_ref_name,
            head: self.head_ref_name,
            head_oid: self.head_ref_oid,
            url: self.url,
            created_at: self.created_at,
            review_decision: non_empty(self.review_decision),
            labels: self.labels,
            checks: self
                .status_check_rollup
                .into_iter()
                .map(RawCheck::into_check)
                .collect(),
            reviews: self
                .reviews
                .into_iter()
                .map(|r| PrReview {
                    author: login(r.author),
                    state: r.state,
                    body: r.body,
                    submitted_at: r.submitted_at,
                })
                .collect(),
            review_requests: reviewers::requested_reviewers(self.review_requests, owner),
            comments: self
                .comments
                .into_iter()
                .map(|c| PrComment {
                    id: c.id,
                    author: login(c.author),
                    body: c.body,
                    created_at: c.created_at,
                    url: c.url,
                })
                .collect(),
            review_comments,
            review_threads,
            commits: self
                .commits
                .into_iter()
                .map(|c| PrCommit {
                    oid: c.oid,
                    headline: c.message_headline,
                    body: c.message_body,
                    authors: c
                        .authors
                        .into_iter()
                        .map(|a| if a.login.is_empty() { a.name } else { a.login })
                        .filter(|a| !a.is_empty())
                        .collect(),
                    committed_at: c.committed_date,
                })
                .collect(),
            additions: self.additions,
            deletions: self.deletions,
            changed_files: self.changed_files,
            mergeable: self.mergeable,
            merge_state: self.merge_state_status,
            updated_at: self.updated_at,
            signature: None,
        }
    }
}

/// A line comment as GitHub's REST API has it.
#[derive(Deserialize)]
struct RawReviewComment {
    id: u64,
    user: Option<RawUser>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    path: String,
    line: Option<u32>,
    original_line: Option<u32>,
    #[serde(default)]
    start_line: Option<u32>,
    side: Option<String>,
    #[serde(default)]
    created_at: String,
    in_reply_to_id: Option<u64>,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    diff_hunk: String,
}

impl From<RawReviewComment> for PrReviewComment {
    fn from(r: RawReviewComment) -> Self {
        PrReviewComment {
            id: r.id,
            author: login(r.user),
            body: r.body,
            path: r.path,
            line: r.line,
            original_line: r.original_line,
            start_line: r.start_line,
            side: r.side.unwrap_or_else(|| "RIGHT".into()),
            created_at: r.created_at,
            in_reply_to: r.in_reply_to_id,
            url: r.html_url,
            diff_hunk: r.diff_hunk,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    /// The fake `gh` every test runs instead of the real one, which must never
    /// be called: it logs each call's arguments (tab-separated, one call a
    /// line), its stdin, its folder and GH_PROMPT_DISABLED, then answers from
    /// the files named after its first two arguments — `out.pr.list` on stdout,
    /// `err.pr.list` on stderr, `code.pr.list` as its exit status.
    const FAKE_GH: &str = r#"#!/bin/sh
d="$(dirname "$0")"
(IFS="$(printf '\t')"; printf '%s\n' "$*") >> "$d/argv"
cat >> "$d/stdin"
pwd -P >> "$d/cwd"
printf '%s' "$GH_PROMPT_DISABLED" > "$d/env"
cat "$d/out.$1.$2" 2>/dev/null
cat "$d/err.$1.$2" >&2 2>/dev/null
exit "$(cat "$d/code.$1.$2" 2>/dev/null || echo 0)"
"#;

    pub(super) struct Fake {
        bin: tempfile::TempDir,
    }

    impl Fake {
        pub(super) fn new() -> Self {
            Self::with_script(FAKE_GH)
        }

        pub(super) fn with_script(script: &str) -> Self {
            let bin = tempfile::tempdir().unwrap();
            let gh = bin.path().join("gh");
            fs::write(&gh, script).unwrap();
            fs::set_permissions(&gh, fs::Permissions::from_mode(0o755)).unwrap();
            Self { bin }
        }

        /// Write `name` beside the fake, for a script of its own to read.
        pub(super) fn write(&self, name: &str, text: &str) {
            fs::write(self.bin.path().join(name), text).unwrap();
        }

        /// What `gh <command>` (its first two arguments) answers.
        pub(super) fn answer(&self, command: &str, stdout: &str, stderr: &str, code: i32) -> &Self {
            let key = command.replace(' ', ".");
            let dir = self.bin.path();
            fs::write(dir.join(format!("out.{key}")), stdout).unwrap();
            fs::write(dir.join(format!("err.{key}")), stderr).unwrap();
            fs::write(dir.join(format!("code.{key}")), code.to_string()).unwrap();
            self
        }

        /// The fake first on PATH, then the real PATH for sh, git and sleep.
        pub(super) fn gh(&self) -> Gh {
            let real = std::env::var_os("PATH").unwrap_or_default();
            let dirs =
                std::iter::once(self.bin.path().to_path_buf()).chain(std::env::split_paths(&real));
            Gh::with_search_path(std::env::join_paths(dirs).unwrap())
        }

        pub(super) fn calls(&self) -> Vec<Vec<String>> {
            fs::read_to_string(self.bin.path().join("argv"))
                .unwrap_or_default()
                .lines()
                .map(|l| l.split('\t').map(str::to_string).collect())
                .collect()
        }

        fn read(&self, name: &str) -> String {
            fs::read_to_string(self.bin.path().join(name)).unwrap_or_default()
        }
    }

    /// A repository with one commit and `remotes`.
    fn repo_with(remotes: &[(&str, &str)]) -> (tempfile::TempDir, Repo) {
        let dir = tempfile::tempdir().unwrap();
        let git = git2::Repository::init(dir.path()).unwrap();
        let sig = git2::Signature::now("T", "t@example.com").unwrap();
        let tree = git.treebuilder(None).unwrap().write().unwrap();
        let tree = git.find_tree(tree).unwrap();
        git.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
            .unwrap();
        for (name, url) in remotes {
            git.remote(name, url).unwrap();
        }
        let repo = Repo::open(dir.path()).unwrap();
        (dir, repo)
    }

    pub(super) fn github_repo() -> (tempfile::TempDir, Repo) {
        repo_with(&[("origin", "git@github.com:octo/hello.git")])
    }

    pub(super) fn message(err: Error) -> String {
        match err {
            Error::Message(m) => m,
            other => panic!("expected a message, got {other:?}"),
        }
    }

    const LIST_JSON: &str = r#"[
      {"number": 12, "title": "Add widgets", "author": {"login": "octocat"}, "isDraft": false,
       "reviewDecision": "APPROVED", "headRefName": "widgets", "baseRefName": "main",
       "updatedAt": "2026-10-29T10:00:00Z", "url": "https://github.com/octo/hello/pull/12",
       "labels": [{"id": "L1", "name": "enhancement", "color": "a2eeef"}],
       "latestReviews": [{"author": {"login": "a"}, "state": "APPROVED"},
         {"author": {"login": "b"}, "state": "APPROVED"}, {"author": {"login": "c"}, "state": "COMMENTED"}],
       "statusCheckRollup": [
         {"__typename": "CheckRun", "name": "build", "status": "COMPLETED", "conclusion": "SUCCESS"},
         {"__typename": "StatusContext", "context": "ci/legacy", "state": "FAILURE"}]},
      {"number": 9, "title": "WIP", "author": null, "isDraft": true, "reviewDecision": "",
       "mergeable": "CONFLICTING", "headRefName": "wip", "baseRefName": "main", "url": "https://github.com/octo/hello/pull/9",
       "labels": [], "statusCheckRollup": [
         {"__typename": "CheckRun", "name": "test", "status": "IN_PROGRESS", "conclusion": ""}]}
    ]"#;

    #[test]
    fn listing_names_the_repo_asks_for_json_and_reads_the_answer() {
        let fake = Fake::new();
        fake.answer("pr list", LIST_JSON, "", 0);
        fake.answer(
            "api graphql",
            r#"{"data": {"repository": {"pullRequests": {"nodes": [
                {"number": 12, "reviewThreads": {"nodes": [{"isResolved": true}, {"isResolved": false}]}}
            ]}}}}"#,
            "",
            0,
        );
        let (_dir, repo) = github_repo();
        let prs = repo.pull_requests(&fake.gh(), PrFilter::Mine).unwrap();

        let calls = fake.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1][..2], ["api", "graphql"]);
        let args = &calls[0];
        assert_eq!(
            args[..8],
            [
                "pr",
                "list",
                "--repo",
                "octo/hello",
                "--state",
                "open",
                "--limit",
                "100"
            ]
        );
        assert_eq!(args[8], "--json");
        assert!(args[9].split(',').any(|f| f == "statusCheckRollup"));
        assert_eq!(args[10..], ["--author", "@me"]);
        assert_eq!(fake.read("env"), "1", "gh is told not to prompt");

        assert_eq!(prs.len(), 2);
        assert_eq!(prs[0].number, 12);
        assert_eq!(prs[0].author, "octocat");
        assert_eq!(prs[0].review_decision.as_deref(), Some("APPROVED"));
        // A failing commit status fails the lot, whatever the check runs say.
        assert_eq!(prs[0].checks.as_deref(), Some("failure"));
        assert_eq!(
            prs[0].labels,
            [PrLabel {
                name: "enhancement".into(),
                color: "a2eeef".into()
            }]
        );
        assert_eq!((prs[0].approvals, prs[0].unresolved_threads), (2, Some(1)));
        assert_eq!(
            (prs[1].approvals, prs[1].unresolved_threads),
            (0, None),
            "not in GraphQL's answer"
        );
        assert_eq!(
            (prs[0].conflicting, prs[1].conflicting),
            (false, true),
            "only CONFLICTING is a conflict; a missing answer is not"
        );
        assert_eq!(prs[1].author, "ghost");
        assert!(prs[1].is_draft);
        assert_eq!(prs[1].review_decision, None);
        assert_eq!(prs[1].checks.as_deref(), Some("pending"));
    }

    #[test]
    fn merged_lists_the_last_twenty_by_when_they_were_merged() {
        let fake = Fake::new();
        fake.answer(
            "pr list",
            r#"[{"number": 5, "title": "Older", "author": {"login": "a"}, "headRefName": "x",
                 "baseRefName": "main", "url": "u5", "mergedAt": "2026-11-01T08:00:00Z"},
                {"number": 3, "title": "Newer", "author": {"login": "b"}, "headRefName": "y",
                 "baseRefName": "main", "url": "u3", "mergedAt": "2026-11-05T08:00:00Z"}]"#,
            "",
            0,
        );
        let (_dir, repo) = github_repo();
        let prs = repo.pull_requests(&fake.gh(), PrFilter::Merged).unwrap();

        let calls = fake.calls();
        assert_eq!(calls.len(), 1, "no thread query for merged ones");
        assert_eq!(calls[0][4..8], ["--state", "merged", "--limit", "20"]);
        assert_eq!(calls[0][10..], ["--search", "sort:updated-desc"]);
        assert_eq!(prs.iter().map(|p| p.number).collect::<Vec<_>>(), [3, 5]);
        assert_eq!(prs[0].merged_at.as_deref(), Some("2026-11-05T08:00:00Z"));
    }

    #[test]
    fn review_requested_lists_by_search_and_all_adds_nothing() {
        let fake = Fake::new();
        fake.answer("pr list", "[]", "", 0);
        let (_dir, repo) = github_repo();
        repo.pull_requests(&fake.gh(), PrFilter::ReviewRequested)
            .unwrap();
        repo.pull_requests(&fake.gh(), PrFilter::All).unwrap();
        // Each list also asks GraphQL for its threads.
        let calls: Vec<_> = fake.calls().into_iter().filter(|c| c[0] == "pr").collect();
        assert_eq!(calls[0][10..], ["--search", "review-requested:@me"]);
        assert_eq!(calls[1].len(), 10);
    }

    #[test]
    fn the_repository_comes_from_the_remotes_as_gh_picks_it() {
        let (_d, fork) = repo_with(&[
            ("origin", "https://github.com/me/hello.git"),
            ("upstream", "git@github.com:octo/hello.git"),
        ]);
        assert_eq!(fork.github_repo().as_deref(), Some("octo/hello"));

        let (_d, aliased) = repo_with(&[
            ("gitlab", "git@gitlab.com:me/hello.git"),
            ("work", "git@github.com-work:corp/app.git"),
        ]);
        assert_eq!(aliased.github_repo().as_deref(), Some("corp/app"));

        let (_d, enterprise) = repo_with(&[("origin", "https://github.corp.example/team/app")]);
        assert_eq!(
            enterprise.github_repo().as_deref(),
            Some("github.corp.example/team/app")
        );

        let (dir, resolved) = repo_with(&[
            ("origin", "git@github.com:me/hello.git"),
            ("upstream", "git@github.com:octo/hello.git"),
        ]);
        git2::Repository::open(dir.path())
            .unwrap()
            .config()
            .unwrap()
            .set_str("remote.origin.gh-resolved", "base")
            .unwrap();
        assert_eq!(resolved.github_repo().as_deref(), Some("me/hello"));
    }

    #[test]
    fn a_repository_without_a_github_remote_never_runs_gh() {
        let fake = Fake::new();
        let (_dir, repo) = repo_with(&[("origin", "git@gitlab.com:me/hello.git")]);
        assert_eq!(repo.github_repo(), None);
        let err = repo.pull_requests(&fake.gh(), PrFilter::All).unwrap_err();
        assert_eq!(message(err), NO_GITHUB_REMOTE);
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn a_comment_goes_in_on_stdin_never_on_the_command_line() {
        let fake = Fake::new();
        fake.answer(
            "pr comment",
            "https://github.com/octo/hello/pull/7#issuecomment-1\n",
            "",
            0,
        );
        let (_dir, repo) = github_repo();
        let body = "--repo evil/repo\n$(touch pwned) `id` 'quoted' \"double\"";
        let url = repo.comment_on_pull_request(&fake.gh(), 7, body).unwrap();
        assert_eq!(url, "https://github.com/octo/hello/pull/7#issuecomment-1");
        assert_eq!(
            fake.calls(),
            [[
                "pr",
                "comment",
                "7",
                "--repo",
                "octo/hello",
                "--body-file",
                "-"
            ]]
        );
        assert_eq!(fake.read("stdin"), body);
    }

    #[test]
    fn an_empty_comment_is_refused_before_gh_runs() {
        let fake = Fake::new();
        let (_dir, repo) = github_repo();
        assert!(repo.comment_on_pull_request(&fake.gh(), 7, "  \n").is_err());
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn reviews_pass_the_verdict_as_a_flag_and_the_text_on_stdin() {
        let fake = Fake::new();
        fake.answer("pr review", "", "✓ Approved pull request #7\n", 0);
        let (_dir, repo) = github_repo();
        let gh = fake.gh();
        let said = repo
            .review_pull_request(&gh, 7, ReviewVerdict::Approve, "")
            .unwrap();
        assert_eq!(said, "✓ Approved pull request #7");
        repo.review_pull_request(&gh, 7, ReviewVerdict::RequestChanges, "Please add tests")
            .unwrap();
        let err = repo
            .review_pull_request(&gh, 7, ReviewVerdict::Comment, " ")
            .unwrap_err();
        assert!(message(err).contains("needs a message"));

        let calls = fake.calls();
        assert_eq!(calls.len(), 2, "the empty comment review never ran gh");
        assert_eq!(
            calls[0],
            ["pr", "review", "7", "--repo", "octo/hello", "--approve"]
        );
        assert_eq!(
            calls[1],
            [
                "pr",
                "review",
                "7",
                "--repo",
                "octo/hello",
                "--request-changes",
                "--body-file",
                "-"
            ]
        );
        assert_eq!(fake.read("stdin"), "Please add tests");
    }

    const COMMENT_JSON: &str = r#"{"id": 101, "user": {"login": "octocat"}, "body": "Nit",
        "path": "src/lib.rs", "line": 14, "original_line": 14, "side": "RIGHT",
        "created_at": "2026-10-30T09:00:00Z", "html_url": "https://github.com/octo/hello/pull/7#discussion_r101",
        "diff_hunk": "@@ -10,3 +10,5 @@"}"#;

    #[test]
    fn the_review_command_gets_the_diff_on_stdin_and_the_pull_request_in_its_environment() {
        let fake = Fake::new();
        fake.answer("pr diff", "diff --git a/x b/x\n+hello\n", "", 0);
        let (_dir, repo) = github_repo();
        let out = repo
            .generate_review_drafts(
                &fake.gh(),
                7,
                "printf '%s|%s|%s|' \"$GITP_PR_NUMBER\" \"$GITP_PR_REPO\" \"$GITP_PR_URL\"; cat",
            )
            .unwrap();
        assert_eq!(
            out.text,
            "7|octo/hello|https://github.com/octo/hello/pull/7|diff --git a/x b/x\n+hello\n"
        );
        assert_eq!(out.file, None);
        assert_eq!(fake.calls(), [["pr", "diff", "7", "--repo", "octo/hello"]]);

        let err = repo
            .generate_review_drafts(&fake.gh(), 7, "echo 'no model today' >&2; exit 3")
            .unwrap_err();
        let text = message(err);
        assert!(
            text.contains("exit code 3") && text.contains("no model today"),
            "{text}"
        );
        let err = repo
            .generate_review_drafts(&fake.gh(), 7, "true")
            .unwrap_err();
        assert!(message(err).contains("printed nothing"));
        assert!(repo.generate_review_drafts(&fake.gh(), 7, "  ").is_err());
    }

    #[test]
    fn a_pull_request_head_is_fetched_into_a_private_ref_only_when_missing() {
        // A second local repository stands in for GitHub: `origin` points at it.
        let (upstream_dir, _upstream) = github_repo();
        let upstream = git2::Repository::open(upstream_dir.path()).unwrap();
        // A commit of its own: the two "init" commits are the same object.
        let parent = upstream.head().unwrap().peel_to_commit().unwrap();
        let sig = git2::Signature::now("T", "t@example.com").unwrap();
        let id = upstream
            .commit(
                Some("refs/pull/7/head"),
                &sig,
                &sig,
                "the pr",
                &parent.tree().unwrap(),
                &[&parent],
            )
            .unwrap();
        let head = upstream.find_commit(id).unwrap();
        let (dir, repo) = repo_with(&[("origin", upstream_dir.path().to_str().unwrap())]);
        let sha = head.id().to_string();
        assert!(repo.resolve_commit(&sha).is_err(), "not local yet");
        repo.ensure_pull_request_head(7, &sha).unwrap();
        assert_eq!(repo.resolve_commit("refs/gitp/pr/7/head").unwrap(), sha);
        assert_eq!(repo.resolve_commit(&sha).unwrap(), sha);
        // Already local: no fetch, so a remote that no longer exists is fine.
        git2::Repository::open(dir.path())
            .unwrap()
            .remote_set_url("origin", "/nonexistent")
            .unwrap();
        let repo = Repo::open(dir.path()).unwrap();
        repo.ensure_pull_request_head(7, &sha).unwrap();
        assert!(repo
            .ensure_pull_request_head(8, "0000000000000000000000000000000000000000")
            .is_err());
        assert!(repo.ensure_pull_request_head(8, "nope").is_err());
    }

    #[test]
    fn a_rebased_pull_request_head_replaces_the_private_ref() {
        let (upstream_dir, _upstream) = github_repo();
        let upstream = git2::Repository::open(upstream_dir.path()).unwrap();
        let root = upstream.head().unwrap().peel_to_commit().unwrap();
        let sig = git2::Signature::now("T", "t@example.com").unwrap();
        let first = upstream
            .commit(
                Some("refs/pull/7/head"),
                &sig,
                &sig,
                "before rebase",
                &root.tree().unwrap(),
                &[&root],
            )
            .unwrap();
        let (_dir, repo) = repo_with(&[("origin", upstream_dir.path().to_str().unwrap())]);
        repo.ensure_pull_request_head(7, &first.to_string())
            .unwrap();
        // The author rebases: the new head is not a descendant of the old one.
        let rebased = upstream
            .commit(
                None,
                &sig,
                &sig,
                "after rebase",
                &root.tree().unwrap(),
                &[&root],
            )
            .unwrap();
        upstream
            .reference("refs/pull/7/head", rebased, true, "force")
            .unwrap();
        repo.ensure_pull_request_head(7, &rebased.to_string())
            .unwrap();
        assert_eq!(
            repo.resolve_commit("refs/gitp/pr/7/head").unwrap(),
            rebased.to_string()
        );
    }

    fn thread_input(repo: &Repo) -> ThreadInput {
        let comment = |id: u64, in_reply_to: Option<u64>, body: &str| PrReviewComment {
            id,
            author: "anna".into(),
            body: body.into(),
            path: "src/retry.ts".into(),
            line: Some(12),
            original_line: Some(12),
            start_line: None,
            side: "RIGHT".into(),
            created_at: "2026-11-04T09:00:00Z".into(),
            in_reply_to,
            url: String::new(),
            diff_hunk: "@@ -1 +1 @@\n-a\n+b".into(),
        };
        ThreadInput {
            number: 7,
            head: repo.resolve_commit("HEAD").unwrap(),
            author: "octocat".into(),
            title: Some("Retry fix".into()),
            comments: vec![
                comment(500, None, "stops early?"),
                comment(501, Some(500), "yes?"),
            ],
        }
    }

    #[test]
    fn a_turn_stores_the_title_line_and_comments() {
        let fake = Fake::new();
        let (_dir, repo) = github_repo();
        let input = thread_input(&repo);
        let c = repo
            .thread_claude_turn(&fake.gh(), &input, TurnKind::Check, "", "echo ok")
            .unwrap();
        let said = |c: &ThreadConversation| {
            c.comments
                .iter()
                .map(|x| format!("{}: {}", x.author, x.body))
                .collect::<Vec<_>>()
        };
        assert_eq!((c.title.as_deref(), c.line), (Some("Retry fix"), Some(12)));
        assert_eq!(said(&c), ["anna: stops early?", "anna: yes?"]);
        // A later turn takes the thread as it is now; an unknown title keeps the stored one.
        let mut later = input.clone();
        later.title = None;
        later.comments[1].body = "yes, edited".into();
        later.comments.push(PrReviewComment {
            id: 502,
            body: "and?".into(),
            ..later.comments[1].clone()
        });
        let c = repo
            .thread_claude_turn(&fake.gh(), &later, TurnKind::Explain, "", "echo ok")
            .unwrap();
        assert_eq!(c.title.as_deref(), Some("Retry fix"));
        assert_eq!(
            said(&c),
            ["anna: stops early?", "anna: yes, edited", "anna: and?"]
        );
        assert_eq!(repo.thread_conversation(7, 500).unwrap(), Some(c));
    }

    #[test]
    fn a_thread_turn_gets_the_thread_in_its_environment_and_file_and_is_saved() {
        let fake = Fake::new();
        fake.answer(
            "auth status",
            "Logged in to github.com account me (keyring)\n",
            "",
            0,
        );
        let (_dir, repo) = github_repo();
        let input = thread_input(&repo);
        let cmd = "printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|' \"$GITP_PR_NUMBER\" \"$GITP_PR_URL\" \"$GITP_PR_HEAD\" \
            \"$GITP_PR_AUTHOR\" \"$GITP_GH_LOGIN\" \"$GITP_THREAD_ID\" \"$GITP_THREAD_PATH\" \"$GITP_THREAD_LINE\" \
            \"$GITP_TURN_KIND\"; cat \"$GITP_THREAD_FILE\"";
        let c = repo
            .thread_claude_turn(&fake.gh(), &input, TurnKind::Check, "", cmd)
            .unwrap();
        assert_eq!(c.turns.len(), 1);
        let t = &c.turns[0];
        assert_eq!(
            (t.kind, t.role, t.head.as_deref()),
            (TurnKind::Check, TurnRole::Claude, Some(input.head.as_str()))
        );
        let prefix = format!(
            "7|https://github.com/octo/hello/pull/7|{}|octocat|me|500|src/retry.ts|12|check|",
            input.head
        );
        assert!(t.text.starts_with(&prefix), "{}", t.text);
        let json: serde_json::Value = serde_json::from_str(&t.text[prefix.len()..]).unwrap();
        assert_eq!(json["comments"][1]["body"], "yes?");
        assert_eq!(json["path"], "src/retry.ts");
        assert_eq!(
            json["turns"].as_array().unwrap().len(),
            0,
            "the first turn sees no history"
        );
        assert_eq!(c.session, None, "plain text gives no session");
        assert_eq!(repo.thread_conversation(7, 500).unwrap(), Some(c));
    }

    #[test]
    fn a_fresh_turn_is_offered_a_session_id_and_a_resumed_one_is_not() {
        let fake = Fake::new();
        let (_dir, mut repo) = github_repo();
        let runs = Arc::new(std::sync::Mutex::new(Vec::<ClaudeRun>::new()));
        let seen = Arc::clone(&runs);
        repo.set_network_hooks(NetworkHooks {
            on_claude_run: Some(Box::new(move |run| seen.lock().unwrap().push(run.clone()))),
            ..NetworkHooks::default()
        });
        let input = thread_input(&repo);
        let cmd = r#"printf '{"result":"[%s]","session_id":"%s"}' "$GITP_CLAUDE_NEW_SESSION" "${GITP_CLAUDE_NEW_SESSION:-kept}""#;
        let c = repo
            .thread_claude_turn(&fake.gh(), &input, TurnKind::Check, "", cmd)
            .unwrap();
        let first = runs.lock().unwrap()[0].clone();
        assert!(!first.resumed);
        assert_eq!(first.session.len(), 36, "a fresh UUID");
        assert_eq!(first.dir, repo.workdir());
        assert_eq!(c.turns[0].text, format!("[{}]", first.session));
        assert_eq!(c.session.as_deref(), Some(first.session.as_str()));
        let c = repo
            .thread_claude_turn(&fake.gh(), &input, TurnKind::Followup, "why?", cmd)
            .unwrap();
        let second = runs.lock().unwrap()[1].clone();
        assert_eq!(
            (second.resumed, second.session.as_str()),
            (true, first.session.as_str())
        );
        assert_eq!(c.turns.last().unwrap().text, "[]", "no new id on a resume");
    }

    #[test]
    fn a_followup_stores_the_question_sends_it_on_stdin_and_resumes_the_session() {
        let fake = Fake::new();
        let (_dir, repo) = github_repo();
        let input = thread_input(&repo);
        let json_cmd = r#"printf '{"result":"first answer","session_id":"s-1","is_error":false}'"#;
        let c = repo
            .thread_claude_turn(&fake.gh(), &input, TurnKind::Check, "", json_cmd)
            .unwrap();
        assert_eq!(
            (c.session.as_deref(), c.turns[0].text.as_str()),
            (Some("s-1"), "first answer")
        );
        let cmd = r#"q=$(cat); printf '{"result":"%s / %s / %s","session_id":"s-2"}' "$GITP_CLAUDE_SESSION" "$q" "$GITP_TURN_KIND""#;
        let c = repo
            .thread_claude_turn(&fake.gh(), &input, TurnKind::Followup, "why?", cmd)
            .unwrap();
        assert_eq!(c.turns.len(), 3);
        assert_eq!(
            (
                c.turns[1].role,
                c.turns[1].kind,
                c.turns[1].text.as_str(),
                c.turns[1].head.as_deref()
            ),
            (TurnRole::User, TurnKind::Followup, "why?", None)
        );
        assert_eq!(c.turns[2].text, "s-1 / why? / followup");
        assert_eq!(c.session.as_deref(), Some("s-2"));
        // A failed follow-up keeps the question.
        let err = repo
            .thread_claude_turn(&fake.gh(), &input, TurnKind::Followup, "again?", "exit 2")
            .unwrap_err();
        assert!(message(err).contains("exit code 2"));
        let c = repo.thread_conversation(7, 500).unwrap().unwrap();
        assert_eq!((c.turns.len(), c.turns[3].text.as_str()), (4, "again?"));
    }

    #[test]
    fn a_session_that_no_longer_exists_is_dropped_and_the_turn_runs_fresh() {
        let fake = Fake::new();
        let (_dir, repo) = github_repo();
        let input = thread_input(&repo);
        repo.thread_claude_turn(
            &fake.gh(),
            &input,
            TurnKind::Check,
            "",
            r#"printf '{"result":"first","session_id":"gone"}'"#,
        )
        .unwrap();
        // The command fails on a resume — Claude Code forgot the session —
        // and answers when run without one.
        let cmd = r#"q=$(cat); if [ -n "$GITP_CLAUDE_SESSION" ]; then echo "No conversation found with session ID: $GITP_CLAUDE_SESSION" >&2; exit 1; fi; printf '{"result":"fresh: %s","session_id":"new"}' "$q""#;
        let c = repo
            .thread_claude_turn(&fake.gh(), &input, TurnKind::Followup, "why?", cmd)
            .unwrap();
        assert_eq!(c.turns.last().unwrap().text, "fresh: why?");
        assert_eq!(c.session.as_deref(), Some("new"));
        // A command that fails for another reason fails once, not twice.
        let count = _dir.path().join("runs");
        let cmd = format!("echo x >> {}; exit 3", count.display());
        assert!(repo
            .thread_claude_turn(&fake.gh(), &input, TurnKind::Check, "", &cmd)
            .is_err());
        assert_eq!(std::fs::read_to_string(&count).unwrap().lines().count(), 1);
    }

    #[test]
    fn a_followup_is_kept_when_the_head_cannot_be_fetched() {
        let fake = Fake::new();
        // A GitHub host that no DNS resolves: the fetch fails at once.
        let (_dir, repo) = repo_with(&[("origin", "https://github.invalid/octo/hello.git")]);
        let input = ThreadInput {
            head: "1234567890123456789012345678901234567890".into(),
            ..thread_input(&repo)
        };
        let err = repo
            .thread_claude_turn(&fake.gh(), &input, TurnKind::Followup, "why?", "echo hi")
            .unwrap_err();
        let text = message(err);
        assert!(
            !text.contains("printed nothing"),
            "the command never ran: {text}"
        );
        let c = repo.thread_conversation(7, 500).unwrap().unwrap();
        assert_eq!(
            (c.turns.len(), c.turns[0].role, c.turns[0].text.as_str()),
            (1, TurnRole::User, "why?")
        );
    }

    #[test]
    fn a_json_answer_that_is_an_error_fails_the_turn_and_stores_nothing() {
        let fake = Fake::new();
        let (_dir, repo) = github_repo();
        let input = thread_input(&repo);
        let err = repo
            .thread_claude_turn(
                &fake.gh(),
                &input,
                TurnKind::Explain,
                "",
                r#"printf '{"result":"Not logged in","is_error":true}'"#,
            )
            .unwrap_err();
        assert!(message(err).contains("Not logged in"));
        assert_eq!(repo.thread_conversation(7, 500).unwrap(), None);
        let err = repo
            .thread_claude_turn(
                &fake.gh(),
                &input,
                TurnKind::Explain,
                "",
                r#"printf '{"type":"result","subtype":"error_max_turns","is_error":true}'"#,
            )
            .unwrap_err();
        assert!(message(err).contains("error_max_turns"));
        assert_eq!(repo.thread_conversation(7, 500).unwrap(), None);
        let err = repo
            .thread_claude_turn(&fake.gh(), &input, TurnKind::Explain, "", "true")
            .unwrap_err();
        assert!(message(err).contains("printed nothing"));
        assert!(repo
            .thread_claude_turn(&fake.gh(), &input, TurnKind::Explain, "", "  ")
            .is_err());
        let empty = ThreadInput {
            comments: vec![],
            ..input.clone()
        };
        assert!(repo
            .thread_claude_turn(&fake.gh(), &empty, TurnKind::Check, "", "true")
            .is_err());
    }

    /// A repository with a GitHub remote whose branch `feature` is checked
    /// out in a linked worktree (`dir/wt`), and a saved Check plus the chosen
    /// option "restore >" on thread 500 of pull request 7.
    fn fix_repo() -> (tempfile::TempDir, Repo, PathBuf) {
        let (dir, repo) = github_repo();
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
        };
        git(&["branch", "feature"]);
        git(&["worktree", "add", "-q", "wt", "feature"]);
        // The linked worktree lives inside the main checkout here: not a
        // change of it.
        std::fs::write(dir.path().join(".git/info/exclude"), "wt\n").unwrap();
        let wt = dir.path().join("wt");
        let head = repo.resolve_commit("HEAD").unwrap();
        repo.save_thread_conversation(&ThreadConversation {
            version: 1,
            pr: 7,
            thread: 500,
            path: "src/retry.ts".into(),
            title: None,
            line: None,
            comments: vec![],
            session: Some("main-s".into()),
            fix_session: None,
            turns: vec![
                ThreadTurn::claude(TurnKind::Check, head, "**Bottom line:** …".into()),
                ThreadTurn::user(TurnKind::Followup, "restore >".into()),
            ],
        })
        .unwrap();
        (dir, repo, wt)
    }

    const COMMIT_ONCE: &str = r#"printf '{"result":"fixed in %s before=%s session=%s","session_id":"fs"}' "$PWD" "$GITP_FIX_HEAD_BEFORE" "$GITP_CLAUDE_SESSION"; echo x > fixed.txt; git add fixed.txt; git -c user.name=T -c user.email=t@example.com commit -qm "fix(review): src/retry.ts:12 — x""#;
    const REPLY: &str = r#"printf '{"result":"reply from %s session=%s","session_id":"rs"}' "$PWD" "$GITP_CLAUDE_SESSION""#;

    #[test]
    fn a_fix_runs_in_the_branch_worktree_commits_once_and_drafts_the_reply() {
        let fake = Fake::new();
        let (dir, repo, wt) = fix_repo();
        let input = thread_input(&repo);
        let before = repo.resolve_commit("feature").unwrap();
        let c = repo
            .fix_thread(&fake.gh(), &input, "feature", COMMIT_ONCE, REPLY)
            .unwrap();
        let after = repo.resolve_commit("feature").unwrap();
        assert_ne!(before, after);
        let n = c.turns.len();
        let fix = &c.turns[n - 2];
        let reply = &c.turns[n - 1];
        assert_eq!((fix.kind, fix.role), (TurnKind::Fix, TurnRole::Claude));
        assert_eq!(fix.commit.as_deref(), Some(after.as_str()));
        assert_eq!(fix.head.as_deref(), Some(after.as_str()));
        assert_eq!(
            fix.worktree.as_deref().map(canonical_str),
            Some(canonical_str(wt.to_str().unwrap()))
        );
        assert!(
            fix.text.contains(&format!("before={before}")),
            "{}",
            fix.text
        );
        assert!(
            fix.text.contains(&canonical_str(wt.to_str().unwrap())),
            "{}",
            fix.text
        );
        assert!(
            fix.text.contains("session=") && !fix.text.contains("session=main-s"),
            "the fix never resumes the main session: {}",
            fix.text
        );
        assert_eq!(
            (reply.kind, reply.role),
            (TurnKind::ReplyDraft, TurnRole::Claude)
        );
        assert!(
            reply
                .text
                .contains(&canonical_str(dir.path().to_str().unwrap())),
            "{}",
            reply.text
        );
        assert!(reply.text.contains("session=main-s"), "{}", reply.text);
        assert_eq!(
            (c.fix_session.as_deref(), c.session.as_deref()),
            (Some("fs"), Some("rs"))
        );
        assert!(wt.join("fixed.txt").exists());
    }

    fn canonical_str(p: &str) -> String {
        std::fs::canonicalize(p)
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn a_fix_that_commits_twice_or_leaves_the_tree_dirty_is_undone() {
        let fake = Fake::new();
        let (_dir, repo, wt) = fix_repo();
        let input = thread_input(&repo);
        let before = repo.resolve_commit("feature").unwrap();
        let twice = format!("{COMMIT_ONCE}; echo y > again.txt; git add again.txt; git -c user.name=T -c user.email=t@example.com commit -qm twice");
        let err = repo
            .fix_thread(&fake.gh(), &input, "feature", &twice, REPLY)
            .unwrap_err();
        assert!(message(err).contains("one commit"));
        assert_eq!(repo.resolve_commit("feature").unwrap(), before);
        assert!(!wt.join("fixed.txt").exists() && !wt.join("again.txt").exists());

        let err = repo
            .fix_thread(
                &fake.gh(),
                &input,
                "feature",
                "echo z > dirty.txt; echo done",
                REPLY,
            )
            .unwrap_err();
        assert!(message(err).contains("one commit"), "no commit at all");
        assert!(!wt.join("dirty.txt").exists());

        let err = repo
            .fix_thread(
                &fake.gh(),
                &input,
                "feature",
                "echo w > half.txt; exit 3",
                REPLY,
            )
            .unwrap_err();
        assert!(message(err).contains("exit code 3"));
        assert!(!wt.join("half.txt").exists());
        assert_eq!(repo.resolve_commit("feature").unwrap(), before);
        let c = repo.thread_conversation(7, 500).unwrap().unwrap();
        assert!(
            c.turns.iter().all(|t| t.kind != TurnKind::Fix),
            "no fix turn kept"
        );
    }

    #[test]
    fn a_fix_that_amends_or_leaves_the_branch_is_undone_on_the_branch() {
        let fake = Fake::new();
        let (_dir, repo, wt) = fix_repo();
        let input = thread_input(&repo);
        let before = repo.resolve_commit("feature").unwrap();
        // An amend: one commit ahead of nothing, the old one gone.
        let amend = r#"echo amended; echo a > a.txt; git add a.txt; git -c user.name=T -c user.email=t@example.com commit -q --amend --no-edit"#;
        let err = message(
            repo.fix_thread(&fake.gh(), &input, "feature", amend, REPLY)
                .unwrap_err(),
        );
        assert!(err.contains("one commit"), "{err}");
        assert_eq!(repo.resolve_commit("feature").unwrap(), before);
        assert!(!wt.join("a.txt").exists());
        // A commit on another branch: that branch is left alone, the
        // worktree goes back to feature at before.
        let elsewhere = format!("git checkout -q -b other; {COMMIT_ONCE}");
        let err = message(
            repo.fix_thread(&fake.gh(), &input, "feature", &elsewhere, REPLY)
                .unwrap_err(),
        );
        assert!(
            err.contains("off feature") || err.contains("one commit"),
            "{err}"
        );
        assert_eq!(
            git_in(&wt, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap(),
            "feature"
        );
        assert_eq!(repo.resolve_commit("feature").unwrap(), before);
        assert_ne!(
            repo.resolve_commit("other").unwrap(),
            before,
            "other keeps its commit"
        );
        assert!(!wt.join("fixed.txt").exists());
    }

    #[test]
    fn a_fix_sees_untracked_files_whatever_the_status_config_says() {
        let fake = Fake::new();
        let (_dir, repo, wt) = fix_repo();
        let input = thread_input(&repo);
        git_in(&wt, &["config", "status.showUntrackedFiles", "no"]).unwrap();
        std::fs::write(wt.join("mine.txt"), "wip").unwrap();
        let err = repo
            .fix_thread(&fake.gh(), &input, "feature", "touch ran.txt", REPLY)
            .unwrap_err();
        assert!(message(err).contains("Commit or stash"));
        assert!(wt.join("mine.txt").exists() && !wt.join("ran.txt").exists());
    }

    #[test]
    fn a_fix_refuses_a_dirty_worktree_a_missing_one_and_a_branch_behind() {
        let fake = Fake::new();
        let (dir, repo, wt) = fix_repo();
        let input = thread_input(&repo);
        let marker = "touch ran.txt";
        std::fs::write(wt.join("mine.txt"), "wip").unwrap();
        let err = repo
            .fix_thread(&fake.gh(), &input, "feature", marker, REPLY)
            .unwrap_err();
        assert!(message(err).contains("Commit or stash"));
        assert!(!wt.join("ran.txt").exists());
        std::fs::remove_file(wt.join("mine.txt")).unwrap();

        let err = repo
            .fix_thread(&fake.gh(), &input, "nowhere", marker, REPLY)
            .unwrap_err();
        assert!(message(err).contains("in no worktree"));

        // The pull request's head is a commit the local branch doesn't have.
        let git = git2::Repository::open(dir.path()).unwrap();
        let sig = git2::Signature::now("T", "t@example.com").unwrap();
        let parent = git.head().unwrap().peel_to_commit().unwrap();
        let newer = git
            .commit(
                None,
                &sig,
                &sig,
                "pushed elsewhere",
                &parent.tree().unwrap(),
                &[&parent],
            )
            .unwrap();
        let input = ThreadInput {
            head: newer.to_string(),
            ..input
        };
        let err = repo
            .fix_thread(&fake.gh(), &input, "feature", marker, REPLY)
            .unwrap_err();
        assert!(message(err).contains("behind"));
        assert!(!wt.join("ran.txt").exists());
    }

    #[test]
    fn a_fix_finds_the_branch_in_the_main_checkout() {
        let fake = Fake::new();
        let (dir, repo, _wt) = fix_repo();
        // `main-branch` is what the main checkout is on.
        let name = git2::Repository::open(dir.path())
            .unwrap()
            .head()
            .unwrap()
            .shorthand()
            .unwrap()
            .to_string();
        let input = thread_input(&repo);
        let c = repo
            .fix_thread(&fake.gh(), &input, &name, COMMIT_ONCE, REPLY)
            .unwrap();
        assert!(dir.path().join("fixed.txt").exists());
        let fix = &c.turns[c.turns.len() - 2];
        assert_eq!(
            fix.worktree.as_deref().map(canonical_str),
            Some(canonical_str(dir.path().to_str().unwrap()))
        );
    }

    #[test]
    fn a_fix_never_runs_as_a_plain_turn() {
        let fake = Fake::new();
        let (dir, repo, _wt) = fix_repo();
        let input = thread_input(&repo);
        let err = repo
            .thread_claude_turn(&fake.gh(), &input, TurnKind::Fix, "", "touch ran.txt")
            .unwrap_err();
        assert!(message(err).contains("Fix on the thread"));
        assert!(!dir.path().join("ran.txt").exists());
    }

    #[test]
    fn a_fix_needs_a_chosen_option() {
        let fake = Fake::new();
        let (_dir, repo, _wt) = fix_repo();
        let input = thread_input(&repo);
        let mut c = repo.thread_conversation(7, 500).unwrap().unwrap();
        c.turns.retain(|t| t.role != TurnRole::User);
        repo.save_thread_conversation(&c).unwrap();
        let err = repo
            .fix_thread(&fake.gh(), &input, "feature", "touch ran.txt", REPLY)
            .unwrap_err();
        assert!(message(err).contains("follow-up first"));
    }

    #[test]
    fn a_review_command_that_writes_a_review_file_is_read_from_the_file() {
        let fake = Fake::new();
        fake.answer("pr diff", "diff --git a/x b/x\n+hello\n", "", 0);
        let (dir, repo) = github_repo();
        // An older review of another PR stays as it was: only a file written
        // during the run counts.
        let sprint = dir.path().join("review/ubiid-sprint-36");
        std::fs::create_dir_all(&sprint).unwrap();
        std::fs::write(sprint.join("pr-review-UBIID-1.html"), "old").unwrap();
        thread::sleep(Duration::from_millis(20));
        let out = repo
            .generate_review_drafts(
                &fake.gh(),
                7,
                "cat >/dev/null; printf '# md' > review/ubiid-sprint-36/pr-review-UBIID-7.md; \
                 printf '<html>review</html>' > review/ubiid-sprint-36/pr-review-UBIID-7.html; \
                 echo 'Saved the review'",
            )
            .unwrap();
        assert_eq!(out.text, "<html>review</html>");
        let file = out.file.unwrap();
        assert!(
            file.ends_with("review/ubiid-sprint-36/pr-review-UBIID-7.html"),
            "{file}"
        );

        // Nothing written this time: the printed text is the review again.
        let out = repo
            .generate_review_drafts(&fake.gh(), 7, "cat >/dev/null; echo '### a.rs:1'")
            .unwrap();
        assert_eq!((out.text.as_str(), out.file), ("### a.rs:1\n", None));
    }

    #[test]
    fn explain_more_gets_the_slug_and_the_finding_of_the_saved_review() {
        let (dir, repo) = github_repo();
        let sprint = dir.path().join("review/ae-404");
        std::fs::create_dir_all(&sprint).unwrap();
        std::fs::write(
            sprint.join("pr-review-UBIID-9868.html"),
            "<script id=\"markdown-source\">[#7](https://github.com/octo/hello/pull/7)</script>",
        )
        .unwrap();
        repo.explain_review_finding(
            7,
            "f3",
            "printf '%s %s' \"$GITP_REVIEW_SLUG\" \"$GITP_REVIEW_FINDING\" > said",
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("said")).unwrap(),
            "UBIID-9868 f3"
        );

        assert!(message(
            repo.explain_review_finding(7, "f3; rm -rf x", "true")
                .unwrap_err()
        )
        .contains("not a finding"));
        assert!(
            message(repo.explain_review_finding(8, "f1", "true").unwrap_err())
                .contains("no saved review")
        );
    }

    #[test]
    fn review_files_are_matched_to_pull_requests_by_their_link() {
        let (dir, repo) = github_repo();
        let sprint = dir.path().join("review/ae-403");
        std::fs::create_dir_all(&sprint).unwrap();
        let page = |n: u64| {
            format!(
                "<!doctype html><script id=\"markdown-source\">PR: [#{n}](https://github.com/octo/hello/pull/{n})</script>"
            )
        };
        // One ticket, two pull requests: the file name says nothing about which.
        std::fs::write(sprint.join("pr-review-UBIID-1.html"), page(38)).unwrap();
        std::fs::write(
            dir.path().join("review/pr-review-pr-41.md"),
            "Head: x\nhttps://github.com/octo/hello/pull/41\n",
        )
        .unwrap();
        std::fs::write(sprint.join("notes.html"), page(50)).unwrap();
        std::fs::write(sprint.join("pr-review-no-link.md"), "no pull request here").unwrap();
        thread::sleep(Duration::from_millis(20));
        let newer = dir.path().join("review/pr-review-UBIID-1-again.html");
        std::fs::write(&newer, page(38)).unwrap();

        let found = repo.review_files();
        assert_eq!(
            found.iter().map(|f| f.number).collect::<Vec<_>>(),
            [38, 41],
            "{found:?}"
        );
        assert!(
            found[0]
                .path
                .ends_with("review/pr-review-UBIID-1-again.html"),
            "the newest review of #38: {found:?}"
        );
    }

    #[test]
    fn a_commits_pull_request_comes_from_its_message_or_from_github() {
        let fake = Fake::new();
        let (_dir, repo) = github_repo();
        let sha = "a".repeat(40);
        let named = repo
            .commit_pull_request(&fake.gh(), &sha, Some(3019))
            .unwrap();
        assert_eq!(
            named,
            Some(CommitPullRequest {
                number: 3019,
                url: "https://github.com/octo/hello/pull/3019".into()
            })
        );
        assert!(
            fake.calls().is_empty(),
            "a number in the message needs no call"
        );

        fake.answer(
            "api --method",
            r#"[{"number": 41, "state": "closed"}, {"number": 50}]"#,
            "",
            0,
        );
        let asked = repo.commit_pull_request(&fake.gh(), &sha, None).unwrap();
        assert_eq!(asked.map(|p| p.number), Some(41));
        assert_eq!(
            fake.calls(),
            [vec![
                "api".to_string(),
                "--method".into(),
                "GET".into(),
                format!("repos/octo/hello/commits/{sha}/pulls")
            ]]
        );

        fake.answer("api --method", "[]", "", 0);
        assert_eq!(
            repo.commit_pull_request(&fake.gh(), &sha, None).unwrap(),
            None
        );
        assert!(repo
            .commit_pull_request(&fake.gh(), "--help", None)
            .is_err());
    }

    #[test]
    fn a_review_with_comments_posts_them_all_as_one_review() {
        let fake = Fake::new();
        fake.answer(
            "api --method",
            r#"{"id": 9, "html_url": "https://github.com/octo/hello/pull/7#pullrequestreview-9"}"#,
            "",
            0,
        );
        let (_dir, repo) = github_repo();
        let comment = |line: u32, body: &str| LineComment {
            path: "src/lib.rs".into(),
            line,
            side: DiffSide::Right,
            commit_id: "abc123".into(),
            body: body.into(),
        };
        let url = repo
            .review_with_comments(
                &fake.gh(),
                7,
                ReviewVerdict::RequestChanges,
                "Two things",
                &[comment(14, "Nit"), comment(20, "  Bug  ")],
            )
            .unwrap();
        assert_eq!(
            url,
            "https://github.com/octo/hello/pull/7#pullrequestreview-9"
        );
        assert_eq!(
            fake.calls(),
            [[
                "api",
                "--method",
                "POST",
                "repos/octo/hello/pulls/7/reviews",
                "--input",
                "-"
            ]]
        );
        let sent: serde_json::Value = serde_json::from_str(&fake.read("stdin")).unwrap();
        assert_eq!(
            sent,
            serde_json::json!({"commit_id": "abc123", "event": "REQUEST_CHANGES", "body": "Two things",
            "comments": [
                {"path": "src/lib.rs", "line": 14, "side": "RIGHT", "body": "Nit"},
                {"path": "src/lib.rs", "line": 20, "side": "RIGHT", "body": "Bug"}
            ]})
        );

        // Requesting changes needs a message; an empty comment is refused
        // before anything is sent.
        let err = repo
            .review_with_comments(
                &fake.gh(),
                7,
                ReviewVerdict::RequestChanges,
                "",
                &[comment(1, "x")],
            )
            .unwrap_err();
        assert!(message(err).contains("needs a message"));
        let err = repo
            .review_with_comments(
                &fake.gh(),
                7,
                ReviewVerdict::Comment,
                "",
                &[comment(1, " ")],
            )
            .unwrap_err();
        assert!(message(err).contains("Write a comment first"));
        assert_eq!(fake.calls().len(), 1);
    }

    #[test]
    fn a_line_comment_posts_json_on_stdin_to_the_review_comments_endpoint() {
        let fake = Fake::new();
        fake.answer("api --method", COMMENT_JSON, "", 0);
        let (_dir, repo) = github_repo();
        let comment = LineComment {
            path: "src/lib.rs".into(),
            line: 14,
            side: DiffSide::Right,
            commit_id: "abc123".into(),
            body: "Nit".into(),
        };
        let made = repo.comment_on_line(&fake.gh(), 7, &comment).unwrap();
        assert_eq!(made.id, 101);
        assert_eq!(made.line, Some(14));
        assert_eq!(
            fake.calls(),
            [[
                "api",
                "--method",
                "POST",
                "repos/octo/hello/pulls/7/comments",
                "--input",
                "-"
            ]]
        );
        let sent: serde_json::Value = serde_json::from_str(&fake.read("stdin")).unwrap();
        assert_eq!(
            sent,
            serde_json::json!({"body": "Nit", "commit_id": "abc123", "path": "src/lib.rs",
                "line": 14, "side": "RIGHT"})
        );
    }

    #[test]
    fn a_reply_posts_to_its_threads_replies_endpoint() {
        let fake = Fake::new();
        fake.answer("api --method", COMMENT_JSON, "", 0);
        let (_dir, repo) = github_repo();
        repo.reply_to_review_comment(&fake.gh(), 7, 99, "Done")
            .unwrap();
        assert_eq!(
            fake.calls()[0][3],
            "repos/octo/hello/pulls/7/comments/99/replies"
        );
        let sent: serde_json::Value = serde_json::from_str(&fake.read("stdin")).unwrap();
        assert_eq!(sent, serde_json::json!({"body": "Done"}));
    }

    #[test]
    fn a_resolve_sends_the_graphql_mutation_with_the_thread_id() {
        let fake = Fake::new();
        fake.answer("api graphql", "{}", "", 0);
        let (_dir, repo) = github_repo();
        repo.resolve_review_thread(&fake.gh(), "PRRT_abc", true)
            .unwrap();
        let call = fake.calls()[0].clone();
        assert_eq!(&call[..2], ["api", "graphql"]);
        assert!(call.contains(&"id=PRRT_abc".to_string()));
        assert!(call
            .iter()
            .any(|a| a.contains("resolveReviewThread(input: {threadId: $id})")));
        repo.resolve_review_thread(&fake.gh(), "PRRT_abc", false)
            .unwrap();
        assert!(fake.calls()[1]
            .iter()
            .any(|a| a.contains("unresolveReviewThread(")));
    }

    #[test]
    fn the_detail_reads_its_three_parts_at_once() {
        // Each call waits until all three have started: one after another,
        // the first would give up and the detail would fail.
        let fake = Fake::with_script(
            r#"#!/bin/sh
d="$(dirname "$0")"
touch "$d/started.$1.$2"
i=0
while [ "$(ls "$d" | grep -c '^started\.')" -lt 3 ]; do
  i=$((i+1)); [ $i -gt 200 ] && exit 1
  sleep 0.05
done
cat "$d/out.$1.$2" 2>/dev/null
"#,
        );
        fake.answer(
            "pr view",
            r#"{"number":7,"title":"T","state":"OPEN","author":{"login":"octocat"},
                "baseRefName":"main","headRefName":"topic","url":"https://github.com/octo/hello/pull/7",
                "reviewDecision":null}"#,
            "",
            0,
        );
        fake.answer("api --paginate", "[]", "", 0);
        fake.answer(
            "api graphql",
            r#"{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
                {"id":"PRRT_1","isResolved":false,"comments":{"nodes":[{"databaseId":9}]}}]}}}}}"#,
            "",
            0,
        );
        let (_dir, repo) = github_repo();
        let detail = repo.pull_request(&fake.gh(), 7).unwrap();
        assert_eq!(detail.number, 7);
        assert_eq!(detail.review_threads.len(), 1);
    }

    #[test]
    fn the_threads_resolved_state_rides_along_with_the_detail() {
        let fake = Fake::new();
        fake.answer(
            "pr view",
            r#"{"number":7,"title":"T","state":"OPEN","author":{"login":"octocat"},
                "baseRefName":"main","headRefName":"topic","url":"https://github.com/octo/hello/pull/7",
                "reviewDecision":null}"#,
            "",
            0,
        );
        fake.answer("api --paginate", "[]", "", 0);
        fake.answer(
            "api graphql",
            r#"{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
                {"id":"PRRT_1","isResolved":true,"comments":{"nodes":[{"databaseId":501},{"databaseId":502}]}},
                {"id":"PRRT_2","isResolved":false,"comments":{"nodes":[{"databaseId":600}]}}]}}}}}"#,
            "",
            0,
        );
        let (_dir, repo) = github_repo();
        let detail = repo.pull_request(&fake.gh(), 7).unwrap();
        assert_eq!(
            detail.review_threads,
            vec![
                PrReviewThread {
                    id: "PRRT_1".into(),
                    resolved: true,
                    comment_ids: vec![501, 502]
                },
                PrReviewThread {
                    id: "PRRT_2".into(),
                    resolved: false,
                    comment_ids: vec![600]
                },
            ]
        );
    }

    #[test]
    fn enterprise_api_calls_name_their_host() {
        let fake = Fake::new();
        fake.answer("api --hostname", COMMENT_JSON, "", 0);
        let (_dir, repo) = repo_with(&[("origin", "https://github.corp.example/team/app.git")]);
        repo.reply_to_review_comment(&fake.gh(), 3, 5, "ok")
            .unwrap();
        assert_eq!(
            fake.calls()[0][..4],
            ["api", "--hostname", "github.corp.example", "--method"]
        );
    }

    #[test]
    fn the_detail_joins_the_view_with_every_page_of_line_comments() {
        let fake = Fake::new();
        fake.answer(
            "pr view",
            r#"{"number": 7, "title": "Fix", "body": "Fixes **it**", "state": "OPEN",
                "isDraft": false, "author": {"login": "octocat"}, "baseRefName": "main",
                "headRefName": "fix", "headRefOid": "abc123", "labels": [],
                "url": "https://github.com/octo/hello/pull/7", "createdAt": "2026-10-28T08:00:00Z",
                "reviewDecision": "CHANGES_REQUESTED",
                "statusCheckRollup": [{"__typename": "CheckRun", "name": "lint", "status": "COMPLETED",
                    "conclusion": "SKIPPED", "detailsUrl": "https://ci.example/1"}],
                "reviews": [{"author": {"login": "hubot"}, "state": "CHANGES_REQUESTED",
                    "body": "Needs work", "submittedAt": "2026-10-29T08:00:00Z"}],
                "comments": [{"id": "IC_1", "author": {"login": "hubot"}, "body": "Hi",
                    "createdAt": "2026-10-28T09:00:00Z", "url": "https://github.com/x"}],
                "commits": [{"oid": "abc123", "messageHeadline": "Fix it", "messageBody": "Why",
                    "committedDate": "2026-10-28T07:00:00Z", "authoredDate": "2026-10-28T07:00:00Z",
                    "authors": [{"login": "octocat", "name": "Octo"}, {"login": "", "name": "Claude"}]}],
                "additions": 3, "deletions": 1, "changedFiles": 1,
                "mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY",
                "reviewRequests": [{"__typename": "User", "login": "dung"},
                  {"__typename": "Team", "name": "team-phoenix", "slug": "team-phoenix"}]}"#,
            "",
            0,
        );
        let page2 = COMMENT_JSON
            .replace("101", "102")
            .replace("\"line\": 14", "\"line\": null");
        fake.answer(
            "api --paginate",
            &format!("[{COMMENT_JSON}]\n[{page2}]"),
            "",
            0,
        );
        let (_dir, repo) = github_repo();
        let pr = repo.pull_request(&fake.gh(), 7).unwrap();

        // The calls run at once, so in any order.
        let calls = fake.calls();
        assert!(calls.iter().any(|c| c.starts_with(&[
            "pr".into(),
            "view".into(),
            "7".into(),
            "--repo".into(),
            "octo/hello".into()
        ])));
        assert!(calls.contains(&vec![
            "api".to_string(),
            "--paginate".to_string(),
            "repos/octo/hello/pulls/7/comments?per_page=100".to_string(),
        ]));
        assert_eq!(pr.head_oid, "abc123");
        assert_eq!(
            pr.commits,
            [PrCommit {
                oid: "abc123".into(),
                headline: "Fix it".into(),
                body: "Why".into(),
                authors: vec!["octocat".into(), "Claude".into()],
                committed_at: "2026-10-28T07:00:00Z".into(),
            }]
        );
        assert_eq!(pr.review_decision.as_deref(), Some("CHANGES_REQUESTED"));
        assert_eq!(
            pr.checks,
            [PrCheck {
                name: "lint".into(),
                state: "skipped".into(),
                url: Some("https://ci.example/1".into())
            }]
        );
        assert_eq!(pr.reviews[0].author, "hubot");
        assert_eq!(pr.comments[0].id, "IC_1");
        assert_eq!(pr.review_comments.len(), 2);
        assert_eq!(pr.review_comments[1].id, 102);
        assert_eq!(pr.review_comments[1].line, None, "outdated");
        assert_eq!(
            (pr.mergeable.as_str(), pr.merge_state.as_str()),
            ("CONFLICTING", "DIRTY")
        );
        assert_eq!(
            pr.review_requests,
            [
                PrReviewer {
                    id: "dung".into(),
                    team: false
                },
                PrReviewer {
                    id: "octo/team-phoenix".into(),
                    team: true
                }
            ]
        );
    }

    #[test]
    fn a_commit_of_the_pull_request_is_read_as_a_diff_from_github() {
        let fake = Fake::new();
        let diff = "diff --git a/a.txt b/a.txt\nindex 1111111..2222222 100644\n\
            --- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-1\n+2\n";
        fake.answer("api -H", diff, "", 0);
        let (_dir, repo) = github_repo();
        let files = repo.github_commit_files(&fake.gh(), "945dddc").unwrap();

        assert_eq!(
            fake.calls()[0],
            [
                "api",
                "-H",
                "Accept: application/vnd.github.diff",
                "repos/octo/hello/commits/945dddc"
            ]
        );
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "a.txt");
        assert!(repo
            .github_commit_files(&fake.gh(), "945dddc/../x")
            .is_err());
        assert_eq!(fake.calls().len(), 1, "a bad id never reaches gh");
    }

    #[test]
    fn the_pr_diff_reads_into_file_diffs() {
        let fake = Fake::new();
        let diff = "diff --git a/src/a.rs b/src/a.rs\nindex 1111111..2222222 100644\n\
            --- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,3 +1,3 @@\n fn a() {\n-    1\n+    2\n }\n\
            diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..3333333\n\
            --- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n\
            diff --git a/old.txt b/renamed.txt\nsimilarity index 100%\nrename from old.txt\nrename to renamed.txt\n";
        fake.answer("pr diff", diff, "", 0);
        let (_dir, repo) = github_repo();
        let files = repo.pull_request_files(&fake.gh(), 7).unwrap();
        assert_eq!(
            fake.calls(),
            [[
                "pr",
                "diff",
                "7",
                "--repo",
                "octo/hello",
                "--color",
                "never"
            ]]
        );
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "src/a.rs");
        let lines: Vec<(char, Option<u32>, Option<u32>)> = files[0].hunks[0]
            .lines
            .iter()
            .map(|l| (l.origin, l.old_lineno, l.new_lineno))
            .collect();
        assert_eq!(
            lines,
            [
                (' ', Some(1), Some(1)),
                ('-', Some(2), None),
                ('+', None, Some(2)),
                (' ', Some(3), Some(3))
            ]
        );
        assert_eq!(files[1].status, crate::ChangeKind::Added);
        assert_eq!(files[1].hunks[0].lines[0].content, "hello");
        assert_eq!(files[2].status, crate::ChangeKind::Renamed);
        assert_eq!(files[2].old_path.as_deref(), Some("old.txt"));

        assert!(parse_pr_diff(b"\n", TextEncoding::Utf8).unwrap().is_empty());
    }

    #[test]
    fn failures_say_what_to_do() {
        let fake = Fake::new();
        let (_dir, repo) = github_repo();
        let gh = fake.gh();

        fake.answer(
            "pr list",
            "",
            "To get started with GitHub CLI, please run:  gh auth login\n",
            4,
        );
        assert_eq!(
            message(repo.pull_requests(&gh, PrFilter::All).unwrap_err()),
            NOT_SIGNED_IN
        );

        fake.answer(
            "pr list",
            "",
            "HTTP 401: Bad credentials (https://api.github.com/graphql)\n",
            1,
        );
        assert_eq!(
            message(repo.pull_requests(&gh, PrFilter::All).unwrap_err()),
            NOT_SIGNED_IN
        );

        fake.answer(
            "pr list",
            "",
            "GraphQL: API rate limit exceeded for user ID 1.\n",
            1,
        );
        assert!(
            message(repo.pull_requests(&gh, PrFilter::All).unwrap_err()).starts_with(RATE_LIMITED)
        );

        fake.answer(
            "pr list",
            "",
            "GraphQL: Could not resolve to a Repository with the name 'octo/hello'. (repository)\n",
            1,
        );
        let msg = message(repo.pull_requests(&gh, PrFilter::All).unwrap_err());
        assert!(
            msg.starts_with("GitHub has no repository octo/hello"),
            "{msg}"
        );

        fake.answer("pr list", "", "something else broke\n", 1);
        assert_eq!(
            message(repo.pull_requests(&gh, PrFilter::All).unwrap_err()),
            "something else broke"
        );

        fake.answer("pr list", "not json", "", 0);
        assert!(message(repo.pull_requests(&gh, PrFilter::All).unwrap_err())
            .starts_with("couldn't read gh's answer"));
    }

    #[test]
    fn without_gh_installed_every_call_says_how_to_install_it() {
        let empty = tempfile::tempdir().unwrap();
        let gh = Gh::with_search_path(empty.path());
        assert!(!gh.installed());
        assert_eq!(gh.account().unwrap(), GhAccount::default());
        let (_dir, repo) = github_repo();
        let msg = message(repo.pull_requests(&gh, PrFilter::All).unwrap_err());
        assert_eq!(msg, NOT_INSTALLED);
        assert!(msg.contains("brew install gh"));
    }

    #[test]
    fn a_gh_that_hangs_is_stopped_at_its_timeout_or_on_cancel() {
        let fake = Fake::with_script("#!/bin/sh\nexec sleep 30\n");
        let gh = fake.gh();
        let started = Instant::now();
        let err = gh
            .run(
                None,
                &["pr", "list"],
                None,
                Duration::from_millis(200),
                None,
            )
            .err()
            .unwrap();
        assert!(message(err).contains("didn't finish"));
        let cancel = AtomicBool::new(true);
        let err = gh
            .run(None, &["pr", "list"], None, TIMEOUT, Some(&cancel))
            .err()
            .unwrap();
        assert!(matches!(err, Error::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    fn new_pr(title: &str) -> NewPullRequest {
        NewPullRequest {
            branch: "feat".into(),
            remote: "origin".into(),
            base: "main".into(),
            title: title.into(),
            body: "--repo evil/repo\n$(touch pwned)".into(),
            draft: true,
        }
    }

    #[test]
    fn creating_a_pull_request_keeps_the_text_out_of_the_options_and_returns_its_number() {
        let fake = Fake::new();
        fake.answer(
            "pr create",
            "https://github.com/octo/hello/pull/57\n",
            "",
            0,
        );
        let (_dir, repo) = github_repo();
        let number = repo
            .create_pull_request(&fake.gh(), &new_pr("--draft=false Fix it"))
            .unwrap();
        assert_eq!(number, 57);
        assert_eq!(
            fake.calls(),
            [[
                "pr",
                "create",
                "--repo",
                "octo/hello",
                "--head=feat",
                "--base=main",
                "--title=--draft=false Fix it",
                "--body-file",
                "-",
                "--draft"
            ]]
        );
        assert_eq!(fake.read("stdin"), "--repo evil/repo\n$(touch pwned)");
    }

    #[test]
    fn a_branch_pushed_to_a_fork_is_named_with_the_fork_owner() {
        let fake = Fake::new();
        fake.answer(
            "pr create",
            "https://github.com/octo/hello/pull/58\n",
            "",
            0,
        );
        let (_dir, repo) = repo_with(&[
            ("origin", "git@github.com:me/hello.git"),
            ("upstream", "https://github.com/octo/hello.git"),
        ]);
        let mut pr = new_pr("Fix");
        pr.draft = false;
        assert_eq!(repo.create_pull_request(&fake.gh(), &pr).unwrap(), 58);
        let args = &fake.calls()[0];
        assert_eq!(args[2..5], ["--repo", "octo/hello", "--head=me:feat"]);
        assert!(!args.contains(&"--draft".to_string()));
    }

    #[test]
    fn a_pull_request_without_a_title_is_refused_before_gh_runs() {
        let fake = Fake::new();
        let (_dir, repo) = github_repo();
        let err = repo
            .create_pull_request(&fake.gh(), &new_pr("  "))
            .unwrap_err();
        assert!(message(err).contains("title"));
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn the_repository_settings_say_which_merges_github_allows() {
        let fake = Fake::new();
        fake.answer(
            "repo view",
            r#"{"defaultBranchRef": {"name": "master"}, "mergeCommitAllowed": false,
                "squashMergeAllowed": true, "rebaseMergeAllowed": true, "deleteBranchOnMerge": true}"#,
            "",
            0,
        );
        let (_dir, repo) = github_repo();
        let settings = repo.github_repo_settings(&fake.gh()).unwrap();
        assert_eq!(
            settings,
            GitHubRepoSettings {
                default_branch: "master".into(),
                merge_commit: false,
                squash: true,
                rebase: true,
                delete_branch_on_merge: true,
            }
        );
        assert_eq!(fake.calls()[0][..3], ["repo", "view", "octo/hello"]);
    }

    #[test]
    fn merging_names_the_method_and_deletes_the_branch_on_github_only() {
        let fake = Fake::new();
        fake.answer(
            "pr merge",
            "",
            "✓ Squashed and merged pull request #57\n",
            0,
        );
        let (_dir, repo) = github_repo();
        let gh = fake.gh();
        let said = repo
            .merge_pull_request(&gh, 57, MergeMethod::Squash, true)
            .unwrap();
        assert_eq!(said, "✓ Squashed and merged pull request #57");
        repo.merge_pull_request(&gh, 57, MergeMethod::Merge, false)
            .unwrap();
        repo.merge_pull_request(&gh, 57, MergeMethod::Rebase, false)
            .unwrap();
        // With --repo, gh deletes the branch on GitHub and leaves the local one.
        assert_eq!(
            fake.calls(),
            [
                vec![
                    "pr",
                    "merge",
                    "57",
                    "--repo",
                    "octo/hello",
                    "--squash",
                    "--delete-branch"
                ],
                vec!["pr", "merge", "57", "--repo", "octo/hello", "--merge"],
                vec!["pr", "merge", "57", "--repo", "octo/hello", "--rebase"],
            ]
        );
    }

    /// A repository whose `feat` branch has `messages` on top of
    /// `origin/main`.
    fn branch_with(branch: &str, messages: &[&str]) -> (tempfile::TempDir, Repo) {
        let (dir, repo) = github_repo();
        {
            let git = &repo.inner;
            let base = git.head().unwrap().peel_to_commit().unwrap();
            git.reference("refs/remotes/origin/main", base.id(), true, "test")
                .unwrap();
            let sig = git2::Signature::now("T", "t@example.com").unwrap();
            let mut parent = base;
            for message in messages {
                let tree = parent.tree().unwrap();
                let id = git
                    .commit(None, &sig, &sig, message, &tree, &[&parent])
                    .unwrap();
                parent = git.find_commit(id).unwrap();
            }
            git.branch(branch, &parent, true).unwrap();
        }
        (dir, repo)
    }

    #[test]
    fn one_commit_gives_the_draft_its_message() {
        let (_dir, repo) = branch_with("feat", &["Fix the retry\n\nIt gave up too soon."]);
        let draft = repo.pull_request_draft("feat", "main").unwrap();
        assert_eq!(draft.title, "Fix the retry");
        assert_eq!(draft.body, "It gave up too soon.");
    }

    #[test]
    fn several_commits_give_the_branch_name_and_a_list() {
        let (_dir, repo) = branch_with(
            "feature/UBIID-8520-delete-old-data",
            &["Add the purge job", "Test it"],
        );
        let draft = repo
            .pull_request_draft("feature/UBIID-8520-delete-old-data", "main")
            .unwrap();
        assert_eq!(draft.title, "UBIID-8520 Delete old data");
        assert_eq!(draft.body, "- Add the purge job\n- Test it");
    }

    #[test]
    fn the_repository_s_template_is_the_draft_s_description() {
        let (dir, repo) = branch_with("fix_login", &["a", "b"]);
        fs::create_dir_all(dir.path().join(".github")).unwrap();
        fs::write(
            dir.path().join(".github/pull_request_template.md"),
            "## Why\n\n## How\n",
        )
        .unwrap();
        let draft = repo.pull_request_draft("fix_login", "main").unwrap();
        assert_eq!(draft.title, "Fix login");
        assert_eq!(draft.body, "## Why\n\n## How\n");
    }

    #[test]
    fn a_base_not_fetched_yet_still_gives_a_title() {
        let (_dir, repo) = branch_with("fix-it", &["a"]);
        let draft = repo.pull_request_draft("fix-it", "develop").unwrap();
        assert_eq!(draft.title, "Fix it");
        assert_eq!(draft.body, "");
    }

    #[test]
    fn checking_out_runs_gh_pr_checkout_in_the_working_tree() {
        let fake = Fake::new();
        fake.answer("pr checkout", "", "Switched to a new branch 'fix'\n", 0);
        let (dir, repo) = github_repo();
        let out = repo.checkout_pull_request(&fake.gh(), 7).unwrap();
        assert_eq!(out, "Switched to a new branch 'fix'");
        assert_eq!(
            fake.calls(),
            [["pr", "checkout", "7", "--repo", "octo/hello"]]
        );
        assert_eq!(
            fake.read("cwd").trim(),
            dir.path().canonicalize().unwrap().to_str().unwrap()
        );
    }

    #[test]
    fn a_worktree_checkout_runs_gh_in_the_new_worktree_and_cleans_up_on_failure() {
        let fake = Fake::new();
        let (dir, repo) = github_repo();
        let gh = fake.gh();
        let wt = dir.path().join("..").join(format!(
            "{}-pr7",
            dir.path().file_name().unwrap().to_str().unwrap()
        ));
        let wt = wt.to_str().unwrap();

        fake.answer("pr checkout", "", "", 0);
        let full = repo.checkout_pull_request_in_worktree(&gh, 7, wt).unwrap();
        assert!(full.is_dir());
        assert_eq!(fake.read("cwd").trim(), full.to_str().unwrap());
        assert_eq!(
            fake.calls(),
            [["pr", "checkout", "7", "--repo", "octo/hello"]]
        );
        repo.remove_worktree(&full, true).unwrap();

        fake.answer("pr checkout", "", "fatal: couldn't find remote ref\n", 1);
        let err = repo
            .checkout_pull_request_in_worktree(&gh, 7, wt)
            .unwrap_err();
        assert!(message(err).contains("couldn't find remote ref"));
        assert!(!Path::new(wt).exists(), "the half-made worktree is removed");
        assert_eq!(repo.worktrees().unwrap().len(), 1);
    }

    #[test]
    fn auth_status_reads_the_active_account_in_either_format() {
        let new = "github.com\n  ✓ Logged in to github.com account work-me (keyring)\n  - Active account: false\n  \
            - Token scopes: 'repo'\n\n  ✓ Logged in to github.com account octocat (keyring)\n  \
            - Active account: true\n  - Git operations protocol: https\n  - Token: gho_************\n  \
            - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n";
        let account = parse_auth_status(new);
        assert!(account.signed_in);
        assert_eq!(account.login.as_deref(), Some("octocat"));
        assert_eq!(account.scopes, ["gist", "read:org", "repo", "workflow"]);

        let old = "github.com\n  ✓ Logged in to github.com as hubot (/Users/x/.config/gh/hosts.yml)\n  \
            ✓ Git operations for github.com configured to use https protocol.\n  ✓ Token: gho_****\n  \
            ✓ Token scopes: gist, read:org, repo\n";
        let account = parse_auth_status(old);
        assert_eq!(account.login.as_deref(), Some("hubot"));
        assert_eq!(account.scopes, ["gist", "read:org", "repo"]);

        let out = parse_auth_status(
            "You are not logged into any GitHub hosts. To log in, run: gh auth login\n",
        );
        assert_eq!(out, GhAccount::default());

        let expired = parse_auth_status(
            "github.com\n  X Failed to log in to github.com account octocat (keyring)\n  \
             - The token in keyring is invalid.\n",
        );
        assert!(!expired.signed_in);
        assert!(expired.message.unwrap().contains("Failed to log in"));
    }

    #[test]
    fn account_runs_auth_status_and_takes_a_signed_out_exit_as_an_answer() {
        let fake = Fake::new();
        fake.answer(
            "auth status",
            "",
            "You are not logged into any GitHub hosts.\n",
            1,
        );
        let account = fake.gh().account().unwrap();
        assert!(account.installed);
        assert!(!account.signed_in);
        assert_eq!(
            fake.calls(),
            [["auth", "status", "--hostname", "github.com"]]
        );

        fake.answer(
            "auth status",
            "github.com\n  ✓ Logged in to github.com account octocat (keyring)\n",
            "",
            0,
        );
        assert_eq!(
            fake.gh().account().unwrap().login.as_deref(),
            Some("octocat")
        );
    }

    /// A fake `gh auth login`: the device-flow lines gh prints without a
    /// terminal, then `then`.
    fn login_script(then: &str) -> String {
        format!(
            "#!/bin/sh\nd=\"$(dirname \"$0\")\"\n(IFS=\"$(printf '\\t')\"; printf '%s\\n' \"$*\") >> \"$d/argv\"\n\
             echo $$ > \"$d/pid\"\n\
             echo '! First copy your one-time code: ABCD-1234' >&2\n\
             echo 'Open this URL to continue in your web browser: https://github.com/login/device' >&2\n{then}\n"
        )
    }

    #[test]
    fn signing_in_shows_the_code_then_waits_for_gh_to_finish() {
        let fake = Fake::with_script(&login_script(
            "sleep 0.3\necho '✓ Authentication complete.' >&2\necho '✓ Logged in as octocat' >&2",
        ));
        let login = fake.gh().start_login().unwrap();
        assert_eq!(login.code(), "ABCD-1234");
        assert_eq!(login.url(), "https://github.com/login/device");
        assert_eq!(
            fake.calls(),
            [[
                "auth",
                "login",
                "--hostname",
                "github.com",
                "--web",
                "--git-protocol",
                "https"
            ]]
        );
        assert_eq!(
            login.wait(Duration::from_secs(10)).unwrap(),
            "✓ Logged in as octocat"
        );
    }

    #[test]
    fn cancelling_a_sign_in_kills_gh() {
        let fake = Fake::with_script(&login_script("exec sleep 30"));
        let login = fake.gh().start_login().unwrap();
        let pid: i32 = fake.read("pid").trim().parse().unwrap();
        login.cancel_flag().store(true, Ordering::SeqCst);
        let started = Instant::now();
        assert!(matches!(login.wait(LOGIN_TIMEOUT), Err(Error::Cancelled)));
        assert!(started.elapsed() < Duration::from_secs(5));
        // SAFETY: signal 0 only asks whether the process exists.
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "gh is gone");
    }

    #[test]
    fn a_sign_in_nobody_approves_times_out() {
        let fake = Fake::with_script(&login_script("exec sleep 30"));
        let login = fake.gh().start_login().unwrap();
        let err = login.wait(Duration::from_millis(300)).unwrap_err();
        assert!(message(err).contains("wasn't approved"));
    }

    #[test]
    fn a_sign_in_gh_refuses_reports_why() {
        let fake =
            Fake::with_script("#!/bin/sh\necho 'error connecting to github.com' >&2\nexit 1\n");
        let err = fake.gh().start_login().err().unwrap();
        assert_eq!(message(err), "error connecting to github.com");
    }

    #[test]
    fn device_lines_parse() {
        assert_eq!(
            device_code("! First copy your one-time code: 1A2B-3C4D").as_deref(),
            Some("1A2B-3C4D")
        );
        assert_eq!(
            device_code("Press Enter to open github.com in your browser..."),
            None
        );
        assert_eq!(
            device_url(
                "Open this URL to continue in your web browser: https://github.com/login/device"
            )
            .as_deref(),
            Some("https://github.com/login/device")
        );
    }
}
