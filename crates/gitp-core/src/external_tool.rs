//! Handing a file to the user's own tools: `git difftool` / `git mergetool`
//! with whatever `diff.tool` / `merge.tool` they configured (Beyond Compare,
//! Kaleidoscope, P4Merge…). git does the launching, so every tool git knows,
//! and any `difftool.<name>.cmd`, works without gitp knowing about it.

use std::io::Read;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::git_bin::git_command;
use crate::remote::ref_arg;
use crate::repo::Repo;

/// What the diff tool compares.
#[derive(Debug, Clone, Deserialize)]
pub enum DiffToolTarget {
    /// A commit against its first parent (the empty tree for a root commit).
    Commit(String),
    /// Two revisions; three-dot compares from their merge base to `head`.
    Compare {
        base: String,
        head: String,
        three_dot: bool,
    },
    /// The index against HEAD.
    Staged,
    /// The working tree against the index.
    Unstaged,
}

/// How long to watch a launched tool for an early failure (a tool that isn't
/// installed, a bad path) before leaving it running on its own.
const LAUNCH_GRACE: Duration = Duration::from_millis(1500);

impl Repo {
    /// Open `paths` of `target` in the configured diff tool (`git difftool
    /// --no-prompt`) without waiting for it to close. `Ok(false)` when no tool
    /// is configured: git would then guess one, often a terminal tool such as
    /// vimdiff, which has no terminal to run in here.
    pub fn open_difftool(&self, target: &DiffToolTarget, paths: &[String]) -> Result<bool> {
        // difftool falls back to merge.tool when diff.tool isn't set.
        if self.config_value("diff.tool").is_none() && self.config_value("merge.tool").is_none() {
            return Ok(false);
        }
        let mut args: Vec<String> = vec!["difftool".into(), "--no-prompt".into()];
        match target {
            DiffToolTarget::Commit(rev) => {
                let commit = self.inner.revparse_single(rev)?.peel_to_commit()?;
                let parent = match commit.parent_id(0) {
                    Ok(id) => id,
                    // git knows the empty tree without it being stored.
                    Err(_) => git2::Oid::hash_object(git2::ObjectType::Tree, &[])?,
                };
                args.push(parent.to_string());
                args.push(commit.id().to_string());
            }
            DiffToolTarget::Compare {
                base,
                head,
                three_dot,
            } => {
                let (base, head) = (ref_arg(base)?, ref_arg(head)?);
                if *three_dot {
                    args.push(format!("{base}...{head}"));
                } else {
                    args.push(base.into());
                    args.push(head.into());
                }
            }
            DiffToolTarget::Staged => args.push("--cached".into()),
            DiffToolTarget::Unstaged => {}
        }
        args.push("--".into());
        args.extend(paths.iter().cloned());
        self.launch_git(&args)?;
        Ok(true)
    }

    /// Open the conflicted `path` in the configured merge tool (`git mergetool
    /// --no-prompt`), which marks it resolved when the tool reports success.
    /// `Ok(false)` when `merge.tool` isn't set, for the same reason as
    /// `open_difftool`.
    pub fn open_mergetool(&self, path: &str) -> Result<bool> {
        if self.config_value("merge.tool").is_none() {
            return Ok(false);
        }
        self.launch_git(&[
            "mergetool".into(),
            "--no-prompt".into(),
            "--".into(),
            path.into(),
        ])?;
        Ok(true)
    }

    /// A config value as the `git` CLI sees it (includes and all), or `None`
    /// when unset or empty.
    fn config_value(&self, key: &str) -> Option<String> {
        self.run_git(&["config", "--get", key])
            .ok()
            .filter(|v| !v.is_empty())
    }

    /// Start `git <args>` and leave it running: a GUI tool stays open for as
    /// long as the user looks at it. A failure in the first moments (the tool
    /// isn't installed) is still reported, with git's message.
    fn launch_git(&self, args: &[String]) -> Result<()> {
        let mut child = git_command()
            .current_dir(self.workdir_path()?)
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(args)
            // No terminal: a prompt reads end-of-file and gives up rather than
            // waiting for an answer that can't come.
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| Error::Message(format!("failed to run git: {e}")))?;
        let started = Instant::now();
        while started.elapsed() < LAUNCH_GRACE {
            if let Some(status) = child
                .try_wait()
                .map_err(|e| Error::Message(format!("failed to run git: {e}")))?
            {
                if status.success() {
                    return Ok(());
                }
                let mut err = String::new();
                if let Some(mut stderr) = child.stderr.take() {
                    let _ = stderr.read_to_string(&mut err);
                }
                return Err(Error::Message(err.trim().to_string()));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // Still running: reap it (draining stderr) whenever it's closed.
        std::thread::spawn(move || {
            let _ = child.wait_with_output();
        });
        Ok(())
    }
}
