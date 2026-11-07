//! Drafts written by a command (Claude Code by default): a commit message
//! from what is staged, and a pull request's title and description from a
//! branch's commits. The command runs in the working directory with its
//! input on stdin; Cancel stops it like a fetch, and it gets
//! [`DRAFT_TIMEOUT`]. Nothing is committed or created here.

use std::time::Duration;

use serde::Serialize;

use crate::branch_review::{git_raw, DIFF};
use crate::error::{Error, Result};
use crate::gh::{claude_answer, git_in, run_shell};
use crate::pr_threads::now_millis;
use crate::repo::Repo;

/// How long a draft may take before it is stopped.
pub const DRAFT_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// How much of a diff a draft command gets on stdin.
pub const DRAFT_DIFF_LIMIT: usize = 400 * 1024;

/// How many characters of a commit message are kept.
pub const COMMIT_MESSAGE_LIMIT: usize = 2000;

/// A commit message: its first line, and the rest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommitDraft {
    pub subject: String,
    pub body: String,
}

impl Repo {
    /// Run the commit message `command` over what will be committed: the
    /// staged diff, or with `amend` HEAD's changes plus the staged ones. The
    /// diff is on stdin; `GITP_BRANCH` is set, and `GITP_LOG_FILE` names a
    /// file with the branch's last 20 subjects, newest first. Its answer's
    /// first line is the subject, the rest the body.
    pub fn draft_commit_message(&self, command: &str, amend: bool) -> Result<CommitDraft> {
        let command = required(command, "commit message")?;
        let dir = self.workdir();
        let mut args = DIFF.to_vec();
        args.push("--cached");
        let from;
        if amend {
            // What the amended commit will hold: HEAD's parent (or nothing,
            // for a root commit) against the index.
            from = match git_in(dir, &["rev-parse", "--verify", "-q", "HEAD^"]) {
                Ok(parent) => parent,
                Err(_) => git_in(dir, &["hash-object", "-t", "tree", "/dev/null"])?,
            };
            args.push(&from);
        }
        args.push("--");
        let diff = String::from_utf8_lossy(&git_raw(dir, &args)?).into_owned();
        if diff.trim().is_empty() {
            return Err(Error::Message("Stage something first.".into()));
        }
        let subjects = git_in(dir, &["log", "-20", "--format=%s"]).unwrap_or_default();
        let log = std::env::temp_dir().join(format!(
            "gitp-log-{}-{}.txt",
            std::process::id(),
            now_millis()
        ));
        std::fs::write(&log, format!("{subjects}\n"))
            .map_err(|e| Error::Message(format!("can't write {}: {e}", log.display())))?;
        let branch = git_in(dir, &["symbolic-ref", "--short", "-q", "HEAD"]).unwrap_or_else(|_| "HEAD".into());
        let env = [
            ("GITP_BRANCH", branch),
            ("GITP_LOG_FILE", log.to_string_lossy().into_owned()),
        ];
        let input = cut_diff(&diff, DRAFT_DIFF_LIMIT);
        let out = run_shell(dir, command, input.as_bytes(), &env, DRAFT_TIMEOUT, &self.net);
        let _ = std::fs::remove_file(&log);
        let out = out.map_err(|e| renamed(e, "The commit message command"))?;
        commit_draft_from(&draft_text(&out.stdout)?)
    }
}

/// The command, or the error that asks for one.
fn required<'a>(command: &'a str, what: &str) -> Result<&'a str> {
    let command = command.trim();
    if command.is_empty() {
        Err(Error::Message(format!("Set a {what} command in Settings → Git first.")))
    } else {
        Ok(command)
    }
}

/// `run_shell` speaks of "the review command"; a draft names its own.
fn renamed(e: Error, what: &str) -> Error {
    const REVIEW: &str = "The review command";
    match e {
        Error::Message(m) if m.starts_with(REVIEW) => Error::Message(format!("{what}{}", &m[REVIEW.len()..])),
        other => other,
    }
}

