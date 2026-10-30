//! Git operations that shell out to the system `git` binary: pull, push, and
//! stash. For the network operations (pull, push) this means the user's own
//! credentials — SSH agent, credential helper, git config — apply as-is,
//! instead of reimplementing libgit2 authentication (fragile for private
//! remotes); stash/pop go through the same helper for consistency.

use std::io::Write;
use std::process::Stdio;

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::git_bin::git_command;
use crate::repo::Repo;

/// Which strategy `pull` uses to reconcile local and remote history: plain
/// `git pull` (merges when it can't fast-forward), `--ff-only` (fails instead
/// of creating a merge commit), or `--rebase` (replays local commits onto the
/// updated upstream).
#[derive(Debug, Clone, Copy, Deserialize)]
pub enum PullMode {
    FastForward,
    FastForwardOnly,
    Rebase,
}

/// How [`Repo::pull`] integrates what it fetched, decided as `git pull` does.
enum Integrate {
    FastForwardOnly,
    Rebase { merges: bool },
    Merge(Option<&'static str>),
    Diverged,
}

impl PullMode {
    fn args(self) -> &'static [&'static str] {
        match self {
            PullMode::FastForward => &["pull"],
            PullMode::FastForwardOnly => &["pull", "--ff-only"],
            PullMode::Rebase => &["pull", "--rebase"],
        }
    }
}

impl Repo {
    /// `git pull` in the working directory, using `mode` to decide how to
    /// reconcile local and remote history. Returns git's combined output.
    ///
    /// Run as its two halves rather than one `git pull`, so Cancel can stop
    /// the network half and never the local one: a pull killed mid-merge or
    /// mid-rebase leaves a half-updated working tree and a stale `index.lock`.
    /// The fetch is exactly the one `git pull` runs (`git fetch`, the branch's
    /// remote, recording the merge candidate in FETCH_HEAD); the integration
    /// then follows `git pull`'s own rules for the mode and the repo's
    /// `pull.rebase` / `branch.<name>.rebase` / `pull.ff` config, through the
    /// same `git merge FETCH_HEAD` / `git rebase` it would run — so the
    /// merge message, conflicts and their wording all come out as before.
    pub fn pull(&self, mode: PullMode) -> Result<String> {
        let Some((branch, upstream)) = self.pull_upstream() else {
            // Detached HEAD, an unborn branch, no upstream, or one never
            // fetched: `git pull` has no single merge candidate and fails (or,
            // unborn, checks it out) with its own explanation, so let it.
            return self.run_git_network(mode.args());
        };
        let fetched = self.run_git_network(&["fetch"])?;
        let with_fetch = |out: String| format!("{fetched}\n{out}").trim().to_string();
        let Some(merge_head) = self.single_merge_head() else {
            // No candidate (the upstream branch is gone on the remote) or an
            // octopus of them: rare enough to hand to `git pull` as a whole.
            return self.run_git_network(mode.args());
        };

        let head = self.inner.head()?.peel_to_commit()?.id();
        let can_ff = head == merge_head || self.inner.graph_descendant_of(merge_head, head)?;
        let up_to_date = head == merge_head || self.inner.graph_descendant_of(head, merge_head)?;
        let config = |key: &str| {
            self.run_git(&["config", "--get", key])
                .ok()
                .map(|v| v.to_ascii_lowercase())
        };
        let rebase_config =
            config(&format!("branch.{branch}.rebase")).or_else(|| config("pull.rebase"));
        let ff_config = config("pull.ff");

        // git pull's precedence: --ff-only (or pull.ff=only, unless --rebase
        // was asked for explicitly) beats rebasing; --rebase beats config.
        let plan = match mode {
            PullMode::FastForwardOnly => Integrate::FastForwardOnly,
            PullMode::Rebase => Integrate::Rebase { merges: false },
            PullMode::FastForward => match (rebase_config.as_deref(), ff_config.as_deref()) {
                (_, Some("only")) => Integrate::FastForwardOnly,
                (Some("merges" | "m"), _) => Integrate::Rebase { merges: true },
                (Some(v), _) if !matches!(v, "false" | "no" | "off" | "0") => {
                    Integrate::Rebase { merges: false }
                }
                (None, None) if !can_ff && !up_to_date => Integrate::Diverged,
                (_, Some("false" | "no" | "off" | "0")) => Integrate::Merge(Some("--no-ff")),
                (_, Some(_)) => Integrate::Merge(Some("--ff")),
                (_, None) => Integrate::Merge(None),
            },
        };
        let phase = match plan {
            Integrate::Rebase { .. } if !can_ff => "Rebasing",
            Integrate::Merge(_) if !can_ff => "Merging",
            _ => "Fast-forwarding",
        };
        self.begin_local_step(phase)?;

        let out = match plan {
            Integrate::FastForwardOnly => self.run_git(&["merge", "--ff-only", "FETCH_HEAD"]),
            // Like git pull --rebase, a pull that can simply fast-forward does.
            Integrate::Rebase { .. } if can_ff => {
                self.run_git(&["merge", "--ff-only", "FETCH_HEAD"])
            }
            Integrate::Rebase { merges } => {
                let mut args = vec!["rebase"];
                if merges {
                    args.push("--rebase-merges");
                }
                // --fork-point against the upstream's remote-tracking ref is
                // how git pull --rebase avoids replaying commits that upstream
                // itself has since rewritten away.
                args.extend(["--onto", "FETCH_HEAD", "--fork-point", &upstream]);
                self.run_git(&args)
            }
            Integrate::Merge(flag) => {
                let mut args = vec!["merge"];
                args.extend(flag);
                args.push("FETCH_HEAD");
                self.run_git(&args)
            }
            // Diverged with no strategy configured: git refuses, with advice on
            // choosing one. A pull from this repo itself (no network) refuses
            // in exactly those words, whatever this git version's are.
            Integrate::Diverged => self.run_git(&["pull", "-q", ".", &upstream]),
        };
        match out {
            Ok(out) => Ok(with_fetch(out)),
            Err(Error::Message(m)) => Err(Error::Message(with_fetch(m))),
            Err(e) => Err(e),
        }
    }

