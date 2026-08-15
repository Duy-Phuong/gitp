//! Commit detail: metadata plus per-file diffs against the first parent.

use serde::Serialize;

use crate::error::Result;
use crate::repo::Repo;

/// How a file changed in a commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    /// A new file not yet tracked by git (working-tree only).
    Untracked,
    Other,
}

impl From<git2::Delta> for ChangeKind {
    fn from(d: git2::Delta) -> Self {
        match d {
            git2::Delta::Added => ChangeKind::Added,
            git2::Delta::Modified => ChangeKind::Modified,
            git2::Delta::Deleted => ChangeKind::Deleted,
            git2::Delta::Renamed => ChangeKind::Renamed,
            git2::Delta::Copied => ChangeKind::Copied,
            git2::Delta::Untracked => ChangeKind::Untracked,
            _ => ChangeKind::Other,
        }
    }
}

/// One line inside a diff hunk.
#[derive(Debug, Clone, Serialize)]
pub struct DiffLine {
    /// '+' added, '-' removed, ' ' context.
    pub origin: char,
    /// Line number in the old file, if applicable.
    pub old_lineno: Option<u32>,
    /// Line number in the new file, if applicable.
    pub new_lineno: Option<u32>,
    /// Line text without the trailing newline.
    pub content: String,
}

/// A contiguous block of changed lines within a file.
#[derive(Debug, Clone, Serialize)]
pub struct DiffHunk {
    /// The `@@ ... @@` header line.
    pub header: String,
    pub lines: Vec<DiffLine>,
}

/// The diff for a single file within a commit.
#[derive(Debug, Clone, Serialize)]
pub struct FileDiff {
    /// New path (or the path for deletes).
    pub path: String,
    /// Previous path when the file was renamed or copied.
    pub old_path: Option<String>,
    pub status: ChangeKind,
    pub hunks: Vec<DiffHunk>,
}

/// Full detail for one commit: metadata plus its file diffs.
#[derive(Debug, Clone, Serialize)]
pub struct CommitDetail {
    pub id: String,
    pub summary: String,
    /// Full commit message (subject + body).
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub parents: Vec<String>,
    pub files: Vec<FileDiff>,
}

impl Repo {
    /// Detail for the commit named by `rev` (a full/short oid or ref name).
    /// The diff compares the commit against its first parent (or the empty tree
    /// for a root commit).
    pub fn commit_detail(&self, rev: &str) -> Result<CommitDetail> {
        let obj = self.inner.revparse_single(rev)?;
        let commit = obj.peel_to_commit()?;
        let author = commit.author();

        let new_tree = commit.tree()?;
        let parent_tree = match commit.parent(0) {
            Ok(parent) => Some(parent.tree()?),
            Err(_) => None,
        };

        let mut diff = self.inner.diff_tree_to_tree(
            parent_tree.as_ref(),
            Some(&new_tree),
            Some(git2::DiffOptions::new().patience(true)),
        )?;
        // Detect renames so ChangeKind::Renamed is reported.
        diff.find_similar(Some(&mut git2::DiffFindOptions::new()))?;

        let files = collect_files(&diff)?;

        Ok(CommitDetail {
            id: commit.id().to_string(),
            summary: commit.summary().unwrap_or("").to_string(),
            message: commit.message().unwrap_or("").to_string(),
            author_name: author.name().unwrap_or("").to_string(),
            author_email: author.email().unwrap_or("").to_string(),
            author_time: author.when().seconds(),
            parents: commit.parent_ids().map(|p| p.to_string()).collect(),
            files,
        })
    }
}

/// Walk a diff's deltas, hunks and lines into owned `FileDiff`s.
pub(crate) fn collect_files(diff: &git2::Diff) -> Result<Vec<FileDiff>> {
    let mut files: Vec<FileDiff> = Vec::new();

    for (idx, delta) in diff.deltas().enumerate() {
        let new_path = delta.new_file().path().map(path_string);
        let old_path_raw = delta.old_file().path().map(path_string);
        let path = new_path
            .clone()
            .or_else(|| old_path_raw.clone())
            .unwrap_or_default();
        // Only surface old_path when it actually differs (rename/copy).
        let old_path = old_path_raw.filter(|op| Some(op) != new_path.as_ref());

        let mut file = FileDiff {
            path,
            old_path,
            status: delta.status().into(),
            hunks: Vec::new(),
        };

        // `Patch` yields the hunks and lines for this one delta. It is `None` for
        // binary files (no textual patch), which we simply leave hunk-less.
        if let Some(patch) = git2::Patch::from_diff(diff, idx)? {
            for h in 0..patch.num_hunks() {
                let (hunk, line_count) = patch.hunk(h)?;
                let mut lines = Vec::with_capacity(line_count);
                for l in 0..line_count {
                    let line = patch.line_in_hunk(h, l)?;
                    lines.push(DiffLine {
                        origin: line.origin(),
                        old_lineno: line.old_lineno(),
                        new_lineno: line.new_lineno(),
                        content: String::from_utf8_lossy(line.content())
                            .trim_end_matches('\n')
                            .to_string(),
                    });
                }
                file.hunks.push(DiffHunk {
                    header: String::from_utf8_lossy(hunk.header()).trim_end().to_string(),
                    lines,
                });
            }
        }

        files.push(file);
    }

    Ok(files)
}

fn path_string(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}
