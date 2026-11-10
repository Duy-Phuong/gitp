//! The review drafts of a local branch (reviewed before any pull request
//! exists) and of a pull request, with what the user decided about each and
//! the fix that answered it.
//!
//! One JSON file per review under the repository's own git directory, so it
//! is never in the working tree and every worktree shares it:
//! `<common dir>/gitp/branch-reviews/<branch>.json` (`%` as `%25` and `/` as
//! `%2F`) and `<common dir>/gitp/pr-reviews/<number>.json`, in one shape.
//! Written atomically; a file that no longer parses is deleted; files not
//! written for [`THREAD_KEEP`] are pruned with the thread conversations.

use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::pr_threads::THREAD_KEEP;
use crate::repo::Repo;

/// The commit a fix made, where, and when (epoch ms).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewFix {
    pub commit: String,
    pub worktree: String,
    pub at: u64,
    /// Set when the worktree's own changes, set aside for the fix, clashed
    /// with it and stay in the stash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

/// What the user decided about a draft, or that a fix answered it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DraftStatus {
    Pending,
    Approved,
    Discarded,
    Fixed,
}

/// One finding of the review, as the Drafts tab keeps it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredDraft {
    pub id: u64,
    pub path: String,
    pub line: u32,
    /// "LEFT" or "RIGHT".
    pub side: String,
    pub body: String,
    pub severity: Option<String>,
    /// The text as the review wrote it, before any edit.
    pub original: String,
    pub status: DraftStatus,
    /// The heading of a comment on the whole change (no path, line 0).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix: Option<ReviewFix>,
    /// Kept from a run before the last, which didn't find it again: its
    /// line belongs to an older head.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stale: bool,
    /// What the review file says about the finding besides the comment.
    #[serde(flatten)]
    pub about: FindingText,
}

/// The review's own words on a finding: its "Explained simply" text, its id
/// on the review board ("f3"), and the board's "Explain more" answers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindingText {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explained: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finding: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub explanations: Vec<String>,
}

/// A review's drafts: of a branch (`branch`) or a pull request (`pr`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredReview {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<u64>,
    /// The base the branch was reviewed against; empty for a pull request.
    #[serde(default)]
    pub base: String,
    /// The commit that was reviewed.
    #[serde(default)]
    pub head: String,
    pub drafts: Vec<StoredDraft>,
}

/// Which review: a branch's or a pull request's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewKey {
    Branch(String),
    Pr(u64),
}

impl StoredReview {
    /// The review this is: exactly one of `branch` and `pr` names it.
    pub fn key(&self) -> Result<ReviewKey> {
        match (&self.branch, self.pr) {
            (Some(b), None) if !b.is_empty() => Ok(ReviewKey::Branch(b.clone())),
            (None, Some(n)) => Ok(ReviewKey::Pr(n)),
            _ => Err(Error::Message(
                "A review belongs to one branch or one pull request.".into(),
            )),
        }
    }
}

impl Repo {
    fn reviews_root(&self) -> PathBuf {
        self.common_dir().join("gitp")
    }

    fn review_file(&self, key: &ReviewKey) -> PathBuf {
        match key {
            ReviewKey::Branch(b) => self.reviews_root().join("branch-reviews").join(format!(
                "{}.json",
                b.replace('%', "%25").replace('/', "%2F")
            )),
            ReviewKey::Pr(n) => self
                .reviews_root()
                .join("pr-reviews")
                .join(format!("{n}.json")),
        }
    }

