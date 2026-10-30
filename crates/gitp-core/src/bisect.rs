//! Guided `git bisect`: start a session, mark the checked-out commit (or any
//! revision) good / bad / skip, report where the session stands, and reset.
//!
//! Every step shells out to `git bisect`, so git picks the next commit and
//! checks it out exactly as it would in a terminal. The status is read back
//! from what git keeps in `.git` — `BISECT_LOG` (a session exists),
//! `BISECT_START` (where it started), `BISECT_TERMS` and the `refs/bisect/*`
//! marks — never from a command's stdout, so it survives an app restart and
//! picks up a bisect started from the terminal.

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::remote::ref_arg;
use crate::repo::Repo;

/// How the commit under test behaved.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BisectMark {
    Good,
    Bad,
    /// Can't be tested (doesn't build, unrelated breakage): git picks a
    /// nearby commit instead.
    Skip,
}

/// Where an in-progress bisect stands, for the bisect banner and log markers.
#[derive(Debug, Clone, Serialize)]
pub struct BisectStatus {
    /// The commit marked bad, once one is.
    pub bad: Option<String>,
    pub good: Vec<String>,
    pub skipped: Vec<String>,
    /// The commit checked out for testing (HEAD).
    pub current: String,
    pub current_summary: String,
    /// `(revisions, steps)`: git's "N revisions left to test after this
    /// (roughly M steps)". `None` until both ends are marked, and once done.
    pub remaining_estimate: Option<(usize, usize)>,
    /// Set once the session has narrowed down to a single commit.
    pub first_bad: Option<String>,
    pub first_bad_summary: Option<String>,
    /// The branch (or detached commit id) the bisect started from, which
    /// `bisect_reset` returns to.
    pub original_ref: String,
}

impl Repo {
    /// The in-progress bisect, or `None` when there isn't one.
    pub fn bisect_status(&self) -> Result<Option<BisectStatus>> {
        let git_dir = self.inner.path();
        // `git status` decides "you are currently bisecting" the same way.
        if !git_dir.join("BISECT_LOG").exists() {
            return Ok(None);
        }
        let original_ref = std::fs::read_to_string(git_dir.join("BISECT_START"))
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let (bad_term, good_term) = self.bisect_terms();

        let mut bad = None;
        let mut good = Vec::new();
        let mut skipped = Vec::new();
        for reference in self.inner.references_glob("refs/bisect/*")? {
            let reference = reference?;
            let (Some(name), Some(oid)) = (reference.name(), reference.target()) else {
                continue;
            };
            let name = name.trim_start_matches("refs/bisect/");
            if name == bad_term {
                bad = Some(oid.to_string());
            } else if name.starts_with(&format!("{good_term}-")) {
                good.push(oid.to_string());
            } else if name.starts_with("skip-") {
                skipped.push(oid.to_string());
            }
        }

        let head = self.inner.head()?.peel_to_commit()?;
        let mut status = BisectStatus {
            bad,
            good,
            skipped,
            current: head.id().to_string(),
            current_summary: head.summary().unwrap_or_default().to_string(),
            remaining_estimate: None,
            first_bad: None,
            first_bad_summary: None,
            original_ref,
        };

        // With both ends marked, ask git for the same numbers `git bisect`
        // prints. Only the bad commit itself left in the range means it is
        // the first bad one.
        if let (Some(bad), false) = (&status.bad, status.good.is_empty()) {
            let vars = self.bisect_vars(bad, &status.good)?;
            match vars {
                Some((_, _, 1)) => {
                    status.first_bad_summary = Some(self.commit_summary(bad)?);
                    status.first_bad = Some(bad.clone());
                }
                Some((revisions, steps, all)) if all > 1 => {
                    status.remaining_estimate = Some((revisions, steps));
                }
                _ => {}
            }
        }
        Ok(Some(status))
    }

    /// Start a bisect. With `bad` (and any `good` revisions) git checks out
    /// the first commit to test straight away; with only one end known it
    /// waits for the other to be marked. Fails, leaving no session behind,
    /// when git can't check out the midpoint (e.g. conflicting local changes).
    pub fn bisect_start(&self, bad: Option<&str>, good: &[String]) -> Result<String> {
        for rev in bad.iter().copied().chain(good.iter().map(String::as_str)) {
            ref_arg(rev)?;
        }
        let mut args = vec!["bisect", "start"];
        if let Some(bad) = bad {
            args.push(bad);
            args.extend(good.iter().map(String::as_str));
        }
        args.push("--");
        let mut out = self.run_git(&args)?;
        // `git bisect start` takes good revisions only after a bad one.
        if bad.is_none() && !good.is_empty() {
            let (_, good_term) = self.bisect_terms();
            let mut args = vec!["bisect", good_term.as_str()];
            args.extend(good.iter().map(String::as_str));
            out = self.run_git(&args)?;
        }
        Ok(out)
    }

    /// Mark `rev` (the checked-out commit when `None`) and let git move on to
    /// the next commit to test. Returns git's report — including "… is the
    /// first bad commit" once the session is done.
    pub fn bisect_mark(&self, mark: BisectMark, rev: Option<&str>) -> Result<String> {
        let (bad_term, good_term) = self.bisect_terms();
        let term = match mark {
            BisectMark::Good => good_term,
            BisectMark::Bad => bad_term,
            BisectMark::Skip => "skip".to_string(),
        };
        let mut args = vec!["bisect", term.as_str()];
        args.extend(rev.map(ref_arg).transpose()?);
        self.run_git(&args)
    }

    /// End the bisect and check the original branch back out.
    pub fn bisect_reset(&self) -> Result<String> {
        self.run_git(&["bisect", "reset"])
    }

    /// The words this session uses for bad and good: `bad`/`good` unless it
    /// was started with `--term-new`/`--term-old` (or `new`/`old`).
    fn bisect_terms(&self) -> (String, String) {
        let terms =
            std::fs::read_to_string(self.inner.path().join("BISECT_TERMS")).unwrap_or_default();
        let mut lines = terms.lines().map(str::trim).filter(|l| !l.is_empty());
        match (lines.next(), lines.next()) {
            (Some(bad), Some(good)) => (bad.to_string(), good.to_string()),
            _ => ("bad".into(), "good".into()),
        }
    }

    /// `(revisions left after the next test, steps, commits in range)` from
    /// `git rev-list --bisect-vars` — the computation `git bisect` itself runs
    /// to print "N revisions left to test after this (roughly M steps)".
    /// `None` when the range is empty (bad is an ancestor of a good commit).
    fn bisect_vars(&self, bad: &str, good: &[String]) -> Result<Option<(usize, usize, usize)>> {
        let mut args = vec!["rev-list", "--bisect-vars"];
        if self.inner.path().join("BISECT_FIRST_PARENT").exists() {
            args.push("--first-parent");
        }
        args.push(bad);
        args.push("--not");
        args.extend(good.iter().map(String::as_str));
        let out = self.run_git(&args)?;
        let var = |name: &str| {
            out.lines()
                .find_map(|l| l.strip_prefix(name)?.strip_prefix('='))
                .and_then(|v| v.trim_matches('\'').parse::<usize>().ok())
        };
        Ok(
            match (var("bisect_nr"), var("bisect_steps"), var("bisect_all")) {
                (Some(nr), Some(steps), Some(all)) if all > 0 => Some((nr, steps, all)),
                _ => None,
            },
        )
    }

    fn commit_summary(&self, id: &str) -> Result<String> {
        let oid = git2::Oid::from_str(id)?;
        Ok(self
            .inner
            .find_commit(oid)?
            .summary()
            .unwrap_or_default()
            .to_string())
    }
}
