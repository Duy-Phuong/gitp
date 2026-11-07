//! Drafts written by a command (Claude Code by default): a commit message
//! from what is staged, and a pull request's title and description from a
//! branch's commits. The command runs in the working directory with its
//! input on stdin; Cancel stops it like a fetch, and it gets
//! [`DRAFT_TIMEOUT`]. Nothing is committed or created here.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::branch_review::{git_raw, DIFF};
use crate::error::{Error, Result};
use crate::gh::{claude_answer, git_in, run_shell, PrDraft, PR_TEMPLATES};
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
        let branch = git_in(dir, &["symbolic-ref", "--short", "-q", "HEAD"])
            .unwrap_or_else(|_| "HEAD".into());
        let env = [
            ("GITP_BRANCH", branch),
            ("GITP_LOG_FILE", log.to_string_lossy().into_owned()),
        ];
        let input = cut_diff(&diff, DRAFT_DIFF_LIMIT);
        let out = run_shell(
            dir,
            command,
            input.as_bytes(),
            &env,
            DRAFT_TIMEOUT,
            &self.net,
        );
        let _ = std::fs::remove_file(&log);
        let out = out.map_err(|e| renamed(e, "The commit message command"))?;
        commit_draft_from(&draft_text(&out.stdout)?)
    }
}

impl Repo {
    /// Run the pull request draft `command` over `branch`'s commits not on
    /// `base` — the GitHub remote's `base` as last fetched, else the local
    /// one — and their diff from the fork point: the log, then the diff, on
    /// stdin. `GITP_BRANCH`, `GITP_BASE` and, when the repository has a pull
    /// request template, `GITP_PR_TEMPLATE_FILE` are set. Its answer is JSON
    /// with a title and a body, or plain text whose first line is the title.
    pub fn draft_pull_request(&self, command: &str, base: &str, branch: &str) -> Result<PrDraft> {
        let command = required(command, "pull request draft")?;
        let dir = self.workdir();
        let commit = |rev: &str| {
            git_in(
                dir,
                &[
                    "rev-parse",
                    "--verify",
                    "-q",
                    "--end-of-options",
                    &format!("{rev}^{{commit}}"),
                ],
            )
            .ok()
        };
        let tip = commit(&format!("refs/heads/{branch}"))
            .ok_or_else(|| Error::Message(format!("There is no local branch {branch}.")))?;
        let remote_base = self
            .github_remote_name()
            .map(|remote| format!("refs/remotes/{remote}/{base}"));
        let base_rev = remote_base
            .into_iter()
            .chain([base.to_string()])
            .find_map(|rev| commit(&rev))
            .ok_or_else(|| {
                Error::Message(format!("{base} is not in this repository: fetch it first."))
            })?;
        let log = git_in(
            dir,
            &[
                "log",
                "--format=commit %h%n%s%n%n%b",
                &format!("{base_rev}..{tip}"),
                "--",
            ],
        )?;
        if log.is_empty() {
            return Err(Error::Message(format!(
                "{branch} has no commits that {base} lacks."
            )));
        }
        let range = format!("{base_rev}...{tip}");
        let mut args = DIFF.to_vec();
        args.extend([range.as_str(), "--"]);
        let diff = String::from_utf8_lossy(&git_raw(dir, &args)?).into_owned();
        let input = format!("{log}\n\n{}", cut_diff(&diff, DRAFT_DIFF_LIMIT));
        let mut env = vec![
            ("GITP_BRANCH", branch.to_string()),
            ("GITP_BASE", base.to_string()),
        ];
        if let Some(template) = PR_TEMPLATES
            .iter()
            .map(|p| dir.join(p))
            .find(|p| p.is_file())
        {
            env.push((
                "GITP_PR_TEMPLATE_FILE",
                template.to_string_lossy().into_owned(),
            ));
        }
        let out = run_shell(
            dir,
            command,
            input.as_bytes(),
            &env,
            DRAFT_TIMEOUT,
            &self.net,
        )
        .map_err(|e| renamed(e, "The pull request draft command"))?;
        pr_draft_from(&draft_text(&out.stdout)?)
    }
}

