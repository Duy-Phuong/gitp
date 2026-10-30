//! Git LFS: whether it is installed and whether the repository uses it, and
//! the handful of `git lfs` commands the GUI offers — track / untrack a
//! pattern, fetch, pull, and install the filters for this repository.
//!
//! Everything goes through `git lfs`, so it needs the git-lfs binary; without
//! it each command fails with a message saying so rather than git's "'lfs' is
//! not a git command". Detecting LFS *use* doesn't need it: that is read from
//! `.gitattributes`.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use crate::error::{Error, Result};
use crate::repo::Repo;

/// What the status bar's LFS indicator shows.
#[derive(Debug, Clone, Serialize)]
pub struct LfsStatus {
    /// `git lfs` runs.
    pub installed: bool,
    /// The repository's `.gitattributes` sends some paths through the LFS
    /// filter — it is an LFS repository.
    pub used: bool,
    /// The LFS filters are configured (by `git lfs install`, globally or for
    /// this repository). Without them a checkout leaves pointer files in place
    /// of the real content.
    pub initialized: bool,
    /// The tracked patterns, as written in `.gitattributes`.
    pub patterns: Vec<String>,
}

const NOT_INSTALLED: &str = "Git LFS is not installed, so this can't be done. Install it \
     (for example with `brew install git-lfs`), then try again.";

impl Repo {
    pub fn lfs_status(&self) -> Result<LfsStatus> {
        let patterns = self.lfs_patterns();
        // `--get-regexp` exits 1, printing nothing, when no key matches.
        let initialized = self
            .run_git(&["config", "--get-regexp", r"^filter\.lfs\."])
            .is_ok_and(|out| !out.is_empty());
        Ok(LfsStatus {
            installed: self.lfs_installed(),
            used: !patterns.is_empty(),
            initialized,
            patterns,
        })
    }

    /// The patterns the top-level `.gitattributes` marks `filter=lfs` — where
    /// `git lfs track` writes them. Nested `.gitattributes` aren't read.
    fn lfs_patterns(&self) -> Vec<String> {
        let Ok(text) = std::fs::read_to_string(self.workdir().join(".gitattributes")) else {
            return Vec::new();
        };
        text.lines()
            .filter_map(|line| {
                let mut words = line.split_whitespace();
                let pattern = words.next().filter(|p| !p.starts_with('#'))?;
                words
                    .any(|attr| attr == "filter=lfs")
                    .then(|| pattern.to_string())
            })
            .collect()
    }

    /// Whether `git lfs` runs. A positive answer is remembered for the rest of
    /// the process — it is asked on every sidebar refresh, and git-lfs doesn't
    /// uninstall itself — while a negative one is asked again, so installing it
    /// with gitp open is noticed.
    fn lfs_installed(&self) -> bool {
        static INSTALLED: AtomicBool = AtomicBool::new(false);
        if INSTALLED.load(Ordering::Relaxed) {
            return true;
        }
        let found = self.run_git(&["lfs", "version"]).is_ok();
        INSTALLED.store(found, Ordering::Relaxed);
        found
    }

    fn require_lfs(&self) -> Result<()> {
        if self.lfs_installed() {
            Ok(())
        } else {
            Err(Error::Message(NOT_INSTALLED.into()))
        }
    }

    /// `git lfs track <pattern>`: add it to `.gitattributes`, left for the user
    /// to commit.
    pub fn lfs_track(&self, pattern: &str) -> Result<String> {
        self.lfs_pattern_command("track", pattern)
    }

    /// `git lfs untrack <pattern>`: take it out of `.gitattributes`. Files
    /// already stored in LFS stay so until they are added again.
    pub fn lfs_untrack(&self, pattern: &str) -> Result<String> {
        self.lfs_pattern_command("untrack", pattern)
    }

    fn lfs_pattern_command(&self, command: &str, pattern: &str) -> Result<String> {
        self.require_lfs()?;
        let pattern = pattern.trim();
        if pattern.is_empty() {
            return Err(Error::Message("Give a pattern, e.g. *.psd".into()));
        }
        // `--`: a pattern is the user's text, never an option.
        self.run_git(&["lfs", command, "--", pattern])
    }

    /// `git lfs install --local`: set up the LFS filters and hooks for this
    /// repository alone.
    pub fn lfs_install(&self) -> Result<String> {
        self.require_lfs()?;
        self.run_git(&["lfs", "install", "--local"])
    }

    /// `git lfs fetch`: download the LFS objects the checked-out commit needs
    /// from the default remote, without touching the working tree. A network
    /// operation with progress and Cancel, like `git fetch`.
    pub fn lfs_fetch(&self) -> Result<String> {
        self.require_lfs()?;
        self.run_lfs_network("fetch")
    }

    /// `git lfs pull`: fetch, then replace the pointer files in the working
    /// tree with their content.
    pub fn lfs_pull(&self) -> Result<String> {
        self.require_lfs()?;
        self.run_lfs_network("pull")
    }

    fn run_lfs_network(&self, command: &str) -> Result<String> {
        // git-lfs prints its meters only to a terminal unless told otherwise;
        // they read like git's ("Downloading LFS objects:  50% (1/2), …"), so
        // the same parser reports them.
        self.run_git_progress_on_stdout(&["-c", "lfs.forceprogress=true", "lfs", command])
    }
}
