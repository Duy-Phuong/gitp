//! Branch-scoped operations invoked from the sidebar's right-click menu:
//! rename, delete, merge (plain, no-ff, ff-only, squash), push, and
//! fast-forward. All shell out through
//! `run_git` so git's own conflict handling, hooks, and messages apply as-is.
//!
//! Checkout, branch/tag creation, and rebase already live elsewhere
//! (`checkout.rs`, `commit_ops.rs`) and are reused by the menu as-is.

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::remote::ref_arg;
use crate::repo::Repo;

/// How `merge_branch` combines the other branch: git's default (fast-forward
/// when it can, else a merge commit), always a merge commit (`--no-ff`), only
/// a fast-forward (`--ff-only`), or `--squash` — the combined changes staged
/// for one ordinary commit, with no merge recorded.
#[derive(Debug, Clone, Copy, Deserialize)]
pub enum MergeMode {
    Default,
    NoFastForward,
    FastForwardOnly,
    Squash,
}

impl MergeMode {
    fn flag(self) -> Option<&'static str> {
        match self {
            MergeMode::Default => None,
            MergeMode::NoFastForward => Some("--no-ff"),
            MergeMode::FastForwardOnly => Some("--ff-only"),
            MergeMode::Squash => Some("--squash"),
        }
    }
}

impl Repo {
    /// Rename branch `old` to `new` (`git branch -m`). Works on the current
    /// branch too. Errors if `new` already exists.
    pub fn rename_branch(&self, old: &str, new: &str) -> Result<String> {
        self.run_git(&["branch", "-m", ref_arg(old)?, ref_arg(new)?])
    }

    /// Create branch `name` at the current HEAD *without* checking it out
    /// (`git branch <name>`). Used to snapshot state before a rewrite like a
    /// rebase. Errors if `name` already exists.
    pub fn create_branch_here(&self, name: &str) -> Result<String> {
        self.run_git(&["branch", ref_arg(name)?])
    }

    /// Rename branch `new`'s counterpart on the remote, run *after* the local
    /// rename (so `new` already tracks the old remote branch). Git has no direct
    /// remote-rename, so this pushes `new` (updating its upstream) and then
    /// deletes the old remote branch. No-op-ish when the remote name is unchanged.
    pub fn rename_remote_branch(&self, new: &str) -> Result<String> {
        let new = ref_arg(new)?;
        let (remote, old_remote) = self.remote_target(new);
        let pushed = self.run_git_network(&["push", "-u", &remote, new])?;
        if old_remote != new {
            self.run_git_network(&["push", &remote, "--delete", &old_remote])?;
        }
        Ok(format!(
            "{pushed}\nrenamed {remote}/{old_remote} -> {remote}/{new}"
        ))
    }

    /// Set `branch`'s upstream (tracking) to `upstream`, e.g. `origin/main`.
    pub fn set_upstream(&self, branch: &str, upstream: &str) -> Result<String> {
        self.run_git(&[
            "branch",
            &format!("--set-upstream-to={upstream}"),
            ref_arg(branch)?,
        ])
    }

    /// Clear `branch`'s upstream (stop tracking).
    pub fn unset_upstream(&self, branch: &str) -> Result<String> {
        self.run_git(&["branch", "--unset-upstream", ref_arg(branch)?])
    }

    /// The web URL for opening a pull/merge request for `branch` on `remote`,
    /// or by default the remote it tracks (else `origin`), derived from the
    /// remote URL. Recognizes GitHub, GitLab, and Bitbucket; falls back to a
    /// GitHub-style compare URL for other hosts.
    pub fn pull_request_url(&self, branch: &str, remote: Option<&str>) -> Result<String> {
        // The request is for the branch as the remote knows it, which can be
        // named differently from the local one.
        let (tracked, branch) = self.remote_target(branch);
        let remote_name = remote.map_or(tracked, str::to_string);
        let branch = branch.as_str();
        let remote = self
            .inner
            .find_remote(&remote_name)
            .map_err(|_| Error::Message(format!("no '{remote_name}' remote configured")))?;
        let url = remote
            .url()
            .ok_or_else(|| Error::Message(format!("'{remote_name}' has no URL")))?;
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
        self.run_git(&["branch", flag, ref_arg(name)?])
    }

    /// Delete branch `name` on its remote (`git push <remote> --delete`). Uses
    /// the branch's configured remote and its remote-side name when known,
    /// falling back to `origin` and the same name. This affects the remote.
    pub fn delete_remote_branch(&self, name: &str) -> Result<String> {
        let (remote, remote_branch) = self.remote_target(ref_arg(name)?);
        self.run_git_network(&["push", &remote, "--delete", &remote_branch])
    }

