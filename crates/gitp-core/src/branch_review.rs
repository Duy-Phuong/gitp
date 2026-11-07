//! Reviewing a local branch before any pull request exists, and fixing one
//! finding of a review in the worktree that has the branch.
//!
//! The branch is diffed from its merge base with the base, as a pull request
//! would be; the review command and the fix run in the worktree that has the
//! branch checked out (the main checkout included).

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;

use crate::diff::FileDiff;
use crate::error::{Error, Result};
use crate::gh::{git_in, parse_pr_diff, review_file_written_since, run_shell, REVIEW_TIMEOUT};
use crate::repo::Repo;

/// A branch's changes against its base, from their merge base.
#[derive(Debug, Clone, Serialize)]
pub struct BranchDiff {
    pub base: String,
    /// The branch's commit.
    pub head: String,
    pub merge_base: String,
    /// The diff as `git diff` prints it, for a review command's stdin.
    #[serde(skip)]
    pub text: String,
    pub files: Vec<FileDiff>,
}

/// What a review command made of a branch, and the commit it reviewed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GeneratedBranchReview {
    pub text: String,
    pub file: Option<String>,
    pub head: String,
    pub base: String,
}

/// `git <args>` in `dir`, its stdout as it came (a diff keeps its last newline).
fn git_raw(dir: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let out = crate::git_bin::git_command()
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(args)
        .output()
        .map_err(|e| Error::Message(format!("failed to run git: {e}")))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(Error::Message(String::from_utf8_lossy(&out.stderr).trim().to_string()))
    }
}

const DIFF: [&str; 5] = ["-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff"];

impl Repo {
    /// `branch` against `base`: what the branch adds since they forked.
    pub fn branch_diff(&self, branch: &str, base: &str) -> Result<BranchDiff> {
        let dir = self.workdir();
        let head = git_in(dir, &["rev-parse", "--verify", "--end-of-options", &format!("{branch}^{{commit}}")])?;
        let merge_base = git_in(dir, &["merge-base", "--end-of-options", base, &head])
            .map_err(|e| Error::Message(format!("{branch} and {base} share no commit: {e}")))?;
        let mut args = DIFF.to_vec();
        args.extend([merge_base.as_str(), head.as_str(), "--"]);
        let bytes = git_raw(dir, &args)?;
        let files = parse_pr_diff(&bytes, self.text_encoding())?;
        Ok(BranchDiff {
            base: base.to_string(),
            head,
            merge_base,
            text: String::from_utf8_lossy(&bytes).into_owned(),
            files,
        })
    }

    /// `git diff from to` as files; `None` when `from` is not in the
    /// repository any more (a reviewed head garbage-collected away).
    pub fn diff_between(&self, from: &str, to: &str) -> Result<Option<Vec<FileDiff>>> {
        let dir = self.workdir();
        if git_in(dir, &["cat-file", "-e", "--end-of-options", &format!("{from}^{{commit}}")]).is_err() {
            return Ok(None);
        }
        let mut args = DIFF.to_vec();
        args.extend([from, to, "--"]);
        let bytes = git_raw(dir, &args)?;
        Ok(Some(parse_pr_diff(&bytes, self.text_encoding())?))
    }

    /// The folder of the worktree that has `branch` checked out, if any.
    pub fn branch_worktree(&self, branch: &str) -> Result<Option<PathBuf>> {
        Ok(self
            .worktrees()?
            .into_iter()
            .find(|w| w.branch.as_deref() == Some(branch))
            .map(|w| PathBuf::from(w.path)))
    }