    /// The saved review, or `None`. A damaged file is deleted and counts as none.
    pub fn stored_review(&self, key: &ReviewKey) -> Result<Option<StoredReview>> {
        let file = self.review_file(key);
        let text = match std::fs::read(&file) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io_err(&file, e)),
        };
        match serde_json::from_slice(&text) {
            Ok(r) => Ok(Some(r)),
            Err(_) => {
                std::fs::remove_file(&file).map_err(|e| io_err(&file, e))?;
                Ok(None)
            }
        }
    }

    /// Write the review, whole and atomically.
    pub fn save_stored_review(&self, r: &StoredReview) -> Result<()> {
        let file = self.review_file(&r.key()?);
        let dir = file.parent().expect("the file is in a folder");
        std::fs::create_dir_all(dir).map_err(|e| io_err(dir, e))?;
        let tmp = file.with_extension("json.tmp");
        let text = serde_json::to_vec_pretty(r)
            .map_err(|e| Error::Message(format!("can't encode the review: {e}")))?;
        std::fs::write(&tmp, text).map_err(|e| io_err(&tmp, e))?;
        std::fs::rename(&tmp, &file).map_err(|e| io_err(&file, e))
    }

    /// Delete the review; nothing to delete is fine.
    pub fn delete_stored_review(&self, key: &ReviewKey) -> Result<()> {
        let file = self.review_file(key);
        match std::fs::remove_file(&file) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_err(&file, e)),
        }
    }

    /// Delete every review file last written more than [`THREAD_KEEP`]
    /// before `now_millis`. Returns how many went.
    pub fn prune_stored_reviews(&self, now_millis: u64) -> Result<usize> {
        let cutoff = UNIX_EPOCH
            + Duration::from_millis(now_millis.saturating_sub(THREAD_KEEP.as_millis() as u64));
        let mut deleted = 0;
        for folder in ["branch-reviews", "pr-reviews"] {
            let dir = self.reviews_root().join(folder);
            let entries = match std::fs::read_dir(&dir) {
                Ok(d) => d,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(io_err(&dir, e)),
            };
            for entry in entries.flatten() {
                let file = entry.path();
                let old = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .is_ok_and(|t| t < cutoff);
                if old && file.extension().is_some_and(|x| x == "json") {
                    std::fs::remove_file(&file).map_err(|e| io_err(&file, e))?;
                    deleted += 1;
                }
            }
        }
        Ok(deleted)
    }

    /// The base a branch is reviewed against: the default branch `origin/HEAD`
    /// names (no network call), else `main`, else `master`; as the
    /// remote-tracking ref `origin/<name>` when it exists, else the local one.
    pub fn default_review_base(&self) -> Result<String> {
        let git = &self.inner;
        let exists = |name: &str| git.find_reference(name).is_ok();
        let from_origin = git
            .find_reference("refs/remotes/origin/HEAD")
            .ok()
            .and_then(|r| r.symbolic_target().map(str::to_string))
            .and_then(|t| t.strip_prefix("refs/remotes/origin/").map(str::to_string));
        let candidates = from_origin
            .into_iter()
            .chain(["main".to_string(), "master".to_string()]);
        for name in candidates {
            if exists(&format!("refs/remotes/origin/{name}")) {
                return Ok(format!("origin/{name}"));
            }
            if exists(&format!("refs/heads/{name}")) {
                return Ok(name);
            }
        }
        Err(Error::Message(
            "No base to review against: the repository has no main or master branch.".into(),
        ))
    }
}