    /// Whether branch `name` currently exists on its remote, queried live with
    /// `git ls-remote` (contacts the remote). Returns the display label
    /// `<remote>/<branch>` when present, `None` when absent. An error (no remote,
    /// unreachable) propagates so the caller can treat it as "can't confirm".
    pub fn remote_branch_exists(&self, name: &str) -> Result<Option<String>> {
        let (remote, remote_branch) = self.remote_target(name);
        // Ask for the full ref: a bare pattern matches by ref tail, so `foo`
        // would also be "found" when only `bar/foo` exists on the remote.
        let full_ref = format!("refs/heads/{remote_branch}");
        let out = self.run_git(&["ls-remote", "--heads", &remote, &full_ref])?;
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

    /// Merge `name` into the current branch (`git merge`, with `mode`'s flag).
    /// Conflicts leave the merge in progress and surface as an error. A squash
    /// commits nothing: the result is staged, and its prepared message is in
    /// `squash_message`.
    pub fn merge_branch(&self, name: &str, mode: MergeMode) -> Result<String> {
        let mut args = vec!["merge"];
        args.extend(mode.flag());
        args.push(ref_arg(name)?);
        self.run_git(&args)
    }

    /// The commit message `git merge --squash` prepared (`.git/SQUASH_MSG`),
    /// or `None` when no squash is waiting to be committed. Comment lines are
    /// dropped, as `git commit` would. git deletes the file once a commit is
    /// made, so a stale one never outlives the squash it belongs to.
    pub fn squash_message(&self) -> Option<String> {
        let raw = std::fs::read_to_string(self.inner.path().join("SQUASH_MSG")).ok()?;
        let message: Vec<&str> = raw.lines().filter(|l| !l.starts_with('#')).collect();
        Some(message.join("\n").trim().to_string())
    }

    /// Push branch `name` to `remote` (`git push <remote> <name>`), or — when
    /// none is given — to the remote it tracks, else `origin`.
    pub fn push_branch(&self, name: &str, remote: Option<&str>) -> Result<String> {
        let name = ref_arg(name)?;
        let remote = match remote {
            Some(remote) => remote.to_string(),
            None => self.remote_target(name).0,
        };
        self.run_git_network(&["push", ref_arg(&remote)?, name])
    }

    /// Push local branch `name` to branch `remote_branch` on `remote`, which
    /// may have a different name (`git push <remote> <name>:refs/heads/<b>`).
    /// A plain push, so git refuses one that isn't a fast-forward there.
    pub fn push_branch_to(&self, name: &str, remote: &str, remote_branch: &str) -> Result<String> {
        let refspec = format!("{}:refs/heads/{}", ref_arg(name)?, ref_arg(remote_branch)?);
        self.run_git_network(&["push", ref_arg(remote)?, &refspec])
    }

    /// Fetch updates for `name`'s remote (its configured remote, or all remotes
    /// if it tracks none), updating the remote-tracking refs so the branch's
    /// ahead/behind counts reflect new upstream commits. Doesn't touch the
    /// working tree or any local branch.
    pub fn fetch_branch(&self, name: &str) -> Result<String> {
        match self.run_git(&["config", &format!("branch.{name}.remote")]) {
            Ok(remote) if !remote.is_empty() => {
                self.run_git_network(&["fetch", "--prune", &remote])
            }
            _ => self.run_git_network(&["fetch", "--all", "--prune"]),
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
        self.run_git_network(&["fetch", "--all", "--prune"])
    }

    /// Fetch a single named remote (`git fetch --prune <remote>`), for when the
    /// repo has several and only one is worth waiting for.
    pub fn fetch_remote(&self, remote: &str) -> Result<String> {
        self.run_git_network(&["fetch", "--prune", remote])
    }

    /// Fetch `name`'s remote and then advance the local branch to its upstream —
    /// i.e. fetch + fast-forward. Only advances when it's a true fast-forward
    /// (no divergence), so no merge commit is ever created and nothing is lost;
    /// a diverged branch surfaces git's fast-forward error to resolve manually.
    pub fn fetch_and_update_branch(&self, name: &str) -> Result<String> {
        let fetched = self.fetch_branch(name)?;
        self.begin_local_step("Fast-forwarding")?;
        let updated = self.fast_forward_branch(name)?;
        Ok(format!("{fetched}\n{updated}").trim().to_string())
    }

    /// Fast-forward branch `name` to its configured upstream. The current branch
    /// is advanced with `merge --ff-only`; another branch is advanced by a local
    /// fetch into it, which git only allows when it's a true fast-forward.
    pub fn fast_forward_branch(&self, name: &str) -> Result<String> {
        let name = ref_arg(name)?;
        let upstream =
            self.run_git(&["rev-parse", "--abbrev-ref", &format!("{name}@{{upstream}}")])?;
        self.fast_forward_branch_to(name, &upstream)
    }

    /// Fast-forward local branch `name` to `to` (a branch or remote-tracking
    /// branch), the same way `fast_forward_branch` advances to the upstream:
    /// refused unless `name` is an ancestor of `to`.
    pub fn fast_forward_branch_to(&self, name: &str, to: &str) -> Result<String> {
        let name = ref_arg(name)?;
        let to = ref_arg(to)?;
        let current = self
            .inner
            .head()
            .ok()
            .and_then(|h| h.shorthand().map(str::to_string));
        if current.as_deref() == Some(name) {
            self.run_git(&["merge", "--ff-only", to])
        } else {
            self.run_git(&["fetch", ".", &format!("{to}:{name}")])
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
