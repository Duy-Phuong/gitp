//! Reviewing a local branch before any pull request exists, and fixing one
//! finding of a review in the worktree that has the branch.
//!
//! The branch is diffed from its merge base with the base, as a pull request
//! would be; the review command and the fix run in the worktree that has the
//! branch checked out (the main checkout included).

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::diff::FileDiff;
use crate::error::{Error, Result};
use crate::gh::{
    claude_answer, git_in, parse_pr_diff, require_clean, require_contains, review_file_written_since,
    run_shell, run_verified_fix, FIX_TIMEOUT, REVIEW_TIMEOUT,
};
use crate::pr_threads::now_millis;
use crate::review_store::{DraftStatus, ReviewFix, ReviewKey, StoredReview};
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

    /// A review page the command left untracked under the worktree's
    /// `review/` would make the worktree dirty, and every Fix refuses a
    /// dirty one (and its undo would delete the page): add `/review/` to the
    /// repository's own exclude file, which every worktree shares and which
    /// is never committed.
    fn keep_review_folder_out(&self, dir: &Path, file: &Path) -> Result<()> {
        let rel = file.strip_prefix(dir).unwrap_or(file).to_string_lossy().into_owned();
        let status = git_in(dir, &["status", "--porcelain", "--untracked-files=all", "--", &rel])?;
        if !status.starts_with("??") {
            return Ok(());
        }
        let info = self.common_dir().join("info");
        std::fs::create_dir_all(&info).map_err(|e| Error::Message(format!("{}: {e}", info.display())))?;
        let exclude = info.join("exclude");
        let mut text = std::fs::read_to_string(&exclude).unwrap_or_default();
        if text.lines().any(|l| l.trim() == "/review/") {
            return Ok(());
        }
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str("# gitp: review pages written by branch reviews\n/review/\n");
        std::fs::write(&exclude, text).map_err(|e| Error::Message(format!("{}: {e}", exclude.display())))
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

    /// Whether the worktree at `dir` has changes a fix would refuse
    /// (untracked files included, ignored ones aside).
    pub fn worktree_dirty(dir: &Path) -> Result<bool> {
        Ok(require_clean(dir).is_err())
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
        if let Some(f) = &file {
            self.keep_review_folder_out(&dir, Path::new(f))?;
        }
        Ok(GeneratedBranchReview {
            text,
            file,
            head: diff.head,
            base: base.to_string(),
        })
    }
}

/// One finding to fix: where it is, what it says, the hunk around it, and
/// the branch (with its base) whose worktree the fix runs in.
#[derive(Debug, Clone, Deserialize)]
pub struct FindingInput {
    pub path: String,
    pub line: u32,
    pub side: String,
    pub body: String,
    pub severity: Option<String>,
    pub diff_hunk: String,
    pub branch: String,
    pub base: String,
    /// A pull request's draft: its number and the head the branch must hold.
    #[serde(default)]
    pub pr: Option<u64>,
    #[serde(default)]
    pub pr_head: Option<String>,
}

impl Repo {
    /// Fix `input` with `fix_command` in the worktree of its branch, with the
    /// thread fix's rules: the worktree must be clean (and, for a pull
    /// request's draft, hold its head); afterwards exactly one new commit and
    /// a clean tree, else everything the run did is undone. The command gets
    /// the finding as JSON in `GITP_THREAD_FILE`, its body on stdin, and runs
    /// as a fresh Claude session each time.
    pub fn fix_finding(&self, input: &FindingInput, fix_command: &str) -> Result<ReviewFix> {
        let command = fix_command.trim();
        if command.is_empty() {
            return Err(Error::Message("Set a fix command in Settings → Git first.".into()));
        }
        let branch = input.branch.as_str();
        let dir = self.branch_worktree(branch)?.ok_or_else(|| {
            Error::Message(format!("Check the branch out first: {branch} is in no worktree."))
        })?;
        require_clean(&dir)?;
        if let (Some(number), Some(head)) = (input.pr, input.pr_head.as_deref()) {
            self.ensure_pull_request_head(number, head)?;
            require_contains(&dir, head)?;
        }
        let before = git_in(&dir, &["rev-parse", "HEAD"])?;
        let finding = serde_json::json!({
            "kind": "finding",
            "path": input.path,
            "line": input.line,
            "side": input.side,
            "body": input.body,
            "severity": input.severity,
            "diff_hunk": input.diff_hunk,
            "branch": input.branch,
            "base": input.base,
        });
        let file = std::env::temp_dir().join(format!(
            "gitp-finding-{}-{}.json",
            std::process::id(),
            now_millis()
        ));
        std::fs::write(&file, finding.to_string())
            .map_err(|e| Error::Message(format!("can't write {}: {e}", file.display())))?;
        let env = [
            ("GITP_THREAD_FILE", file.to_string_lossy().into_owned()),
            ("GITP_TURN_KIND", "fix".to_string()),
            ("GITP_CLAUDE_SESSION", String::new()),
            ("GITP_FIX_WORKTREE", dir.to_string_lossy().into_owned()),
            ("GITP_FIX_BRANCH", branch.to_string()),
            ("GITP_FIX_HEAD_BEFORE", before.clone()),
            ("GITP_FINDING_PATH", input.path.clone()),
            ("GITP_FINDING_LINE", input.line.to_string()),
            ("GITP_BRANCH", branch.to_string()),
            ("GITP_BASE", input.base.clone()),
        ];
        let fixed = run_verified_fix(&dir, branch, &before, || {
            let out = run_shell(&dir, command, input.body.as_bytes(), &env, FIX_TIMEOUT, &self.net)?;
            // A JSON answer that reports an error fails the fix.
            claude_answer(&out.stdout).map(|_| ())
        });
        let _ = std::fs::remove_file(&file);
        let ((), commit) = fixed?;
        Ok(ReviewFix {
            commit,
            worktree: dir.to_string_lossy().into_owned(),
            at: now_millis(),
        })
    }

