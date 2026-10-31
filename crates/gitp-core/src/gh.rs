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

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::branch_ops::parse_remote_url;
use crate::diff::{collect_files, FileDiff, MAX_DIFF_LINES};
use crate::encoding::TextEncoding;
use crate::error::{Error, Result};
use crate::git_bin::spawn_path;
use crate::progress::kill;
use crate::repo::Repo;
use crate::worktree_ops::WorktreeTarget;

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

/// Which open pull requests the sidebar lists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrFilter {
    All,
    /// Opened by the signed-in user.
    Mine,
    /// Waiting on the signed-in user's review.
    ReviewRequested,
}

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
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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
    /// `RIGHT` for a line of the new file, `LEFT` for one of the old.
    pub side: String,
    pub created_at: String,
    /// The thread's first comment, for a reply.
    pub in_reply_to: Option<u64>,
    pub url: String,
    /// The diff around the line, ending with it.
    pub diff_hunk: String,
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
    pub comments: Vec<PrComment>,
    pub review_comments: Vec<PrReviewComment>,
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
    /// most 100).
    pub fn pull_requests(&self, gh: &Gh, filter: PrFilter) -> Result<Vec<PullRequest>> {
        let target = self.github_target()?;
        let repo = target.repo_arg();
        let mut args = vec![
            "pr",
            "list",
            "--repo",
            &repo,
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            LIST_FIELDS,
        ];
        match filter {
            PrFilter::All => {}
            PrFilter::Mine => args.extend(["--author", "@me"]),
            PrFilter::ReviewRequested => args.extend(["--search", "review-requested:@me"]),
        }
        let out = self.gh_call(gh, &target, &args, None, TIMEOUT)?;
        let raw: Vec<RawPr> = parse_json(&out.stdout)?;
        Ok(raw.into_iter().map(PullRequest::from).collect())
    }

    /// Pull request `number` with its checks, reviews and conversation: one
    /// `gh pr view`, and `gh api` for the comments on lines, which it leaves
    /// out.
    pub fn pull_request(&self, gh: &Gh, number: u64) -> Result<PullRequestDetail> {
        let target = self.github_target()?;
        let repo = target.repo_arg();
        let n = number.to_string();
        let out = self.gh_call(
            gh,
            &target,
            &["pr", "view", &n, "--repo", &repo, "--json", VIEW_FIELDS],
            None,
            TIMEOUT,
        )?;
        let raw: RawPrDetail = parse_json(&out.stdout)?;
        let endpoint = format!("repos/{}/pulls/{n}/comments?per_page=100", target.path);
        let mut args = Vec::new();
        target.api(&mut args);
        args.extend(["--paginate", &endpoint]);
        let out = self.gh_call(gh, &target, &args, None, TIMEOUT)?;
        let review_comments = parse_review_comments(&out.stdout)?;
        Ok(raw.into_detail(review_comments))
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
    /// return what it printed — a review in the shape the Drafts tab reads.
    ///
    /// The command is a shell line, run by a login shell so it finds the same
    /// programs a terminal would (`claude`, say). The diff arrives on its
    /// stdin; `GITP_PR_NUMBER`, `GITP_PR_REPO` and `GITP_PR_URL` are set. It
    /// gets [`REVIEW_TIMEOUT`], and Cancel stops it like a fetch.
    pub fn generate_review_drafts(&self, gh: &Gh, number: u64, command: &str) -> Result<String> {
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
        let out = run_shell(
            self.workdir(),
            command,
            diff.as_bytes(),
            &env,
            REVIEW_TIMEOUT,
            self.net.cancel.as_deref(),
        )?;
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
        Ok(out.stdout)
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

/// How long a review command may run: a model reading a big diff takes
/// minutes, not seconds.
pub const REVIEW_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Run shell line `command` in `dir` with `input` on stdin and `env` set,
/// waiting at most `timeout` and only until `cancel` goes up. Fails with the
/// command's stderr when it exits non-zero.
fn run_shell(
    dir: &Path,
    command: &str,
    input: &[u8],
    env: &[(&str, String)],
    timeout: Duration,
    cancel: Option<&AtomicBool>,
) -> Result<ShellOutput> {
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

struct ShellOutput {
    stdout: String,
    stderr: String,
}

const LIST_FIELDS: &str = "number,title,author,isDraft,reviewDecision,statusCheckRollup,\
     headRefName,baseRefName,updatedAt,url,labels";

const VIEW_FIELDS: &str = "number,title,body,state,isDraft,author,baseRefName,headRefName,\
     headRefOid,labels,url,createdAt,reviewDecision,statusCheckRollup,reviews,comments,\
     additions,deletions,changedFiles,mergeable,mergeStateStatus";

const REPO_SETTINGS_FIELDS: &str = "defaultBranchRef,mergeCommitAllowed,squashMergeAllowed,\
     rebaseMergeAllowed,deleteBranchOnMerge";

/// Where GitHub looks for a repository's pull request template.
const PR_TEMPLATES: [&str; 6] = [
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

/// `gh pr diff`'s unified diff as the same per-file hunks a commit's diff
/// has, read by libgit2's own patch parser.
fn parse_pr_diff(bytes: &[u8], enc: TextEncoding) -> Result<Vec<FileDiff>> {
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
    additions: u64,
    #[serde(default)]
    deletions: u64,
    #[serde(default)]
    changed_files: u64,
    #[serde(default)]
    mergeable: String,
    #[serde(default)]
    merge_state_status: String,
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
    fn into_detail(self, review_comments: Vec<PrReviewComment>) -> PullRequestDetail {
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
            additions: self.additions,
            deletions: self.deletions,
            changed_files: self.changed_files,
            mergeable: self.mergeable,
            merge_state: self.merge_state_status,
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

    struct Fake {
        bin: tempfile::TempDir,
    }

    impl Fake {
        fn new() -> Self {
            Self::with_script(FAKE_GH)
        }

        fn with_script(script: &str) -> Self {
            let bin = tempfile::tempdir().unwrap();
            let gh = bin.path().join("gh");
            fs::write(&gh, script).unwrap();
            fs::set_permissions(&gh, fs::Permissions::from_mode(0o755)).unwrap();
            Self { bin }
        }

        /// What `gh <command>` (its first two arguments) answers.
        fn answer(&self, command: &str, stdout: &str, stderr: &str, code: i32) -> &Self {
            let key = command.replace(' ', ".");
            let dir = self.bin.path();
            fs::write(dir.join(format!("out.{key}")), stdout).unwrap();
            fs::write(dir.join(format!("err.{key}")), stderr).unwrap();
            fs::write(dir.join(format!("code.{key}")), code.to_string()).unwrap();
            self
        }

        /// The fake first on PATH, then the real PATH for sh, git and sleep.
        fn gh(&self) -> Gh {
            let real = std::env::var_os("PATH").unwrap_or_default();
            let dirs =
                std::iter::once(self.bin.path().to_path_buf()).chain(std::env::split_paths(&real));
            Gh::with_search_path(std::env::join_paths(dirs).unwrap())
        }

        fn calls(&self) -> Vec<Vec<String>> {
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

    fn github_repo() -> (tempfile::TempDir, Repo) {
        repo_with(&[("origin", "git@github.com:octo/hello.git")])
    }

    fn message(err: Error) -> String {
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
       "statusCheckRollup": [
         {"__typename": "CheckRun", "name": "build", "status": "COMPLETED", "conclusion": "SUCCESS"},
         {"__typename": "StatusContext", "context": "ci/legacy", "state": "FAILURE"}]},
      {"number": 9, "title": "WIP", "author": null, "isDraft": true, "reviewDecision": "",
       "headRefName": "wip", "baseRefName": "main", "url": "https://github.com/octo/hello/pull/9",
       "labels": [], "statusCheckRollup": [
         {"__typename": "CheckRun", "name": "test", "status": "IN_PROGRESS", "conclusion": ""}]}
    ]"#;

    #[test]
    fn listing_names_the_repo_asks_for_json_and_reads_the_answer() {
        let fake = Fake::new();
        fake.answer("pr list", LIST_JSON, "", 0);
        let (_dir, repo) = github_repo();
        let prs = repo.pull_requests(&fake.gh(), PrFilter::Mine).unwrap();

        let calls = fake.calls();
        assert_eq!(calls.len(), 1);
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
        assert_eq!(prs[1].author, "ghost");
        assert!(prs[1].is_draft);
        assert_eq!(prs[1].review_decision, None);
        assert_eq!(prs[1].checks.as_deref(), Some("pending"));
    }

    #[test]
    fn review_requested_lists_by_search_and_all_adds_nothing() {
        let fake = Fake::new();
        fake.answer("pr list", "[]", "", 0);
        let (_dir, repo) = github_repo();
        repo.pull_requests(&fake.gh(), PrFilter::ReviewRequested)
            .unwrap();
        repo.pull_requests(&fake.gh(), PrFilter::All).unwrap();
        let calls = fake.calls();
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
            out,
            "7|octo/hello|https://github.com/octo/hello/pull/7|diff --git a/x b/x\n+hello\n"
        );
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
                "additions": 3, "deletions": 1, "changedFiles": 1,
                "mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY"}"#,
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

        let calls = fake.calls();
        assert_eq!(calls[0][..5], ["pr", "view", "7", "--repo", "octo/hello"]);
        assert_eq!(
            calls[1],
            [
                "api",
                "--paginate",
                "repos/octo/hello/pulls/7/comments?per_page=100"
            ]
        );
        assert_eq!(pr.head_oid, "abc123");
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
