//! The activity log: every git command gitp runs for a repository — what ran,
//! when, for how long, how it ended, and the tail of what it printed — so a
//! failed hook, a rejected push or a slow fetch can still be looked at after
//! its toast is gone.
//!
//! Held in memory only: a bounded ring per repository, keyed by the directory
//! git ran in (the working tree). Recording sits on every git spawn, so it
//! stays cheap — the argv is formatted once, and only the last few KB of
//! output is decoded; a successful command's stdout (its result, possibly
//! megabytes of log or diff) isn't kept at all.

use std::borrow::Cow;
use std::collections::{HashMap, VecDeque};
use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::repo::Repo;

/// Entries kept per repository; the oldest go first.
const ACTIVITY_LIMIT: usize = 500;

/// Bytes kept of each output stream — the end, where git puts its verdict.
const OUTPUT_TAIL: usize = 4096;

/// One git command gitp ran.
#[derive(Debug, Clone, Serialize)]
pub struct ActivityEntry {
    /// Increasing across all repositories, so a caller can ask for just what
    /// is newer than the last entry it has (see [`Repo::activity_log`]).
    pub id: u64,
    /// When git was started, milliseconds since the epoch.
    pub started_at: i64,
    pub duration_ms: u64,
    /// `git` and its arguments, with credentials masked.
    pub command: String,
    /// `None` when git couldn't be started, or was stopped by a signal (Cancel).
    pub exit_code: Option<i32>,
    pub success: bool,
    /// A read-only probe (status, log, rev-parse, …) of the kind every refresh
    /// runs — there to look at, but hidden by default so the operations the
    /// user started aren't buried.
    pub quiet: bool,
    /// The last few KB of stderr, which is where hooks and errors print.
    pub stderr: String,
    /// The last few KB of stdout — kept for a failure only (a pre-commit hook
    /// may print there).
    pub stdout: String,
}

type Log = HashMap<PathBuf, VecDeque<ActivityEntry>>;

fn log() -> &'static Mutex<Log> {
    static LOG: OnceLock<Mutex<Log>> = OnceLock::new();
    LOG.get_or_init(Default::default)
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// A git command that has been started and not yet recorded.
pub(crate) struct Run {
    key: PathBuf,
    command: String,
    quiet: bool,
    started_at: i64,
    started: Instant,
}

impl Run {
    /// Note the start of `git <args>`, to be logged under `key` (the working
    /// tree it runs for).
    pub(crate) fn start<'a>(key: &Path, args: impl IntoIterator<Item = &'a OsStr>) -> Self {
        let args: Vec<Cow<str>> = args.into_iter().map(OsStr::to_string_lossy).collect();
        let started_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64);
        Self {
            key: key.to_path_buf(),
            command: format_command(&args),
            quiet: is_quiet(&args),
            started_at,
            started: Instant::now(),
        }
    }

    /// Note the start of `cmd`, logged under the directory it runs in.
    pub(crate) fn of(cmd: &Command) -> Self {
        Self::start(
            cmd.get_current_dir().unwrap_or(Path::new("")),
            cmd.get_args(),
        )
    }

    /// Record how it ended. `stdout` is only kept for a failure.
    pub(crate) fn finish(
        self,
        exit_code: Option<i32>,
        success: bool,
        stdout: &[u8],
        stderr: &[u8],
    ) {
        let entry = ActivityEntry {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            started_at: self.started_at,
            duration_ms: self.started.elapsed().as_millis() as u64,
            command: self.command,
            exit_code,
            success,
            quiet: self.quiet,
            stderr: tail(stderr),
            stdout: if success { String::new() } else { tail(stdout) },
        };
        let Ok(mut log) = log().lock() else { return };
        let ring = log.entry(self.key).or_default();
        if ring.len() == ACTIVITY_LIMIT {
            ring.pop_front();
        }
        ring.push_back(entry);
    }

    /// Record how a command that ran to the end went.
    pub(crate) fn finish_output(self, out: &Output) {
        self.finish(
            out.status.code(),
            out.status.success(),
            &out.stdout,
            &out.stderr,
        );
    }

    /// Record a command that couldn't be run, or was stopped.
    pub(crate) fn fail(self, why: impl std::fmt::Display) {
        self.finish(None, false, b"", why.to_string().as_bytes());
    }

    /// Run `cmd` to the end (`Command::output`) and record it.
    pub(crate) fn output(self, cmd: &mut Command) -> io::Result<Output> {
        let output = cmd.output();
        match &output {
            Ok(out) => self.finish_output(out),
            Err(e) => self.fail(format_args!("failed to run git: {e}")),
        }
        output
    }
}

/// `cmd.output()`, recorded in the activity log of the directory it runs in.
/// Every git spawn that waits for its output goes through here.
pub(crate) fn output(cmd: &mut Command) -> io::Result<Output> {
    Run::of(cmd).output(cmd)
}

