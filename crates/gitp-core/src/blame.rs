//! Per-line blame for a file as of a commit — who last touched each line.

use std::path::Path;

use serde::Serialize;

use crate::error::Result;
use crate::repo::Repo;

/// One source line plus the commit/author that last changed it.
#[derive(Debug, Clone, Serialize)]
pub struct BlameLine {
    /// Full hex id of the commit that last modified this line (the UI shows a
    /// short prefix but keeps the full id so a click can open that commit).
    pub commit: String,
    pub author: String,
    /// 1-based line number in the file at `rev`.
    pub line_no: usize,
    pub content: String,
}

impl Repo {
    /// Blame `path` as it stands at `rev`: for each line, the commit and author
    /// that last changed it. Errors if the file does not exist at `rev`.
    pub fn blame(&self, rev: &str, path: &str) -> Result<Vec<BlameLine>> {
        let oid = self.inner.revparse_single(rev)?.peel_to_commit()?.id();

        let mut opts = git2::BlameOptions::new();
        opts.newest_commit(oid);
        let blame = self.inner.blame_file(Path::new(path), Some(&mut opts))?;

        // Blame gives commit ids per line range; pair them with the file's text
        // at `rev` to get the actual line content.
        let commit = self.inner.find_commit(oid)?;
        let entry = commit.tree()?.get_path(Path::new(path))?;
        let blob = self.inner.find_blob(entry.id())?;
        let text = String::from_utf8_lossy(blob.content());

        let mut lines = Vec::new();
        for (i, content) in text.lines().enumerate() {
            let line_no = i + 1;
            let (commit, author) = match blame.get_line(line_no) {
                Some(hunk) => (
                    hunk.final_commit_id().to_string(),
                    hunk.final_signature().name().unwrap_or("").to_string(),
                ),
                None => (String::new(), String::new()),
            };
            lines.push(BlameLine {
                commit,
                author,
                line_no,
                content: content.to_string(),
            });
        }
        Ok(lines)
    }
}
