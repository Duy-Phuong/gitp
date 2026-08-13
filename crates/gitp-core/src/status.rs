//! Working-tree status: the uncommitted changes shown by "Local Changes".

use crate::diff::{collect_files, FileDiff};
use crate::error::Result;
use crate::repo::Repo;

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
}
