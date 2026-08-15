//! Working-tree status: the uncommitted changes shown by "Local Changes".

use serde::Serialize;

use crate::diff::{collect_files, FileDiff};
use crate::error::Result;
use crate::repo::Repo;

/// Staged vs unstaged changes, each as file diffs — the staging area view.
#[derive(Debug, Clone, Serialize)]
pub struct StatusLists {
    /// Changes staged for commit (HEAD tree → index).
    pub staged: Vec<FileDiff>,
    /// Changes not yet staged (index → working tree), including untracked files.
    pub unstaged: Vec<FileDiff>,
}

impl Repo {
    /// Number of paths with uncommitted changes (staged, unstaged, or untracked).
    /// Cheap — computes status without building patches, for the sidebar badge.
    pub fn local_change_count(&self) -> Result<usize> {
        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true).recurse_untracked_dirs(true);
        let statuses = self.inner.statuses(Some(&mut opts))?;
        Ok(statuses
            .iter()
            .filter(|e| e.status() != git2::Status::CURRENT)
            .count())
    }

    /// All uncommitted changes vs HEAD (staged + unstaged + untracked), as file
    /// diffs — the same shape as commit detail so the frontend renders them alike.
    pub fn working_changes(&self) -> Result<Vec<FileDiff>> {
        let head_tree = match self.inner.head() {
            Ok(head) => Some(head.peel_to_tree()?),
            Err(_) => None, // unborn branch: everything is "new"
        };
        let mut opts = git2::DiffOptions::new();
        opts.patience(true)
            .include_untracked(true)
            .recurse_untracked_dirs(true);
        let mut diff =
            self.inner
                .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))?;
        diff.find_similar(Some(&mut git2::DiffFindOptions::new()))?;
        collect_files(&diff)
    }

    /// The staging area: staged changes (HEAD → index) and unstaged changes
    /// (index → working tree, including untracked files), each as file diffs.
    pub fn status_lists(&self) -> Result<StatusLists> {
        let head_tree = match self.inner.head() {
            Ok(head) => Some(head.peel_to_tree()?),
            Err(_) => None, // unborn branch: nothing committed yet
        };
        // Reload from disk: stage/unstage/commit run the `git` CLI, which writes
        // .git/index behind git2's back, so the cached index would be stale.
        let mut index = self.inner.index()?;
        index.read(true)?;

        // Staged = HEAD tree vs the index.
        let mut staged = self.inner.diff_tree_to_index(
            head_tree.as_ref(),
            Some(&index),
            Some(git2::DiffOptions::new().patience(true)),
        )?;
        staged.find_similar(Some(&mut git2::DiffFindOptions::new()))?;

        // Unstaged = the index vs the working tree (untracked included).
        let mut wt_opts = git2::DiffOptions::new();
        wt_opts
            .patience(true)
            .include_untracked(true)
            .recurse_untracked_dirs(true);
        let mut unstaged = self
            .inner
            .diff_index_to_workdir(Some(&index), Some(&mut wt_opts))?;
        unstaged.find_similar(Some(&mut git2::DiffFindOptions::new()))?;

        Ok(StatusLists {
            staged: collect_files(&staged)?,
            unstaged: collect_files(&unstaged)?,
        })
    }
}