    /// The current branch and the full name of its upstream's ref, when HEAD is
    /// on a born branch whose upstream resolves.
    fn pull_upstream(&self) -> Option<(String, String)> {
        self.inner.head().ok()?;
        let branch = self.current_branch_name().ok()?;
        let upstream = self
            .run_git(&["rev-parse", "--symbolic-full-name", "@{upstream}"])
            .ok()?;
        Some((branch, upstream))
    }

    /// The one commit the last fetch marked for merging (FETCH_HEAD's entries
    /// not tagged `not-for-merge`), if there is exactly one.
    fn single_merge_head(&self) -> Option<git2::Oid> {
        let fetch_head = std::fs::read_to_string(self.inner.path().join("FETCH_HEAD")).ok()?;
        let mut heads = fetch_head
            .lines()
            .filter(|l| !l.contains("\tnot-for-merge\t"))
            .filter_map(|l| l.split('\t').next())
            .filter(|oid| !oid.is_empty());
        let head = git2::Oid::from_str(heads.next()?).ok()?;
        heads.next().is_none().then_some(head)
    }

    /// Push the current branch. If it has no upstream yet, push with
    /// `-u origin <branch>` so the upstream is set on first push.
    pub fn push(&self) -> Result<String> {
        if self.has_upstream()? {
            self.run_git_network(&["push"])
        } else {
            let branch = self.current_branch_name()?;
            self.run_git_network(&["push", "-u", "origin", &branch])
        }
    }

    /// Force-push the current branch with `--force-with-lease`: it refuses
    /// instead of overwriting if the remote has commits this repo hasn't
    /// seen, so it can't clobber a teammate's push that landed since.
    ///
    /// That safety check compares against our remote-tracking ref, which is
    /// only as fresh as our last fetch — exactly what's stale for the "your
    /// branch is behind" case this exists for, so without an explicit fetch
    /// here `--force-with-lease` would refuse with "(stale info)" on almost
    /// every real use. Fetching immediately before narrows the actual race
    /// window (a concurrent push landing in between) down to a few
    /// milliseconds, which is the same window every other force-push tool
    /// (GitKraken, Fork, `gh`) accepts.
    pub fn push_force(&self) -> Result<String> {
        let fetched = self.run_git_network(&["fetch"])?;
        let pushed = self.run_git_network(&["push", "--force-with-lease"])?;
        Ok(format!("{fetched}\n{pushed}").trim().to_string())
    }