    /// Fix draft `id` of the review at `key` (see [`Repo::fix_finding`]) and
    /// mark it fixed. The review is read again after the run, so edits saved
    /// meanwhile are kept.
    pub fn fix_review_draft(
        &self,
        key: &ReviewKey,
        id: u64,
        input: &FindingInput,
        fix_command: &str,
    ) -> Result<StoredReview> {
        let missing = || Error::Message(format!("The review has no draft {id}."));
        let review = self.stored_review(key)?.ok_or_else(|| Error::Message("There is no saved review to fix.".into()))?;
        if !review.drafts.iter().any(|d| d.id == id) {
            return Err(missing());
        }
        let fix = self.fix_finding(input, fix_command)?;
        let mut review = self.stored_review(key)?.unwrap_or(review);
        let draft = review.drafts.iter_mut().find(|d| d.id == id).ok_or_else(missing)?;
        draft.status = DraftStatus::Fixed;
        draft.fix = Some(fix);
        self.save_stored_review(&review)?;
        Ok(review)
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

    const COMMIT_ONCE: &str = r#"echo x > fixed.txt; git add fixed.txt; git -c user.name=T -c user.email=t@example.com commit -qm "fix(review): src/f.rs:2 — x""#;

    fn finding() -> FindingInput {
        FindingInput {
            path: "src/f.rs".into(),
            line: 2,
            side: "RIGHT".into(),
            body: "two is wrong".into(),
            severity: Some("minor".into()),
            diff_hunk: "@@ -0,0 +1,3 @@\n+one\n+two\n+three".into(),
            branch: "feature".into(),
            base: "main".into(),
            pr: None,
            pr_head: None,
        }
    }

    #[test]
    fn a_finding_fix_runs_in_the_worktree_with_the_finding() {
        let (dir, repo, wt, _fork) = branch_repo();
        let log = dir.path().join("log.txt");
        let cmd = format!(
            r#"{{ echo "$PWD|$GITP_TURN_KIND|$GITP_FINDING_PATH:$GITP_FINDING_LINE|$GITP_FIX_BRANCH|$GITP_FIX_HEAD_BEFORE|$GITP_BRANCH|$GITP_BASE|s=$GITP_CLAUDE_SESSION|$GITP_FIX_WORKTREE"; cat "$GITP_THREAD_FILE"; echo; cat; }} > {}; {COMMIT_ONCE}; echo summary"#,
            log.display()
        );
        let before = repo.resolve_commit("feature").unwrap();
        let fix = repo.fix_finding(&finding(), &cmd).unwrap();
        let after = repo.resolve_commit("feature").unwrap();
        assert_eq!(fix.commit, after);
        assert_eq!(canonical(Path::new(&fix.worktree)), canonical(&wt));
        let logged = std::fs::read_to_string(&log).unwrap();
        let mut lines = logged.lines();
        let env: Vec<_> = lines.next().unwrap().split('|').collect();
        assert_eq!(canonical(Path::new(env[0])), canonical(&wt));
        assert_eq!(&env[1..8], ["fix", "src/f.rs:2", "feature", before.as_str(), "feature", "main", "s="]);
        let json: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(json["kind"], "finding");
        assert_eq!(json["path"], "src/f.rs");
        assert_eq!(json["line"], 2);
        assert_eq!(json["diff_hunk"], "@@ -0,0 +1,3 @@\n+one\n+two\n+three");
        assert_eq!(json["branch"], "feature");
        assert_eq!(json["base"], "main");
        assert_eq!(lines.next(), Some("two is wrong"), "the body on stdin");
    }

    #[test]
    fn a_finding_fix_that_commits_twice_or_dirties_is_undone() {
        let (_dir, repo, wt, _fork) = branch_repo();
        let before = repo.resolve_commit("feature").unwrap();
        let twice = format!("{COMMIT_ONCE}; echo y > again.txt; git add again.txt; git -c user.name=T -c user.email=t@example.com commit -qm twice");
        let err = message(repo.fix_finding(&finding(), &twice).unwrap_err());
        assert!(err.contains("exactly one commit"), "{err}");
        assert_eq!(repo.resolve_commit("feature").unwrap(), before);
        assert!(!wt.join("fixed.txt").exists() && !wt.join("again.txt").exists());
        let dirty = format!("{COMMIT_ONCE}; echo z > dirty.txt");
        let err = message(repo.fix_finding(&finding(), &dirty).unwrap_err());
        assert!(err.contains("uncommitted"), "{err}");
        assert!(!wt.join("dirty.txt").exists());
        assert_eq!(repo.resolve_commit("feature").unwrap(), before);
    }

    #[test]
    fn a_finding_fix_refuses_a_dirty_or_missing_worktree() {
        let (dir, repo, wt, _fork) = branch_repo();
        std::fs::write(wt.join("mine.txt"), "wip").unwrap();
        let err = message(repo.fix_finding(&finding(), "touch ran.txt").unwrap_err());
        assert!(err.contains("Commit or stash"), "{err}");
        assert!(!wt.join("ran.txt").exists() && wt.join("mine.txt").exists());
        git(dir.path(), &["branch", "loose", "main"]);
        let loose = FindingInput { branch: "loose".into(), ..finding() };
        let err = message(repo.fix_finding(&loose, "touch ran.txt").unwrap_err());
        assert!(err.contains("in no worktree"), "{err}");
    }

    #[test]
    fn fixing_a_stored_draft_marks_it_fixed_and_keeps_other_edits() {
        use crate::review_store::{DraftStatus, ReviewKey, StoredDraft, StoredReview};
        let (dir, repo, _wt, _fork) = branch_repo();
        let d = |id, body: &str| StoredDraft {
            id,
            path: "src/f.rs".into(),
            line: 2,
            side: "RIGHT".into(),
            body: body.into(),
            severity: None,
            original: body.into(),
            status: DraftStatus::Pending,
            topic: None,
            fix: None,
        };
        let review = StoredReview {
            version: 1,
            branch: Some("feature".into()),
            pr: None,
            base: "main".into(),
            head: repo.resolve_commit("feature").unwrap(),
            drafts: vec![d(1, "one"), d(2, "two")],
        };
        let key = ReviewKey::Branch("feature".into());
        repo.save_stored_review(&review).unwrap();
        // While the fix runs, the user edits draft 2 (the frontend saves it).
        let mut edited = review.clone();
        edited.drafts[1].body = "two, edited".into();
        let edit = dir.path().join("edited.json");
        std::fs::write(&edit, serde_json::to_vec(&edited).unwrap()).unwrap();
        let store = repo.common_dir().join("gitp/branch-reviews/feature.json");
        let cmd = format!("cp {} {}; {COMMIT_ONCE}", edit.display(), store.display());
        let out = repo.fix_review_draft(&key, 1, &finding(), &cmd).unwrap();
        assert_eq!(out.drafts[0].status, DraftStatus::Fixed);
        assert_eq!(out.drafts[0].fix.as_ref().unwrap().commit, repo.resolve_commit("feature").unwrap());
        assert_eq!(out.drafts[1].body, "two, edited");
        assert_eq!(out.drafts[1].status, DraftStatus::Pending);
        assert_eq!(repo.stored_review(&key).unwrap(), Some(out));
        let err = message(repo.fix_review_draft(&key, 9, &finding(), "touch ran.txt").unwrap_err());
        assert!(err.contains("no draft"), "{err}");
        assert!(!dir.path().join("wt/ran.txt").exists());
    }

    #[test]
    fn a_review_file_left_in_the_worktree_does_not_block_a_fix() {
        let (dir, repo, wt, _fork) = branch_repo();
        let cmd = "mkdir -p review/s; printf '### src/f.rs:2\\nfound' > review/s/pr-review-x.md";
        repo.generate_branch_review("feature", "main", cmd).unwrap();
        let exclude = std::fs::read_to_string(dir.path().join(".git/info/exclude")).unwrap();
        assert!(exclude.lines().any(|l| l == "/review/"), "{exclude}");
        repo.fix_finding(&finding(), COMMIT_ONCE).unwrap();
        assert!(wt.join("review/s/pr-review-x.md").exists(), "the review page stays");
        // A second review adds no second line.
        repo.generate_branch_review("feature", "main", cmd).unwrap();
        let again = std::fs::read_to_string(dir.path().join(".git/info/exclude")).unwrap();
        assert_eq!(again.matches("/review/").count(), 1);
    }
}