/// The key a repository that doesn't exist yet (`git init`, `git clone`) will
/// be logged under once opened. git2 reports a working tree by its real path,
/// so the folder it goes in is resolved (`/tmp` is `/private/tmp` on macOS).
pub(crate) fn key_for_new(path: &Path) -> PathBuf {
    match (path.parent().map(Path::canonicalize), path.file_name()) {
        (Some(Ok(parent)), Some(name)) => parent.join(name),
        _ => path.to_path_buf(),
    }
}

impl Repo {
    /// The git commands run for this repository, newest first — only those
    /// after entry `since` when given, for a view that polls.
    pub fn activity_log(&self, since: Option<u64>) -> Vec<ActivityEntry> {
        let (Some(key), Ok(log)) = (self.inner.workdir(), log().lock()) else {
            return Vec::new();
        };
        let Some(ring) = log.get(key) else {
            return Vec::new();
        };
        let since = since.unwrap_or(0);
        ring.iter()
            .rev()
            .take_while(|e| e.id > since)
            .cloned()
            .collect()
    }

    /// Forget this repository's activity.
    pub fn clear_activity_log(&self) {
        if let (Some(key), Ok(mut log)) = (self.inner.workdir(), log().lock()) {
            log.remove(key);
        }
    }
}

/// The last [`OUTPUT_TAIL`] bytes of `bytes`, decoded and with credentials in
/// URLs masked. Cut mid-character, the first one decodes as U+FFFD.
fn tail(bytes: &[u8]) -> String {
    let bytes = &bytes[bytes.len().saturating_sub(OUTPUT_TAIL)..];
    let text = String::from_utf8_lossy(bytes);
    mask_userinfo(text.trim()).into_owned()
}

/// `git <args>` for display, credentials masked: the value of a `-c
/// credential.*` (or `http.extraHeader`, which carries tokens) setting, and the
/// user/password part of any URL. An argument with spaces is quoted.
fn format_command(args: &[Cow<str>]) -> String {
    let mut out = String::from("git");
    let mut after_c = false;
    for arg in args {
        let arg: Cow<str> = if after_c && is_secret_setting(arg) {
            let key = arg.split_once('=').map_or(arg.as_ref(), |(k, _)| k);
            Cow::Owned(format!("{key}=***"))
        } else {
            mask_userinfo(arg)
        };
        after_c = arg == "-c";
        out.push(' ');
        if arg.is_empty() || arg.contains(char::is_whitespace) {
            out.push('\'');
            out.push_str(&arg.replace('\'', r"'\''"));
            out.push('\'');
        } else {
            out.push_str(&arg);
        }
    }
    out
}

fn is_secret_setting(setting: &str) -> bool {
    let key = setting
        .split_once('=')
        .map_or(setting, |(k, _)| k)
        .to_ascii_lowercase();
    key.starts_with("credential.") || key.ends_with(".extraheader")
}

