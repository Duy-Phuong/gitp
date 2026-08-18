//! Working-tree status: the uncommitted changes shown by "Local Changes".

use std::collections::HashSet;

use serde::Serialize;

use crate::diff::{collect_files, ChangeKind, FileDiff};
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
    /// Number of distinct paths with uncommitted changes, for the sidebar badge.
    pub fn local_change_count(&self) -> Result<usize> {
        let s = self.status_summary()?;
        let paths: HashSet<&str> = s
            .staged
            .iter()
            .chain(&s.unstaged)
            .map(|f| f.path.as_str())
            .collect();
        Ok(paths.len())
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

    /// The staging area as *summaries* — path, old_path, and status only, no
    /// hunks (fetch those on demand with `file_diff`).
    ///
    /// Computed from `git status --porcelain` rather than libgit2 diffs, so that
    /// gitattributes `filter`s — most importantly **Git LFS** — are honored
    /// exactly as the `git` CLI does. libgit2 can't run external filters, so a
    /// git2 diff misses every change to an LFS-tracked file; parsing the CLI's
    /// status keeps the list identical to `git status`.
    pub fn status_summary(&self) -> Result<StatusLists> {
        // -z: NUL-separated records (safe for any path); --untracked-files=all:
        // list individual new files, not just their directories.
        let raw = self.run_git_raw(&["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
        let text = String::from_utf8_lossy(&raw);
        let toks: Vec<&str> = text.split('\0').filter(|t| !t.is_empty()).collect();

        let mut staged: Vec<FileDiff> = Vec::new();
        let mut unstaged: Vec<FileDiff> = Vec::new();

        let mut i = 0;
        while i < toks.len() {
            let rec = toks[i];
            i += 1;
            // Each record is "XY<space>path": X = index/staged status,
            // Y = working-tree/unstaged status.
            let bytes = rec.as_bytes();
            if bytes.len() < 3 {
                continue;
            }
            let x = bytes[0] as char;
            let y = bytes[1] as char;
            let path = rec[3..].to_string();

            // Renames/copies carry the original path as the next NUL record.
            let mut old_path = None;
            if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
                if i < toks.len() {
                    old_path = Some(toks[i].to_string());
                    i += 1;
                }
            }

            // Untracked ("??") is a single unstaged entry.
            if x == '?' && y == '?' {
                unstaged.push(FileDiff {
                    path,
                    old_path: None,
                    status: ChangeKind::Untracked,
                    hunks: Vec::new(),
                });
                continue;
            }

            if let Some(status) = kind_from_code(x) {
                staged.push(FileDiff {
                    path: path.clone(),
                    old_path: old_path.clone(),
                    status,
                    hunks: Vec::new(),
                });
            }
            if let Some(status) = kind_from_code(y) {
                unstaged.push(FileDiff {
                    path,
                    old_path,
                    status,
                    hunks: Vec::new(),
                });
            }
        }

        Ok(StatusLists { staged, unstaged })
    }

    /// The full diff (with hunks) for a single `path`, either staged
    /// (HEAD → index) or unstaged (index → working tree). Narrowed with a
    /// pathspec so only that one file's blobs are read. Returns `None` if the
    /// path has no changes in that direction.
    pub fn file_diff(&self, path: &str, staged: bool) -> Result<Option<FileDiff>> {
        let diff = self.staging_diff(path, staged)?;
        let mut files = collect_files(&diff)?;
        let idx = files.iter().position(|f| f.path == path);
        Ok(match idx {
            Some(i) => Some(files.remove(i)),
            None => files.into_iter().next(),
        })
    }

    /// The raw git2 diff for a single `path` in one direction — staged
    /// (HEAD → index) or unstaged (index → working tree). Shared by `file_diff`
    /// and the per-hunk operations so a hunk's index is identical whether it's
    /// being rendered or applied.
    pub(crate) fn staging_diff(&self, path: &str, staged: bool) -> Result<git2::Diff<'_>> {
        let head_tree = match self.inner.head() {
            Ok(head) => Some(head.peel_to_tree()?),
            Err(_) => None,
        };
        let mut index = self.inner.index()?;
        index.read(true)?;

        let mut opts = git2::DiffOptions::new();
        opts.patience(true).pathspec(path);
        let diff = if staged {
            self.inner
                .diff_tree_to_index(head_tree.as_ref(), Some(&index), Some(&mut opts))?
        } else {
            // show_untracked_content so a brand-new file's lines appear in the
            // diff (otherwise an untracked file has zero hunks and shows blank);
            // this also lets it be staged hunk-by-hunk like any other change.
            opts.include_untracked(true)
                .recurse_untracked_dirs(true)
                .show_untracked_content(true);
            self.inner
                .diff_index_to_workdir(Some(&index), Some(&mut opts))?
        };
        Ok(diff)
    }
}

/// Map a `git status --porcelain` status column (X = staged, Y = unstaged) to a
/// `ChangeKind`. Returns `None` for a blank column (no change on that side);
/// untracked (`?`) and ignored (`!`) are handled by the caller.
fn kind_from_code(code: char) -> Option<ChangeKind> {
    match code {
        'M' | 'T' | 'U' => Some(ChangeKind::Modified),
        'A' => Some(ChangeKind::Added),
        'D' => Some(ChangeKind::Deleted),
        'R' => Some(ChangeKind::Renamed),
        'C' => Some(ChangeKind::Copied),
        _ => None,
    }
}