/// A pull request draft from an answer: `{"title", "body"}` (bare or in a
/// code fence), else the first line as the title and the rest as the body.
fn pr_draft_from(text: &str) -> Result<PrDraft> {
    #[derive(Deserialize)]
    struct Answer {
        title: String,
        #[serde(default)]
        body: String,
    }
    let text = text.trim();
    let unfenced = text
        .strip_prefix("```json")
        .or_else(|| text.strip_prefix("```"))
        .and_then(|t| t.strip_suffix("```"))
        .unwrap_or(text)
        .trim();
    if let Ok(answer) = serde_json::from_str::<Answer>(unfenced) {
        if !answer.title.trim().is_empty() {
            return Ok(PrDraft {
                title: answer.title.trim().to_string(),
                body: answer.body.trim().to_string(),
            });
        }
    }
    if text.is_empty() {
        return Err(Error::Message("Claude wrote no pull request draft.".into()));
    }
    let (first, rest) = text.split_once('\n').unwrap_or((text, ""));
    Ok(PrDraft {
        title: first.trim_start_matches('#').trim().to_string(),
        body: rest.trim().to_string(),
    })
}

/// The command, or the error that asks for one.
fn required<'a>(command: &'a str, what: &str) -> Result<&'a str> {
    let command = command.trim();
    if command.is_empty() {
        Err(Error::Message(format!(
            "Set a {what} command in Settings → Git first."
        )))
    } else {
        Ok(command)
    }
}