/// Replace the userinfo of every URL in `text` with `***`:
/// `https://user:token@host/x` → `https://***@host/x`.
fn mask_userinfo(text: &str) -> Cow<'_, str> {
    if !text.contains("://") {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        let (head, after) = rest.split_at(i + 3);
        out.push_str(head);
        // The authority ends at the path, or wherever the URL does in prose.
        let end = after
            .find(|c: char| c == '/' || c.is_whitespace() || c == '\'' || c == '"')
            .unwrap_or(after.len());
        match after[..end].rfind('@') {
            Some(at) => {
                out.push_str("***");
                rest = &after[at..];
            }
            None => rest = after,
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

/// Whether `git <args>` only reads — the probes a refresh or a view runs
/// constantly — as opposed to an operation that changes something or talks to
/// a remote.
fn is_quiet(args: &[Cow<str>]) -> bool {
    // Skip git's own options (`-c key=value`, `-C dir`, `--no-pager`).
    let mut i = 0;
    while i < args.len() && args[i].starts_with('-') {
        i += if args[i] == "-c" || args[i] == "-C" {
            2
        } else {
            1
        };
    }
    let Some(sub) = args.get(i) else { return false };
    let rest = &args[(i + 1).min(args.len())..];
    let next = rest.first().map(Cow::as_ref);
    match sub.as_ref() {
        "status" | "log" | "show" | "diff" | "rev-parse" | "rev-list" | "for-each-ref"
        | "cat-file" | "ls-files" | "ls-tree" | "merge-base" | "blame" | "describe"
        | "show-ref" | "symbolic-ref" | "name-rev" | "check-ignore" | "format-patch" | "var"
        | "version" => true,
        "stash" => matches!(next, Some("list" | "show")),
        "worktree" => next == Some("list"),
        "submodule" => next == Some("status"),
        // Asked on every refresh, to tell whether git-lfs is installed.
        "lfs" => next == Some("version"),
        // `config <key>` and `config --get <key>` read; anything with a value
        // or an `--unset`/`--add` writes.
        "config" => {
            let positional = rest.iter().filter(|a| !a.starts_with('-')).count();
            let writes = rest.iter().any(|a| {
                a.starts_with("--unset")
                    || a.starts_with("--add")
                    || a.starts_with("--replace")
                    || a.ends_with("-section")
            });
            !writes && (positional <= 1 || rest.iter().any(|a| a.starts_with("--get")))
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<Cow<'static, str>> {
        list.iter().map(|a| Cow::Owned(a.to_string())).collect()
    }

    fn command(list: &[&str]) -> String {
        format_command(&args(list))
    }

    #[test]
    fn masks_credentials_in_urls() {
        assert_eq!(
            command(&["push", "https://user:s3cret@github.com/o/r.git", "main"]),
            "git push https://***@github.com/o/r.git main"
        );
        assert_eq!(
            command(&["clone", "--", "https://ghp_token@host/o/r", "/x"]),
            "git clone -- https://***@host/o/r /x"
        );
        // No userinfo, or no URL at all: unchanged.
        assert_eq!(
            command(&["fetch", "https://github.com/o/r", "git@github.com:o/r.git"]),
            "git fetch https://github.com/o/r git@github.com:o/r.git"
        );
    }

    #[test]
    fn masks_credential_settings() {
        assert_eq!(
            command(&[
                "-c",
                "credential.helper=!f() { echo password=hunter2; }; f",
                "fetch"
            ]),
            "git -c credential.helper=*** fetch"
        );
        assert_eq!(
            command(&["-c", "http.extraHeader=Authorization: Bearer abc", "push"]),
            "git -c http.extraHeader=*** push"
        );
        // Other settings are shown as they are.
        assert_eq!(
            command(&["-c", "log.follow=false", "log"]),
            "git -c log.follow=false log"
        );
    }

    #[test]
    fn masks_credentials_in_output() {
        assert_eq!(
            tail(b"fatal: unable to access 'https://me:tok@host/r/': 403\n"),
            "fatal: unable to access 'https://***@host/r/': 403"
        );
    }

    #[test]
    fn quotes_arguments_with_spaces() {
        assert_eq!(
            command(&["commit", "-m", "fix: it's done", ""]),
            r"git commit -m 'fix: it'\''s done' ''"
        );
    }

    #[test]
    fn output_keeps_only_the_tail() {
        let long = format!("{}END", "x".repeat(10_000));
        let kept = tail(long.as_bytes());
        assert_eq!(kept.len(), OUTPUT_TAIL);
        assert!(kept.ends_with("END"));
    }

    #[test]
    fn read_only_probes_are_quiet() {
        for probe in [
            &["status", "--porcelain=v2", "-z"][..],
            &[
                "-c",
                "log.follow=false",
                "-c",
                "log.showSignature=false",
                "log",
                "-1",
            ],
            &["rev-parse", "--abbrev-ref", "main@{upstream}"],
            &["diff", "--name-only", "--diff-filter=U"],
            &["stash", "list", "--format=%H"],
            &["worktree", "list", "--porcelain", "-z"],
            &["config", "--get", "user.name"],
            &["config", "branch.main.remote"],
            &["lfs", "version"],
        ] {
            assert!(is_quiet(&args(probe)), "{probe:?} should be quiet");
        }
        for op in [
            &["commit", "-F", "-"][..],
            &["fetch", "--progress", "--all", "--prune"],
            &["stash", "push", "-u"],
            &["stash", "pop"],
            &["worktree", "add", "../x"],
            &["config", "user.name", "Someone"],
            &["config", "--unset", "user.name"],
            &["ls-remote", "--heads", "origin"],
            &["-c", "lfs.forceprogress=true", "lfs", "pull"],
            &[],
        ] {
            assert!(!is_quiet(&args(op)), "{op:?} should not be quiet");
        }
    }

    #[test]
    fn the_ring_is_bounded_and_drops_the_oldest() {
        let key = Path::new("/nonexistent/activity-ring-test");
        for i in 0..ACTIVITY_LIMIT + 20 {
            let n = i.to_string();
            Run::start(key, [OsStr::new("tag"), OsStr::new(&n)]).finish(Some(0), true, b"", b"");
        }
        let log = log().lock().unwrap();
        let ring = &log[key];
        assert_eq!(ring.len(), ACTIVITY_LIMIT);
        assert_eq!(ring.front().unwrap().command, "git tag 20");
        assert_eq!(
            ring.back().unwrap().command,
            format!("git tag {}", ACTIVITY_LIMIT + 19)
        );
    }
}
