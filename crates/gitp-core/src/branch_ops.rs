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

    /// Create branch `name` at the current HEAD *without* checking it out
    /// (`git branch <name>`). Used to snapshot state before a rewrite like a
    /// rebase. Errors if `name` already exists.
    pub fn create_branch_here(&self, name: &str) -> Result<String> {
        self.run_git(&["branch", name])
    }

    /// Rename branch `new`'s counterpart on the remote, run *after* the local
    /// rename (so `new` already tracks the old remote branch). Git has no direct
    /// remote-rename, so this pushes `new` (updating its upstream) and then
    /// deletes the old remote branch. No-op-ish when the remote name is unchanged.
    pub fn rename_remote_branch(&self, new: &str) -> Result<String> {
        let (remote, old_remote) = self.remote_target(new);
        let pushed = self.run_git(&["push", "-u", &remote, new])?;
        if old_remote != new {
            self.run_git(&["push", &remote, "--delete", &old_remote])?;
        }
        Ok(format!("{pushed}\nrenamed {remote}/{old_remote} -> {remote}/{new}"))
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

    /// Delete branch `name` on its remote (`git push <remote> --delete`). Uses
    /// the branch's configured remote and its remote-side name when known,
    /// falling back to `origin` and the same name. This affects the remote.
    pub fn delete_remote_branch(&self, name: &str) -> Result<String> {
        let (remote, remote_branch) = self.remote_target(name);
        self.run_git(&["push", &remote, "--delete", &remote_branch])
    }

    /// Whether branch `name` currently exists on its remote, queried live with
    /// `git ls-remote` (contacts the remote). Returns the display label
    /// `<remote>/<branch>` when present, `None` when absent. An error (no remote,
    /// unreachable) propagates so the caller can treat it as "can't confirm".
    pub fn remote_branch_exists(&self, name: &str) -> Result<Option<String>> {
        let (remote, remote_branch) = self.remote_target(name);
        let out = self.run_git(&["ls-remote", "--heads", &remote, &remote_branch])?;
        Ok(if out.trim().is_empty() {
            None
        } else {
            Some(format!("{remote}/{remote_branch}"))
        })
    }

    /// Resolve the remote and remote-side branch name for `name`: its configured
    /// upstream when set, else `origin` and the same branch name.
    fn remote_target(&self, name: &str) -> (String, String) {
        let remote = match self.run_git(&["config", &format!("branch.{name}.remote")]) {
            Ok(r) if !r.is_empty() => r,
            _ => "origin".to_string(),
        };
        let remote_branch = self
            .run_git(&["config", &format!("branch.{name}.merge")])
            .ok()
            .and_then(|m| m.trim().strip_prefix("refs/heads/").map(str::to_string))
            .unwrap_or_else(|| name.to_string());
        (remote, remote_branch)
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

    /// Fetch updates for `name`'s remote (its configured remote, or all remotes
    /// if it tracks none), updating the remote-tracking refs so the branch's
    /// ahead/behind counts reflect new upstream commits. Doesn't touch the
    /// working tree or any local branch.
    pub fn fetch_branch(&self, name: &str) -> Result<String> {
        match self.run_git(&["config", &format!("branch.{name}.remote")]) {
            Ok(remote) if !remote.is_empty() => self.run_git(&["fetch", "--prune", &remote]),
            _ => self.run_git(&["fetch", "--all", "--prune"]),
        }
    }

    /// The upstream a local branch tracks, e.g. `origin/main`, or `None` when it
    /// has none (never pushed) or the tracking ref no longer exists.
    pub fn branch_upstream(&self, name: &str) -> Result<Option<String>> {
        let branch = self.inner.find_branch(name, git2::BranchType::Local)?;
        Ok(branch
            .upstream()
            .ok()
            .and_then(|up| up.name().ok().flatten().map(str::to_string)))
    }

    /// Local branches whose configured upstream no longer exists — the ones
    /// `git branch -vv` marks `[gone]`, typically because their pull request
    /// was merged and the remote branch deleted.
    ///
    /// Read from `for-each-ref` rather than by grepping `git branch -vv`: the
    /// track field is machine-readable and stable, whereas the `-vv` line is
    /// display output whose layout depends on branch-name width and whose
    /// `: gone]` marker also appears inside commit subjects.
    ///
    /// A branch with no upstream configured at all is *not* gone — it was never
    /// pushed — so it is never reported here. Neither is the current branch,
    /// which cannot be deleted anyway.
    pub fn gone_branches(&self) -> Result<Vec<String>> {
        let head = self
            .inner
            .head()
            .ok()
            .filter(|h| h.is_branch())
            .and_then(|h| h.shorthand().map(str::to_string));

        let raw = self.run_git(&[
            "for-each-ref",
            // Tab-separated: git refuses tabs in ref names, so it can't collide.
            "--format=%(refname:short)%09%(upstream)%09%(upstream:track)",
            "refs/heads",
        ])?;

        let mut gone = Vec::new();
        for line in raw.lines() {
            let mut fields = line.split('\t');
            let (Some(name), Some(upstream), Some(track)) =
                (fields.next(), fields.next(), fields.next())
            else {
                continue;
            };
            // No upstream configured → never pushed, not gone.
            if upstream.is_empty() || track.trim() != "[gone]" {
                continue;
            }
            if Some(name) == head.as_deref() {
                continue;
            }
            gone.push(name.to_string());
        }
        Ok(gone)
    }

    /// Fetch every remote (`git fetch --all --prune`), refreshing all
    /// remote-tracking refs so every branch's ahead/behind reflects the remote.
    /// Doesn't touch the working tree or any local branch.
    pub fn fetch_all(&self) -> Result<String> {
        self.run_git(&["fetch", "--all", "--prune"])
    }

    /// Fetch a single named remote (`git fetch --prune <remote>`), for when the
    /// repo has several and only one is worth waiting for.
    pub fn fetch_remote(&self, remote: &str) -> Result<String> {
        self.run_git(&["fetch", "--prune", remote])
    }

    /// Fetch `name`'s remote and then advance the local branch to its upstream —
    /// i.e. fetch + fast-forward. Only advances when it's a true fast-forward
    /// (no divergence), so no merge commit is ever created and nothing is lost;
    /// a diverged branch surfaces git's fast-forward error to resolve manually.
    pub fn fetch_and_update_branch(&self, name: &str) -> Result<String> {
        let fetched = self.fetch_branch(name)?;
        let updated = self.fast_forward_branch(name)?;
        Ok(format!("{fetched}\n{updated}").trim().to_string())
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
