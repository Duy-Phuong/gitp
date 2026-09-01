//! Tag operations behind the sidebar's tag right-click menu: inspect, push,
//! and delete. Tag *creation* lives in commit_ops.rs, next to the other
//! "act on this commit" operations the log's menu offers.
//!
//! Push/delete shell out through `run_git` for the same reasons as the rest of
//! the write operations (see commit_ops.rs); reading a tag's metadata goes
//! through git2, since there's no git output to parse and no hooks to respect.

use serde::Serialize;

use crate::error::Result;
use crate::repo::Repo;

/// What a tag is and what it points at, for the tag details dialog.
#[derive(Debug, Clone, Serialize)]
pub struct TagDetail {
    pub name: String,
    /// The commit the tag resolves to, peeled through an annotated tag.
    pub target: String,
    /// True for an annotated tag — its own object, carrying a tagger and a
    /// message. False for a lightweight tag, which is only a ref pointing at
    /// the commit, and therefore has neither.
    pub annotated: bool,
    pub tagger_name: Option<String>,
    pub tagger_email: Option<String>,
    /// Tagger time, seconds since the epoch.
    pub tagger_time: Option<i64>,
    pub message: Option<String>,
    /// The summary of the commit the tag points at, so the dialog can say what
    /// was tagged without a second lookup.
    pub target_summary: String,
}

impl Repo {
    /// Read tag `name`'s metadata. Works for both annotated and lightweight
    /// tags; the lightweight case simply has no tagger or message of its own.
    pub fn tag_detail(&self, name: &str) -> Result<TagDetail> {
        let obj = self.inner.revparse_single(&format!("refs/tags/{name}"))?;

        // An annotated tag is its own object wrapping the commit; a lightweight
        // tag resolves straight to the commit, and `as_tag` is None.
        let (annotated, tagger_name, tagger_email, tagger_time, message) = match obj.as_tag() {
            Some(tag) => {
                let tagger = tag.tagger();
                (
                    true,
                    tagger.as_ref().and_then(|t| t.name()).map(str::to_string),
                    tagger.as_ref().and_then(|t| t.email()).map(str::to_string),
                    tagger.as_ref().map(|t| t.when().seconds()),
                    tag.message().map(str::to_string),
                )
            }
            None => (false, None, None, None, None),
        };

        let commit = obj.peel_to_commit()?;
        Ok(TagDetail {
            name: name.to_string(),
            target: commit.id().to_string(),
            annotated,
            tagger_name,
            tagger_email,
            tagger_time,
            message,
            target_summary: commit.summary().unwrap_or_default().to_string(),
        })
    }

    /// Push tag `name` to `origin` (`git push origin <tag>`).
    pub fn push_tag(&self, name: &str) -> Result<String> {
        self.run_git(&["push", "origin", name])
    }

    /// Delete the local tag `name` (`git tag -d <name>`). Leaves any tag of the
    /// same name on the remote alone — see `delete_remote_tag`.
    pub fn delete_tag(&self, name: &str) -> Result<String> {
        self.run_git(&["tag", "-d", name])
    }

    /// Delete tag `name` on `origin` (`git push origin --delete <tag>`).
    pub fn delete_remote_tag(&self, name: &str) -> Result<String> {
        self.run_git(&["push", "origin", "--delete", name])
    }

    /// Whether `origin` has a tag called `name`, probed live with
    /// `git ls-remote`. Used to decide whether the delete dialog should offer to
    /// remove it from the remote too. A failure to reach the remote is reported
    /// as an error rather than a `false`, so the caller can tell "no such tag"
    /// apart from "couldn't ask".
    pub fn remote_tag_exists(&self, name: &str) -> Result<bool> {
        let out = self.run_git(&["ls-remote", "--tags", "origin", &format!("refs/tags/{name}")])?;
        Ok(!out.trim().is_empty())
    }
}
