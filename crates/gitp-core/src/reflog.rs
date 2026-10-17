//! The reflog of HEAD or a branch — every position the ref has held, newest
//! first — so the user can get back to a commit that a reset, amend, rebase or
//! deleted branch left unreachable. Read through git2: the reflog is a plain
//! file, and there are no hooks or messages to respect.

use serde::Serialize;

use crate::error::Result;
use crate::repo::Repo;

/// One reflog entry: the ref moved from `old_id` to `new_id` because of
/// `message` (git's own, e.g. "commit: …", "checkout: moving from a to b").
#[derive(Debug, Clone, Serialize)]
pub struct ReflogEntry {
    /// Position in the reflog: 0 is the most recent move.
    pub index: usize,
    /// The revision naming this entry, e.g. `HEAD@{3}` or `main@{0}`.
    pub selector: String,
    /// Full hex id the ref moved to.
    pub new_id: String,
    /// Abbreviated `new_id` (7 chars) for display.
    pub short_id: String,
    /// Full hex id the ref moved from (all zeros for the ref's first entry).
    pub old_id: String,
    pub message: String,
    pub committer: String,
    /// When the ref moved, seconds since the epoch.
    pub time: i64,
    /// Summary of the `new_id` commit, or `None` if it has been pruned (or
    /// isn't a commit), so the UI can still list the entry.
    pub summary: Option<String>,
}

impl Repo {
    /// Up to `limit` entries of `refname`'s reflog (`HEAD` or a full ref such
    /// as `refs/heads/main`), newest first. A ref without a reflog has none.
    pub fn reflog(&self, refname: &str, limit: usize) -> Result<Vec<ReflogEntry>> {
        let reflog = self.inner.reflog(refname)?;
        let short = refname.strip_prefix("refs/heads/").unwrap_or(refname);
        Ok(reflog
            .iter()
            .take(limit)
            .enumerate()
            .map(|(index, entry)| {
                let new_id = entry.id_new().to_string();
                let committer = entry.committer();
                ReflogEntry {
                    index,
                    selector: format!("{short}@{{{index}}}"),
                    short_id: new_id[..7].to_string(),
                    summary: self
                        .inner
                        .find_commit(entry.id_new())
                        .ok()
                        .map(|c| c.summary().unwrap_or("").to_string()),
                    new_id,
                    old_id: entry.id_old().to_string(),
                    message: entry.message().unwrap_or("").to_string(),
                    committer: committer.name().unwrap_or("").to_string(),
                    time: committer.when().seconds(),
                }
            })
            .collect())
    }
}
