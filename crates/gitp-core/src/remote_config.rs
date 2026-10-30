//! The repository's configured remotes, managed from the sidebar's Remotes
//! section: list them with their URLs, add one, change its URL, rename, and
//! remove.
//!
//! The changes shell out to `git remote` rather than editing config through
//! git2: a rename or a remove also has to move or delete the remote-tracking
//! refs and rewrite every `branch.<name>.remote` that names it, which `git
//! remote` does as one operation. Listing is a plain config read, via git2.

use serde::Serialize;

use crate::error::Result;
use crate::remote::ref_arg;
use crate::repo::Repo;

/// A configured remote and where it points.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteInfo {
    pub name: String,
    /// The fetch URL; `None` for a remote configured without one.
    pub url: Option<String>,
}

impl Repo {
    /// Every configured remote, by name — including ones never fetched, which
    /// have no remote-tracking branches to be discovered from.
    pub fn list_remotes(&self) -> Result<Vec<RemoteInfo>> {
        let mut remotes: Vec<RemoteInfo> = self
            .inner
            .remotes()?
            .iter()
            .flatten()
            .map(|name| RemoteInfo {
                name: name.to_string(),
                url: self
                    .inner
                    .find_remote(name)
                    .ok()
                    .and_then(|r| r.url().map(str::to_string)),
            })
            .collect();
        remotes.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(remotes)
    }

    /// Add remote `name` at `url` (`git remote add`). Doesn't fetch it.
    ///
    /// Both go to git positionally, so both are refused when they start with a
    /// dash: a pasted "URL" like `--mirror=fetch` would otherwise be read as
    /// an option.
    pub fn add_remote(&self, name: &str, url: &str) -> Result<String> {
        self.run_git(&["remote", "add", ref_arg(name)?, ref_arg(url)?])
    }

    /// Point remote `name` at `url` (`git remote set-url`).
    pub fn set_remote_url(&self, name: &str, url: &str) -> Result<String> {
        self.run_git(&["remote", "set-url", ref_arg(name)?, ref_arg(url)?])
    }

    /// Rename remote `old` to `new` (`git remote rename`), moving its
    /// remote-tracking branches and the branches that track them along.
    pub fn rename_remote(&self, old: &str, new: &str) -> Result<String> {
        self.run_git(&["remote", "rename", ref_arg(old)?, ref_arg(new)?])
    }

    /// Remove remote `name` (`git remote remove`), with its remote-tracking
    /// branches and the upstream settings that name it. Nothing on the remote
    /// itself is touched.
    pub fn remove_remote(&self, name: &str) -> Result<String> {
        self.run_git(&["remote", "remove", ref_arg(name)?])
    }
}