    /// Stage `path` (`git add`), handling new, modified, and deleted files.
    pub fn stage(&self, path: &str) -> Result<()> {
        self.run_git(&["add", "--", &literal_pathspec(path)])
            .map(|_| ())
    }

    /// Unstage `path` (`git reset -- <path>`). No explicit `HEAD`: git defaults
    /// to it, and naming it fails on an unborn branch where there is no HEAD
    /// commit to resolve yet.
    pub fn unstage(&self, path: &str) -> Result<()> {
        self.run_git(&["reset", "-q", "--", &literal_pathspec(path)])
            .map(|_| ())
    }

    /// Stage every change, including untracked and deletions (`git add -A`).
    pub fn stage_all(&self) -> Result<()> {
        self.run_git(&["add", "-A"]).map(|_| ())
    }

    /// Unstage everything (`git reset`; see [`Repo::unstage`] for why no `HEAD`).
    pub fn unstage_all(&self) -> Result<()> {
        self.run_git(&["reset", "-q"]).map(|_| ())
    }

    /// Commit the staged changes. `body` is added as a second paragraph when
    /// non-empty; `amend` rewrites HEAD instead of adding a new commit. `sign`
    /// forces signing on (`-S`) or off (`--no-gpg-sign`); `None` leaves it to
    /// `commit.gpgsign`. Signing runs git's configured gpg / ssh-keygen, so a
    /// missing key or a cancelled pinentry fails the commit with git's error.
    pub fn commit(
        &self,
        subject: &str,
        body: &str,
        amend: bool,
        sign: Option<bool>,
    ) -> Result<String> {
        let mut args: Vec<&str> = vec!["commit", "-m", subject];
        let body = body.trim();
        if !body.is_empty() {
            args.push("-m");
            args.push(body);
        }
        if amend {
            args.push("--amend");
        }
        match sign {
            Some(true) => args.push("-S"),
            Some(false) => args.push("--no-gpg-sign"),
            None => {}
        }
        self.run_git(&args)
    }

    /// `git stash --include-untracked` — save local modifications *and* new
    /// untracked files away, reverting the working tree to HEAD. Untracked files
    /// are included so it matches what "Local Changes" shows (git's plain
    /// `stash` would ignore them and do nothing when only new files exist).
    /// Returns git's output (including "No local changes to save").
    pub fn stash(&self) -> Result<String> {
        self.run_git(&["stash", "--include-untracked"])
    }

    /// `git stash pop` — reapply the most recent stash and drop it. Errors if
    /// there are no stash entries.
    pub fn stash_pop(&self) -> Result<String> {
        self.run_git(&["stash", "pop"])
    }

    /// Short name of the checked-out branch, or an error if HEAD is detached.
    fn current_branch_name(&self) -> Result<String> {
        // `shorthand()` of a detached HEAD is the literal "HEAD", which would
        // otherwise be looked up as a branch and fail with a confusing message.
        if self.inner.head_detached()? {
            return Err(Error::Message("HEAD is not on a branch".into()));
        }
        let head = self.inner.head()?;
        head.shorthand()
            .map(str::to_string)
            .ok_or_else(|| Error::Message("HEAD is not on a branch".into()))
    }

    /// Whether the current branch has an upstream configured.
    fn has_upstream(&self) -> Result<bool> {
        let name = self.current_branch_name()?;
        let branch = self.inner.find_branch(&name, git2::BranchType::Local)?;
        Ok(branch.upstream().is_ok())
    }

