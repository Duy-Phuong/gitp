//! Branch-scoped operations invoked from the sidebar's right-click menu:
//! rename, delete, merge, push, and fast-forward. All shell out through
//! `run_git` so git's own conflict handling, hooks, and messages apply as-is.
//!
//! Checkout, branch/tag creation, and rebase already live elsewhere
//! (`checkout.rs`, `commit_ops.rs`) and are reused by the menu as-is.

use crate::error::{Error, Result};
use crate::repo::Repo;

impl Repo {
    /// Rename branch `old` to `new` (`git branch -m`). Works on the current
    /// branch too. Errors if `new` already exists.
    pub fn rename_branch(&self, old: &str, new: &str) -> Result<String> {
        self.run_git(&["branch", "-m", old, new])
    }

    /// Set `branch`'s upstream (tracking) to `upstream`, e.g. `origin/main`.
    pub fn set_upstream(&self, branch: &str, upstream: &str) -> Result<String> {
        self.run_git(&["branch", &format!("--set-upstream-to={upstream}"), branch])
    }

    /// Clear `branch`'s upstream (stop tracking).
    pub fn unset_upstream(&self, branch: &str) -> Result<String> {
        self.run_git(&["branch", "--unset-upstream", branch])
    }

    /// The web URL for opening a pull/merge request for `branch` on `origin`,
    /// derived from the remote URL. Recognizes GitHub, GitLab, and Bitbucket;
    /// falls back to a GitHub-style compare URL for other hosts.
    pub fn pull_request_url(&self, branch: &str) -> Result<String> {
        let remote = self
            .inner
            .find_remote("origin")
            .map_err(|_| Error::Message("no 'origin' remote configured".into()))?;
        let url = remote
            .url()
            .ok_or_else(|| Error::Message("'origin' has no URL".into()))?;
        let (host, base) = parse_remote_url(url)
            .ok_or_else(|| Error::Message(format!("can't parse remote URL: {url}")))?;
        let enc = encode_query(branch);
        let pr = if host.contains("github") {
            format!("{base}/pull/new/{branch}")
        } else if host.contains("gitlab") {
            format!("{base}/-/merge_requests/new?merge_request%5Bsource_branch%5D={enc}")
        } else if host.contains("bitbucket") {
            format!("{base}/pull-requests/new?source={enc}")
        } else {
            format!("{base}/compare/{branch}")
        };
        Ok(pr)
    }

    /// Delete branch `name`. `force` uses `-D` (delete even if unmerged);
    /// otherwise `-d`, which refuses to drop unmerged work.
    pub fn delete_branch(&self, name: &str, force: bool) -> Result<String> {
        let flag = if force { "-D" } else { "-d" };
        self.run_git(&["branch", flag, name])
    }

    /// Merge `name` into the current branch (`git merge`). Conflicts leave the
    /// merge in progress and surface as an error.
    pub fn merge_branch(&self, name: &str) -> Result<String> {
        self.run_git(&["merge", name])
    }

    /// Push branch `name` to `origin` (`git push origin <name>`).
    pub fn push_branch(&self, name: &str) -> Result<String> {
        self.run_git(&["push", "origin", name])
    }

    /// Fast-forward branch `name` to its configured upstream. The current branch
    /// is advanced with `merge --ff-only`; another branch is advanced by a local
    /// fetch into it, which git only allows when it's a true fast-forward.
    pub fn fast_forward_branch(&self, name: &str) -> Result<String> {
        let upstream = self
            .run_git(&["rev-parse", "--abbrev-ref", &format!("{name}@{{upstream}}")])?;
        let current = self
            .inner
            .head()
            .ok()
            .and_then(|h| h.shorthand().map(str::to_string));
        if current.as_deref() == Some(name) {
            self.run_git(&["merge", "--ff-only", &upstream])
        } else {
            self.run_git(&["fetch", ".", &format!("{upstream}:{name}")])
        }
    }
}

/// Turn a git remote URL into `(host, https_base)`, handling scp-style
/// (`git@host:owner/repo.git`) and URL forms (`https://`, `ssh://`, `git://`).
/// The base has no `.git` suffix and no trailing slash.
fn parse_remote_url(url: &str) -> Option<(String, String)> {
    let u = url.trim().strip_suffix(".git").unwrap_or(url.trim());

    // scp-like: [user@]host:owner/repo
    if !u.contains("://") {
        if let Some((left, path)) = u.split_once(':') {
            let host = left.rsplit('@').next().unwrap_or(left);
            if !host.is_empty() && !path.is_empty() {
                return Some((host.to_string(), format!("https://{host}/{path}")));
            }
        }
    }

    // scheme://[user@]host[:port]/owner/repo
    for scheme in ["ssh://", "https://", "http://", "git://"] {
        if let Some(rest) = u.strip_prefix(scheme) {
            let (authority, path) = rest.split_once('/')?;
            let host_port = authority.rsplit('@').next().unwrap_or(authority);
            let host = host_port.split(':').next().unwrap_or(host_port);
            if !host.is_empty() && !path.is_empty() {
                return Some((host.to_string(), format!("https://{host}/{path}")));
            }
        }
    }
    None
}

/// Percent-encode a branch name for use in a URL query value.
fn encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::parse_remote_url;

    #[test]
    fn parses_common_remote_url_forms() {
        let cases = [
            "git@github.com:acme/app.git",
            "https://github.com/acme/app.git",
            "ssh://git@github.com/acme/app.git",
        ];
        for c in cases {
            let (host, base) = parse_remote_url(c).unwrap_or_else(|| panic!("parse {c}"));
            assert_eq!(host, "github.com");
            assert_eq!(base, "https://github.com/acme/app");
        }
    }
}