    /// Run the review `command` over `branch`'s diff against `base`, in the
    /// branch's worktree: the diff on stdin; `GITP_BRANCH`, `GITP_BASE` and
    /// `GITP_HEAD` set. A review file written under that worktree's `review/`
    /// while it ran is the review; otherwise what it printed.
    pub fn generate_branch_review(&self, branch: &str, base: &str, command: &str) -> Result<GeneratedBranchReview> {
        let command = command.trim();
        if command.is_empty() {
            return Err(Error::Message("Set a review command in Settings → Git first.".into()));
        }
        let dir = self.branch_worktree(branch)?.ok_or_else(|| {
            Error::Message(format!("{branch} is checked out in no worktree: check it out first."))
        })?;
        let diff = self.branch_diff(branch, base)?;
        if diff.text.trim().is_empty() {
            return Err(Error::Message(format!(
                "Nothing to review: {branch} has no changes against {base}."
            )));
        }
        let env = [
            ("GITP_BRANCH", branch.to_string()),
            ("GITP_BASE", base.to_string()),
            ("GITP_HEAD", diff.head.clone()),
        ];
        let started = SystemTime::now();
        let out = run_shell(&dir, command, diff.text.as_bytes(), &env, REVIEW_TIMEOUT, &self.net)?;
        let (text, file) = match review_file_written_since(&dir, started) {
            Some(file) => (
                std::fs::read_to_string(&file)
                    .map_err(|e| Error::Message(format!("couldn't read {}: {e}", file.display())))?,
                Some(file.to_string_lossy().into_owned()),
            ),
            None if out.stdout.trim().is_empty() => {
                return Err(Error::Message(format!(
                    "The review command printed nothing.{}",
                    if out.stderr.trim().is_empty() {
                        String::new()
                    } else {
                        format!("\n\n{}", out.stderr.trim())
                    }
                )))
            }
            None => (out.stdout, None),
        };
        Ok(GeneratedBranchReview {
            text,
            file,
            head: diff.head,
            base: base.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// `git` in `dir` with an identity; its trimmed stdout.
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

    /// `main` with a.txt; `feature` forks there and adds src/f.rs; `main`
    /// moves on with b.txt afterwards. `feature` is in the linked worktree
    /// `dir/wt`. Returns the fork point too.
    fn branch_repo() -> (tempfile::TempDir, Repo, PathBuf, String) {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        git(d, &["init", "-q", "-b", "main"]);
        std::fs::write(d.join("a.txt"), "a\n").unwrap();
        git(d, &["add", "."]);
        git(d, &["commit", "-qm", "a"]);
        let fork = git(d, &["rev-parse", "HEAD"]);
        git(d, &["branch", "feature"]);
        std::fs::write(d.join("b.txt"), "b\n").unwrap();
        git(d, &["add", "."]);
        git(d, &["commit", "-qm", "b"]);
        std::fs::write(d.join(".git/info/exclude"), "wt\n").unwrap();
        git(d, &["worktree", "add", "-q", "wt", "feature"]);
        let wt = d.join("wt");
        std::fs::create_dir_all(wt.join("src")).unwrap();
        std::fs::write(wt.join("src/f.rs"), "one\ntwo\nthree\n").unwrap();
        git(&wt, &["add", "."]);
        git(&wt, &["commit", "-qm", "f"]);
        let repo = Repo::open(d).unwrap();
        (dir, repo, wt, fork)
    }

    fn canonical(p: &Path) -> String {
        std::fs::canonicalize(p).unwrap().to_string_lossy().into_owned()
    }

    fn message(e: Error) -> String {
        match e {
            Error::Message(m) => m,
            other => other.to_string(),
        }
    }

    #[test]
    fn a_branch_diff_runs_from_the_merge_base() {
        let (_dir, repo, _wt, fork) = branch_repo();
        let d = repo.branch_diff("feature", "main").unwrap();
        assert_eq!(d.merge_base, fork);
        assert_eq!(d.head, repo.resolve_commit("feature").unwrap());
        assert_eq!(d.base, "main");
        let paths: Vec<_> = d.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["src/f.rs"], "b.txt came to main after the fork");
        assert!(d.text.contains("+two"), "{}", d.text);
    }

    #[test]
    fn a_branch_review_runs_in_the_worktree_with_the_branch_env() {
        let (_dir, repo, wt, _fork) = branch_repo();
        let cmd = r#"n=$(wc -l | tr -d ' '); echo "$PWD|$GITP_BRANCH|$GITP_BASE|$GITP_HEAD|${GITP_PR_NUMBER:-none}|$n""#;
        let out = repo.generate_branch_review("feature", "main", cmd).unwrap();
        let head = repo.resolve_commit("feature").unwrap();
        let parts: Vec<_> = out.text.trim().split('|').collect();
        assert_eq!(canonical(Path::new(parts[0])), canonical(&wt));
        assert_eq!(&parts[1..5], ["feature", "main", head.as_str(), "none"]);
        assert_ne!(parts[5], "0", "the diff came on stdin");
        assert_eq!((out.head, out.base, out.file), (head, "main".to_string(), None));
    }

    #[test]
    fn a_review_file_in_the_worktree_is_read() {
        let (_dir, repo, wt, _fork) = branch_repo();
        let cmd = "mkdir -p review/s; printf '### src/f.rs:2\\nfound' > review/s/pr-review-x.md; echo printed";
        let out = repo.generate_branch_review("feature", "main", cmd).unwrap();
        assert_eq!(out.text, "### src/f.rs:2\nfound");
        assert_eq!(
            out.file.as_deref().map(|f| canonical(Path::new(f))),
            Some(canonical(&wt.join("review/s/pr-review-x.md")))
        );
    }

    #[test]
    fn a_branch_with_no_changes_is_not_reviewed() {
        let (dir, repo, _wt, _fork) = branch_repo();
        git(dir.path(), &["branch", "empty", "main"]);
        git(dir.path(), &["worktree", "add", "-q", "wt2", "empty"]);
        let err = message(repo.generate_branch_review("empty", "main", "touch ran.txt").unwrap_err());
        assert_eq!(err, "Nothing to review: empty has no changes against main.");
        assert!(!dir.path().join("wt2/ran.txt").exists());
    }

    #[test]
    fn a_branch_in_no_worktree_is_not_reviewed() {
        let (dir, repo, _wt, _fork) = branch_repo();
        git(dir.path(), &["branch", "loose", "feature"]);
        let err = message(repo.generate_branch_review("loose", "main", "true").unwrap_err());
        assert!(err.contains("in no worktree"), "{err}");
        assert!(repo.branch_worktree("loose").unwrap().is_none());
        assert_eq!(
            repo.branch_worktree("feature").unwrap().map(|p| canonical(&p)),
            Some(canonical(&dir.path().join("wt")))
        );
    }

    #[test]
    fn the_diff_between_two_heads_is_read_and_a_missing_one_is_none() {
        let (_dir, repo, wt, _fork) = branch_repo();
        let before = repo.resolve_commit("feature").unwrap();
        std::fs::write(wt.join("src/f.rs"), "zero\none\ntwo\nthree\n").unwrap();
        git(&wt, &["commit", "-qam", "g"]);
        let moved = repo.diff_between(&before, "feature").unwrap().unwrap();
        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].path, "src/f.rs");
        assert_eq!(repo.diff_between(&"0".repeat(40), "feature").unwrap().map(|f| f.len()), None);
    }
}