/// `run_shell` speaks of "the review command"; a draft names its own.
fn renamed(e: Error, what: &str) -> Error {
    const REVIEW: &str = "The review command";
    match e {
        Error::Message(m) if m.starts_with(REVIEW) => {
            Error::Message(format!("{what}{}", &m[REVIEW.len()..]))
        }
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
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
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
        assert_eq!(
            draft,
            CommitDraft {
                subject: "feat: x".into(),
                body: "why".into()
            }
        );
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
        let err = message(
            repo.draft_commit_message("touch ran.txt", false)
                .unwrap_err(),
        );
        assert_eq!(err, "Stage something first.");
        assert!(!dir.path().join("ran.txt").exists());
    }

    #[test]
    fn an_amend_reads_heads_diff_and_the_staged_one() {
        let (dir, repo) = repo();
        std::fs::write(dir.path().join("c.txt"), "staged\n").unwrap();
        git(dir.path(), &["add", "c.txt"]);
        let draft = repo
            .draft_commit_message("cat >/dev/null; echo s", true)
            .unwrap();
        assert_eq!(draft.subject, "s");
        let out = repo
            .draft_commit_message(
                r#"f=$(cat); echo "$f" | grep -c '^+++ b/' | tr -d ' '"#,
                true,
            )
            .unwrap();
        assert_eq!(out.subject, "2", "b.txt from HEAD and the staged c.txt");
        // A root commit has no parent: its whole tree is the change.
        let root = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "-q", "-b", "main"]);
        commit(root.path(), "r.txt", "root\n", "root");
        let repo = Repo::open(root.path()).unwrap();
        let out = repo
            .draft_commit_message("grep -c '^+root' | tr -d ' '", true)
            .unwrap();
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
            CommitDraft {
                subject: "fix: y".into(),
                body: "because".into()
            }
        );
        let bad = r#"cat >/dev/null; printf '%s\n' '{"type":"result","is_error":true,"result":"Credit balance is too low"}'"#;
        assert_eq!(
            message(repo.draft_commit_message(bad, false).unwrap_err()),
            "Credit balance is too low"
        );
        let empty = "cat >/dev/null; echo '   '";
        assert!(
            message(repo.draft_commit_message(empty, false).unwrap_err())
                .contains("no commit message")
        );
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
        assert!(
            cut.trim_end().ends_with("not shown]"),
            "{}",
            &cut[cut.len() - 120..]
        );
        let body = &cut[..cut.find("\n[gitp:").unwrap() + 1];
        assert!(
            body.lines().all(|l| l == line.trim_end()),
            "cut at a line end"
        );
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
        let err = message(
            repo.draft_commit_message("cat >/dev/null; echo oops >&2; exit 3", false)
                .unwrap_err(),
        );
        assert!(
            err.starts_with("The commit message command failed (exit code 3)."),
            "{err}"
        );
        assert!(err.contains("oops"), "{err}");
    }

    /// `repo()` plus `feature` from `main` with commits f1 and f2.
    fn feature_repo() -> (tempfile::TempDir, Repo) {
        let (dir, repo) = repo();
        git(dir.path(), &["checkout", "-qb", "feature"]);
        commit(dir.path(), "f.txt", "f1\n", "f1");
        commit(dir.path(), "f.txt", "f1\nf2\n", "f2");
        (dir, repo)
    }

    const JSON_ANSWER: &str = r#"printf '%s\n' '{"title":"T","body":"B\n\n## Checks\n- [ ] x"}'"#;

    #[test]
    fn a_pr_draft_reads_the_log_then_the_diff_with_the_env() {
        let (dir, repo) = feature_repo();
        let seen = dir.path().join("seen.txt");
        let cmd = format!(
            r#"{{ echo "$GITP_BRANCH|$GITP_BASE|${{GITP_PR_TEMPLATE_FILE-unset}}"; cat; }} > {}; {JSON_ANSWER}"#,
            seen.display()
        );
        let draft = repo.draft_pull_request(&cmd, "main", "feature").unwrap();
        assert_eq!(
            draft,
            PrDraft {
                title: "T".into(),
                body: "B\n\n## Checks\n- [ ] x".into()
            }
        );
        let seen = std::fs::read_to_string(&seen).unwrap();
        assert_eq!(seen.lines().next(), Some("feature|main|unset"));
        let diff_at = seen.find("diff --git").expect("the diff");
        assert!(
            seen.find("f1").unwrap() < diff_at && seen.find("f2").unwrap() < diff_at,
            "{seen}"
        );
        assert!(
            !seen.contains("\ntwo\n"),
            "main's commits are not in the log: {seen}"
        );
        assert!(seen.contains("+f2"), "{seen}");
    }

    #[test]
    fn a_template_is_named_in_the_env() {
        let (dir, repo) = feature_repo();
        std::fs::create_dir_all(dir.path().join(".github")).unwrap();
        std::fs::write(
            dir.path().join(".github/pull_request_template.md"),
            "## Why\n",
        )
        .unwrap();
        let cmd = r#"cat >/dev/null; printf '%s\n' "$GITP_PR_TEMPLATE_FILE"; cat "$GITP_PR_TEMPLATE_FILE""#;
        let draft = repo.draft_pull_request(cmd, "main", "feature").unwrap();
        assert!(
            draft.title.ends_with(".github/pull_request_template.md"),
            "{}",
            draft.title
        );
        assert!(Path::new(&draft.title).is_absolute());
        assert_eq!(draft.body, "## Why");
    }

    #[test]
    fn the_github_remotes_base_is_used_when_fetched() {
        let (dir, repo) = feature_repo();
        let one = git(dir.path(), &["rev-parse", "main~1"]);
        git(
            dir.path(),
            &["remote", "add", "origin", "git@github.com:o/r.git"],
        );
        git(
            dir.path(),
            &["update-ref", "refs/remotes/origin/main", &one],
        );
        let draft = repo
            .draft_pull_request("grep -c '^commit ' | tr -d ' '", "main", "feature")
            .unwrap();
        assert_eq!(draft.title, "3", "two, f1 and f2 are not on origin/main");
    }

    #[test]
    fn no_commits_ahead_is_refused_without_running() {
        let (dir, repo) = repo();
        git(dir.path(), &["branch", "same"]);
        let err = message(
            repo.draft_pull_request("touch ran.txt", "main", "same")
                .unwrap_err(),
        );
        assert_eq!(err, "same has no commits that main lacks.");
        assert!(!dir.path().join("ran.txt").exists());
        let err = message(
            repo.draft_pull_request("touch ran.txt", "nope", "same")
                .unwrap_err(),
        );
        assert!(err.contains("nope"), "{err}");
        assert!(!dir.path().join("ran.txt").exists());
    }

    #[test]
    fn a_failing_pr_command_names_the_pull_request_draft_command() {
        let (_dir, repo) = feature_repo();
        let err = message(
            repo.draft_pull_request("cat >/dev/null; exit 2", "main", "feature")
                .unwrap_err(),
        );
        assert!(
            err.starts_with("The pull request draft command failed (exit code 2)"),
            "{err}"
        );
    }

    #[test]
    fn a_plain_or_fenced_answer_is_read() {
        let d = |t: &str, b: &str| PrDraft {
            title: t.into(),
            body: b.into(),
        };
        assert_eq!(
            pr_draft_from("# Add drafts\n\nWhy it helps.\n").unwrap(),
            d("Add drafts", "Why it helps.")
        );
        assert_eq!(
            pr_draft_from("Only a title").unwrap(),
            d("Only a title", "")
        );
        assert_eq!(
            pr_draft_from("```json\n{\"title\": \"T\", \"body\": \"B\"}\n```").unwrap(),
            d("T", "B")
        );
        assert_eq!(pr_draft_from(r#"{"title":"T"}"#).unwrap(), d("T", ""));
        assert!(pr_draft_from("  ").is_err());
    }
}