fn io_err(path: &Path, e: std::io::Error) -> Error {
    Error::Message(format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn test_repo() -> (tempfile::TempDir, Repo) {
        let dir = tempfile::tempdir().unwrap();
        let git = git2::Repository::init(dir.path()).unwrap();
        let sig = git2::Signature::now("T", "t@example.com").unwrap();
        let tree = git.treebuilder(None).unwrap().write().unwrap();
        let tree = git.find_tree(tree).unwrap();
        git.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
            .unwrap();
        let repo = Repo::open(dir.path()).unwrap();
        (dir, repo)
    }

    fn draft(id: u64, status: DraftStatus) -> StoredDraft {
        StoredDraft {
            id,
            path: "src/a.rs".into(),
            line: 12,
            side: "RIGHT".into(),
            body: "edited".into(),
            severity: Some("minor".into()),
            original: "as written".into(),
            status,
            topic: None,
            fix: None,
            stale: false,
            about: Default::default(),
        }
    }

    fn review(branch: Option<&str>, pr: Option<u64>) -> StoredReview {
        StoredReview {
            version: 1,
            branch: branch.map(str::to_string),
            pr,
            base: "origin/main".into(),
            head: "a".repeat(40),
            drafts: vec![
                draft(1, DraftStatus::Pending),
                StoredDraft {
                    fix: Some(ReviewFix {
                        commit: "b".repeat(40),
                        worktree: "/w".into(),
                        at: 5,
                        notice: None,
                    }),
                    // The review's words on it come back too.
                    about: FindingText {
                        explained: Some("Why.".into()),
                        finding: Some("f2".into()),
                        explanations: vec!["More.".into()],
                    },
                    ..draft(2, DraftStatus::Fixed)
                },
            ],
        }
    }

    #[test]
    fn a_review_round_trips_by_branch_and_by_number() {
        let (dir, repo) = test_repo();
        let b = review(Some("feat/x"), None);
        let p = review(None, Some(7));
        let odd = review(Some("feat%2Fx"), None);
        let bk = ReviewKey::Branch("feat/x".into());
        assert_eq!(repo.stored_review(&bk).unwrap(), None);
        repo.save_stored_review(&b).unwrap();
        repo.save_stored_review(&p).unwrap();
        repo.save_stored_review(&odd).unwrap();
        assert!(dir
            .path()
            .join(".git/gitp/branch-reviews/feat%2Fx.json")
            .is_file());
        assert!(dir
            .path()
            .join(".git/gitp/branch-reviews/feat%252Fx.json")
            .is_file());
        assert!(dir.path().join(".git/gitp/pr-reviews/7.json").is_file());
        assert_eq!(repo.stored_review(&bk).unwrap(), Some(b));
        assert_eq!(repo.stored_review(&ReviewKey::Pr(7)).unwrap(), Some(p));
        assert_eq!(
            repo.stored_review(&ReviewKey::Branch("feat%2Fx".into()))
                .unwrap(),
            Some(odd)
        );
        let text = std::fs::read_to_string(dir.path().join(".git/gitp/pr-reviews/7.json")).unwrap();
        assert!(text.contains("\"status\": \"fixed\""), "{text}");
        repo.delete_stored_review(&bk).unwrap();
        repo.delete_stored_review(&bk).unwrap();
        assert_eq!(repo.stored_review(&bk).unwrap(), None);
    }

    #[test]
    fn a_damaged_review_is_deleted_and_reads_as_none() {
        let (dir, repo) = test_repo();
        let file = dir.path().join(".git/gitp/pr-reviews/3.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "{ not json").unwrap();
        assert_eq!(repo.stored_review(&ReviewKey::Pr(3)).unwrap(), None);
        assert!(!file.exists());
    }

    #[test]
    fn old_reviews_are_pruned_by_mtime() {
        let (dir, repo) = test_repo();
        repo.save_stored_review(&review(Some("old"), None)).unwrap();
        repo.save_stored_review(&review(None, Some(4))).unwrap();
        let old = dir.path().join(".git/gitp/branch-reviews/old.json");
        let then = SystemTime::now() - Duration::from_secs(61 * 24 * 60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(then)
            .unwrap();
        let now = crate::pr_threads::now_millis();
        assert_eq!(repo.prune_stored_reviews(now).unwrap(), 1);
        assert!(!old.exists());
        assert!(repo.stored_review(&ReviewKey::Pr(4)).unwrap().is_some());
    }

    #[test]
    fn a_key_needs_exactly_one_of_branch_and_pr() {
        assert_eq!(
            review(Some("b"), None).key().unwrap(),
            ReviewKey::Branch("b".into())
        );
        assert_eq!(review(None, Some(2)).key().unwrap(), ReviewKey::Pr(2));
        assert!(review(None, None).key().is_err());
        assert!(review(Some("b"), Some(2)).key().is_err());
        let (_dir, repo) = test_repo();
        assert!(repo.save_stored_review(&review(None, None)).is_err());
        let json = serde_json::to_string(&ReviewKey::Branch("x".into())).unwrap();
        assert_eq!(json, r#"{"branch":"x"}"#);
        assert_eq!(
            serde_json::from_str::<ReviewKey>(r#"{"pr":7}"#).unwrap(),
            ReviewKey::Pr(7)
        );
    }

    #[test]
    fn the_base_comes_from_origin_head_then_main_then_master() {
        let (_dir, repo) = test_repo();
        let git = git2::Repository::open(repo.workdir()).unwrap();
        let head = git.head().unwrap().target().unwrap();
        let commit = git.find_commit(head).unwrap();
        // The init's own branch is main or master, as the machine's
        // init.defaultBranch says (CI's is main): start from a branch named
        // neither, then name the cases explicitly.
        git.branch("work", &commit, true).unwrap();
        git.set_head("refs/heads/work").unwrap();
        for name in ["main", "master"] {
            if let Ok(mut b) = git.find_branch(name, git2::BranchType::Local) {
                b.delete().unwrap();
            }
        }
        git.branch("master", &commit, true).unwrap();
        assert_eq!(repo.default_review_base().unwrap(), "master");
        git.branch("main", &git.find_commit(head).unwrap(), true)
            .unwrap();
        assert_eq!(repo.default_review_base().unwrap(), "main");
        git.reference("refs/remotes/origin/main", head, true, "t")
            .unwrap();
        assert_eq!(repo.default_review_base().unwrap(), "origin/main");
        git.reference("refs/remotes/origin/develop", head, true, "t")
            .unwrap();
        git.reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/develop",
            true,
            "t",
        )
        .unwrap();
        assert_eq!(repo.default_review_base().unwrap(), "origin/develop");
    }
}