    /// Run `git <args>` in the repo's working directory with interactive
    /// credential prompts disabled, so a missing credential fails fast with a
    /// clear message instead of hanging a GUI that has no TTY. On success
    /// returns the trimmed combined output; on failure returns it as an error.
    pub(crate) fn run_git(&self, args: &[&str]) -> Result<String> {
        let workdir = self
            .inner
            .workdir()
            .ok_or_else(|| Error::Message("repository has no working directory".into()))?;
        let output = git_command()
            .current_dir(workdir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(args)
            .output()
            .map_err(|e| Error::Message(format!("failed to run git: {e}")))?;

        let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
        combined.push_str(&String::from_utf8_lossy(&output.stderr));
        let combined = combined.trim().to_string();

        if output.status.success() {
            Ok(combined)
        } else {
            Err(Error::Message(combined))
        }
    }

    /// Run `git <args>` and return its raw, untrimmed stdout bytes — for
    /// machine-readable output like `status --porcelain -z`, where leading
    /// spaces (the index/worktree status columns) and NUL separators are
    /// significant and must not be stripped.
    pub(crate) fn run_git_raw(&self, args: &[&str]) -> Result<Vec<u8>> {
        let workdir = self
            .inner
            .workdir()
            .ok_or_else(|| Error::Message("repository has no working directory".into()))?;
        let output = git_command()
            .current_dir(workdir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(args)
            .output()
            .map_err(|e| Error::Message(format!("failed to run git: {e}")))?;
        if output.status.success() {
            Ok(output.stdout)
        } else {
            Err(Error::Message(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ))
        }
    }

    /// Like `run_git`, but pipes `input` to the command's stdin — for
    /// `git apply`, which reads a patch from stdin. Returns the trimmed combined
    /// output on success, or it as an error on a non-zero exit.
    pub(crate) fn run_git_stdin(&self, args: &[&str], input: &str) -> Result<String> {
        let workdir = self
            .inner
            .workdir()
            .ok_or_else(|| Error::Message("repository has no working directory".into()))?;
        let mut child = git_command()
            .current_dir(workdir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| Error::Message(format!("failed to run git: {e}")))?;

        child
            .stdin
            .take()
            .ok_or_else(|| Error::Message("failed to open git stdin".into()))?
            .write_all(input.as_bytes())
            .map_err(|e| Error::Message(format!("failed to write patch to git: {e}")))?;

        let output = child
            .wait_with_output()
            .map_err(|e| Error::Message(format!("failed to run git: {e}")))?;

        let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
        combined.push_str(&String::from_utf8_lossy(&output.stderr));
        let combined = combined.trim().to_string();

        if output.status.success() {
            Ok(combined)
        } else {
            Err(Error::Message(combined))
        }
    }
}

/// Turn an exact file path into a pathspec git won't glob-expand. A bare path
/// is a pattern — `a[1].txt` also matches `a1.txt` — so every user-chosen path
/// handed to git as a pathspec goes through here. It is deliberately per-path
/// rather than `GIT_LITERAL_PATHSPECS=1` on the whole command: that env var
/// also disables the `:/` magic `git stash -u` uses internally to sweep
/// untracked files, silently breaking stash.
pub(crate) fn literal_pathspec(path: &str) -> String {
    format!(":(literal){path}")
}

/// Refuse a user-chosen branch, tag or revision that git would read as an
/// option. These go to git positionally (`git merge <name>`, `git rebase
/// <rev>`), where a `--` can't always shield them — for `checkout` it would
/// turn the name into a pathspec — and a hostile remote can hand out a branch
/// called `--exec=…`, which a rebase onto it would run. Git itself refuses to
/// create names that start with a dash, so nothing legitimate is lost.
pub(crate) fn ref_arg(name: &str) -> Result<&str> {
    if name.starts_with('-') {
        return Err(Error::Message(format!(
            "refusing to pass {name:?} to git: it would be read as an option"
        )));
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::ref_arg;

    #[test]
    fn ref_arg_passes_names_and_refuses_options() {
        assert_eq!(ref_arg("main").unwrap(), "main");
        assert_eq!(ref_arg("feature/x-1").unwrap(), "feature/x-1");
        assert_eq!(ref_arg("origin/main").unwrap(), "origin/main");
        assert!(ref_arg("-x").is_err());
        assert!(ref_arg("--exec=touch pwned").is_err());
    }
}