/// What the command answered: Claude's result when it printed
/// `--output-format json` (its error as the error), else what it printed.
fn draft_text(stdout: &str) -> Result<String> {
    Ok(claude_answer(stdout)?.0.trim().to_string())
}

/// A commit message from an answer: trailing whitespace off every line, at
/// most [`COMMIT_MESSAGE_LIMIT`] characters, the first line the subject.
fn commit_draft_from(text: &str) -> Result<CommitDraft> {
    let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    let text = lines.join("\n");
    let text = text.trim();
    if text.is_empty() {
        return Err(Error::Message("Claude wrote no commit message.".into()));
    }
    let text: String = text.chars().take(COMMIT_MESSAGE_LIMIT).collect();
    let (subject, body) = text.split_once('\n').unwrap_or((&text, ""));
    Ok(CommitDraft {
        subject: subject.trim().to_string(),
        body: body.trim_start_matches('\n').trim_end().to_string(),
    })
}

/// `text` cut to at most `limit` bytes at a line end, with a note of what
/// was left out.
fn cut_diff(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let end = text.as_bytes()[..limit]
        .iter()
        .rposition(|&b| b == b'\n')
        .map_or(0, |i| i + 1);
    format!(
        "{}[gitp: the diff was cut at {} KB; {} KB more not shown]\n",
        &text[..end],
        limit / 1024,
        (text.len() - end).div_ceil(1024)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::progress::NetworkHooks;
    use std::path::Path;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn commit(dir: &Path, file: &str, text: &str, subject: &str) {
        std::fs::write(dir.join(file), text).unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-qm", subject]);
    }

    /// `main` with two commits: "one" then "two".
    fn repo() -> (tempfile::TempDir, Repo) {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        git(d, &["init", "-q", "-b", "main"]);
        commit(d, "a.txt", "a\n", "one");
        commit(d, "b.txt", "b\n", "two");
        let repo = Repo::open(d).unwrap();
        (dir, repo)
    }

    fn message(e: Error) -> String {
        match e {
            Error::Message(m) => m,
            other => other.to_string(),
        }
    }

    #[test]
    fn a_commit_draft_reads_the_staged_diff_and_the_log() {
        let (dir, repo) = repo();
        std::fs::write(dir.path().join("a.txt"), "a\nnew\n").unwrap();
        git(dir.path(), &["add", "a.txt"]);
        let seen = dir.path().join("seen.txt");
        let cmd = format!(
            r#"{{ echo "$GITP_BRANCH|$GITP_LOG_FILE"; cat "$GITP_LOG_FILE"; cat; }} > {}; printf 'feat: x\n\nwhy  \n\n'"#,
            seen.display()
        );
        let draft = repo.draft_commit_message(&cmd, false).unwrap();
        assert_eq!(draft, CommitDraft { subject: "feat: x".into(), body: "why".into() });
        let seen = std::fs::read_to_string(&seen).unwrap();
        let mut lines = seen.lines();
        let (branch, log) = lines.next().unwrap().split_once('|').unwrap();
        assert_eq!(branch, "main");
        assert!(!Path::new(log).exists(), "the log file is removed");
        assert_eq!(lines.next(), Some("two"));
        assert_eq!(lines.next(), Some("one"));
        assert!(seen.contains("+new"), "{seen}");
        assert!(!seen.contains("b.txt"), "only the staged change: {seen}");
    }

    #[test]
    fn nothing_staged_is_refused_without_running() {
        let (dir, repo) = repo();
        std::fs::write(dir.path().join("a.txt"), "unstaged\n").unwrap();
        let err = message(repo.draft_commit_message("touch ran.txt", false).unwrap_err());
        assert_eq!(err, "Stage something first.");
        assert!(!dir.path().join("ran.txt").exists());
    }

    #[test]
    fn an_amend_reads_heads_diff_and_the_staged_one() {
        let (dir, repo) = repo();
        std::fs::write(dir.path().join("c.txt"), "staged\n").unwrap();
        git(dir.path(), &["add", "c.txt"]);
        let draft = repo.draft_commit_message("cat >/dev/null; echo s", true).unwrap();
        assert_eq!(draft.subject, "s");
        let out = repo
            .draft_commit_message(r#"f=$(cat); echo "$f" | grep -c '^+++ b/' | tr -d ' '"#, true)
            .unwrap();
        assert_eq!(out.subject, "2", "b.txt from HEAD and the staged c.txt");
        // A root commit has no parent: its whole tree is the change.
        let root = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "-q", "-b", "main"]);
        commit(root.path(), "r.txt", "root\n", "root");
        let repo = Repo::open(root.path()).unwrap();
        let out = repo.draft_commit_message("grep -c '^+root' | tr -d ' '", true).unwrap();
        assert_eq!(out.subject, "1");
    }

    #[test]
    fn a_claude_json_answer_is_read_and_its_error_fails() {
        let (dir, repo) = repo();
        std::fs::write(dir.path().join("a.txt"), "x\n").unwrap();
        git(dir.path(), &["add", "a.txt"]);
        let ok = r#"cat >/dev/null; printf '%s\n' '{"type":"result","is_error":false,"result":"fix: y\n\nbecause"}'"#;
        assert_eq!(
            repo.draft_commit_message(ok, false).unwrap(),
            CommitDraft { subject: "fix: y".into(), body: "because".into() }
        );
        let bad = r#"cat >/dev/null; printf '%s\n' '{"type":"result","is_error":true,"result":"Credit balance is too low"}'"#;
        assert_eq!(message(repo.draft_commit_message(bad, false).unwrap_err()), "Credit balance is too low");
        let empty = "cat >/dev/null; echo '   '";
        assert!(message(repo.draft_commit_message(empty, false).unwrap_err()).contains("no commit message"));
    }

    #[test]
    fn a_long_message_is_cut_at_2000_characters() {
        let (dir, repo) = repo();
        std::fs::write(dir.path().join("a.txt"), "x\n").unwrap();
        git(dir.path(), &["add", "a.txt"]);
        let draft = repo
            .draft_commit_message("cat >/dev/null; printf 'é%.0s' $(seq 1 3000)", false)
            .unwrap();
        assert_eq!(draft.subject.chars().count(), COMMIT_MESSAGE_LIMIT);
        assert_eq!(draft.body, "");
    }

    #[test]
    fn a_large_diff_is_cut_with_a_note() {
        let line = "+ééééééééééééééééééééééééééééééééééééééé\n";
        let text = line.repeat(600 * 1024 / line.len());
        let cut = cut_diff(&text, DRAFT_DIFF_LIMIT);
        assert!(cut.len() <= DRAFT_DIFF_LIMIT + 200, "{}", cut.len());
        assert!(cut.trim_end().ends_with("not shown]"), "{}", &cut[cut.len() - 120..]);
        let body = &cut[..cut.find("\n[gitp:").unwrap() + 1];
        assert!(body.lines().all(|l| l == line.trim_end()), "cut at a line end");
        assert_eq!(cut_diff("small\n", DRAFT_DIFF_LIMIT), "small\n");
    }

    #[test]
    fn a_cancelled_draft_says_cancelled() {
        let (dir, mut repo) = repo();
        std::fs::write(dir.path().join("a.txt"), "x\n").unwrap();
        git(dir.path(), &["add", "a.txt"]);
        repo.set_network_hooks(NetworkHooks {
            cancel: Some(Arc::new(AtomicBool::new(true))),
            ..NetworkHooks::default()
        });
        let started = std::time::Instant::now();
        let err = repo.draft_commit_message("sleep 5", false).unwrap_err();
        assert!(matches!(err, Error::Cancelled), "{err}");
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[test]
    fn a_failing_command_names_the_commit_message_command() {
        let (dir, repo) = repo();
        std::fs::write(dir.path().join("a.txt"), "x\n").unwrap();
        git(dir.path(), &["add", "a.txt"]);
        let err = message(repo.draft_commit_message("cat >/dev/null; echo oops >&2; exit 3", false).unwrap_err());
        assert!(err.starts_with("The commit message command failed (exit code 3)."), "{err}");
        assert!(err.contains("oops"), "{err}");
    }
}
