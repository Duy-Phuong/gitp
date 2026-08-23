//! File-level local-changes operations driven by the changes-view right-click
//! menu, each acting on a set of selected paths: discard whole files, stash
//! selected files, save selected files as a patch, and add files to
//! `.gitignore`.
//!
//! All of these shell out through `run_git`/`run_git_raw` so git's own behavior
//! (pathspec matching, conflict handling, messages) applies as-is.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::repo::Repo;

impl Repo {
    /// Discard every local change to `paths`, reverting each to its committed
    /// (HEAD) state. Paths that don't exist in the HEAD tree — new files, whether
    /// untracked or staged-added — are unstaged and deleted from disk instead.
    /// Destructive: discarded changes are lost.
    ///
    /// Renames aren't specially handled; the new name is treated as a new file.
    pub fn discard_files(&self, paths: &[String]) -> Result<()> {
        let (in_head, new): (Vec<&String>, Vec<&String>) =
            paths.iter().partition(|p| self.path_in_head(p));

        // Tracked (in HEAD): reset both index and working tree to the committed
        // version in one shot.
        if !in_head.is_empty() {
            let mut args = vec!["checkout", "-q", "HEAD", "--"];
            args.extend(in_head.iter().map(|p| p.as_str()));
            self.run_git(&args)?;
        }

        // New (not in HEAD): drop any staged intent, then remove from disk.
        if !new.is_empty() {
            let mut reset = vec!["reset", "-q", "--"];
            reset.extend(new.iter().map(|p| p.as_str()));
            self.run_git(&reset)?;
            let workdir = self.workdir_path()?;
            for p in new {
                let full = workdir.join(p);
                if full.exists() {
                    fs::remove_file(&full)
                        .map_err(|e| Error::Message(format!("can't delete {p}: {e}")))?;
                }
            }
        }
        Ok(())
    }

    /// Stash only `paths` away (`git stash push -u -- <paths>`), reverting them
    /// in the working tree. `-u` so any untracked selected files are included.
    pub fn stash_files(&self, paths: &[String]) -> Result<String> {
        let mut args = vec!["stash", "push", "-u", "--"];
        args.extend(paths.iter().map(|p| p.as_str()));
        self.run_git(&args)
    }

    /// Write a unified diff of `paths` to `dest`. `staged` chooses the index
    /// direction (`git diff --cached`) over the working-tree one (`git diff`).
    ///
    /// `git diff` omits untracked files, which would make a patch for a new file
    /// empty; so for the working-tree direction any untracked selected files are
    /// temporarily marked intent-to-add (`git add -N`) — which makes their
    /// content show up as additions — and the mark is removed afterwards.
    pub fn save_files_patch(&self, paths: &[String], staged: bool, dest: &Path) -> Result<String> {
        let refs: Vec<&str> = paths.iter().map(String::as_str).collect();

        let patch = if staged {
            let mut args = vec!["diff", "--cached", "--"];
            args.extend_from_slice(&refs);
            self.run_git_raw(&args)?
        } else {
            let untracked: Vec<&str> =
                refs.iter().copied().filter(|p| self.is_untracked(p)).collect();
            if !untracked.is_empty() {
                let mut add = vec!["add", "-N", "--"];
                add.extend_from_slice(&untracked);
                self.run_git(&add)?;
            }
            let mut args = vec!["diff", "--"];
            args.extend_from_slice(&refs);
            let out = self.run_git_raw(&args);
            // Always undo the intent-to-add, even if the diff failed.
            if !untracked.is_empty() {
                let mut reset = vec!["reset", "-q", "--"];
                reset.extend_from_slice(&untracked);
                let _ = self.run_git(&reset);
            }
            out?
        };

        fs::write(dest, &patch)
            .map_err(|e| Error::Message(format!("can't write patch: {e}")))?;
        Ok(format!("Saved patch to {}", dest.display()))
    }

    /// Whether `path` is untracked (present in the working tree, absent from the
    /// index) — the files `git diff` alone wouldn't include in a patch.
    fn is_untracked(&self, path: &str) -> bool {
        self.inner
            .status_file(Path::new(path))
            .map(|s| s.contains(git2::Status::WT_NEW))
            .unwrap_or(false)
    }

    /// Append each of `paths` to the repository root's `.gitignore`, skipping
    /// entries already present (exact-line match). Creates the file if absent.
    /// Returns the number of entries actually added.
    pub fn add_to_gitignore(&self, paths: &[String]) -> Result<usize> {
        let file = self.workdir_path()?.join(".gitignore");
        let existing = fs::read_to_string(&file).unwrap_or_default();
        let mut present: Vec<&str> = existing.lines().map(str::trim).collect();

        let mut to_add: Vec<&str> = Vec::new();
        for p in paths {
            let entry = p.trim_end_matches('/');
            let line = p.as_str();
            if !present.contains(&line) && !present.contains(&entry) && !to_add.contains(&line) {
                to_add.push(line);
                present.push(line);
            }
        }
        if to_add.is_empty() {
            return Ok(0);
        }

        let mut out = existing;
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        for line in &to_add {
            out.push_str(line);
            out.push('\n');
        }
        fs::write(&file, out)
            .map_err(|e| Error::Message(format!("can't write .gitignore: {e}")))?;
        Ok(to_add.len())
    }

    /// The repository's working directory. Errors for a bare repo.
    pub fn workdir_path(&self) -> Result<PathBuf> {
        self.inner
            .workdir()
            .map(Path::to_path_buf)
            .ok_or_else(|| Error::Message("repository has no working directory".into()))
    }

    /// Whether `path` exists in the current HEAD tree (i.e. it's a committed,
    /// tracked file rather than a newly added/untracked one).
    fn path_in_head(&self, path: &str) -> bool {
        let Ok(head) = self.inner.head() else { return false };
        let Ok(tree) = head.peel_to_tree() else { return false };
        tree.get_path(Path::new(path)).is_ok()
    }
}
