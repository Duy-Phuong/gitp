//! Network operations (pull, push) implemented by shelling out to the system
//! `git` binary. Running the user's own `git` means their existing credentials
//! — SSH agent, credential helper, git config — apply as-is, instead of
//! reimplementing libgit2 authentication (which is fragile for private remotes).

use std::process::Command;

use crate::error::{Error, Result};
use crate::repo::Repo;

impl Repo {
    /// `git pull` in the working directory, honoring the user's pull config
    /// (merge vs rebase, fast-forward). Returns git's combined output.
    pub fn pull(&self) -> Result<String> {
        self.run_git(&["pull"])
    }

    /// Push the current branch. If it has no upstream yet, push with
    /// `-u origin <branch>` so the upstream is set on first push.
    pub fn push(&self) -> Result<String> {
        if self.has_upstream()? {
            self.run_git(&["push"])
        } else {
            let branch = self.current_branch_name()?;
            self.run_git(&["push", "-u", "origin", &branch])
        }
    }

    /// Short name of the checked-out branch, or an error if HEAD is detached.
    fn current_branch_name(&self) -> Result<String> {
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
    fn run_git(&self, args: &[&str]) -> Result<String> {
        let workdir = self
            .inner
            .workdir()
            .ok_or_else(|| Error::Message("repository has no working directory".into()))?;
        let output = Command::new("git")
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
}
