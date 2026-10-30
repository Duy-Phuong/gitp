//! Per-line blame for a file as of a commit — who last touched each line.

use std::collections::HashMap;
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
    ///
    /// The attribution comes from `git blame` rather than libgit2's blame,
    /// which on a long history is dozens of times slower: ~30 s of CPU for a
    /// 5000-line file with 100k commits behind it, against ~0.4 s for git —
    /// all of it with the workspace locked. libgit2's is the fallback for when
    /// git can't do it (no git on PATH, an ignore-revs file named in the
    /// config that doesn't exist).
    pub fn blame(&self, rev: &str, path: &str) -> Result<Vec<BlameLine>> {
        let oid = self.inner.revparse_single(rev)?.peel_to_commit()?.id();

        // Pair the commit per line with the file's text at `rev` to get the
        // actual line content. Read first, so a path missing at `rev` fails
        // here, with libgit2's message, as it always has.
        let commit = self.inner.find_commit(oid)?;
        let entry = commit.tree()?.get_path(Path::new(path))?;
        let blob = self.inner.find_blob(entry.id())?;
        let text = self.text_encoding().decode_lossy(blob.content());

        // The resolved id, not `rev`: nothing for git to mistake for an option.
        let by_line =
            match self.run_git_raw(&["blame", "--porcelain", &oid.to_string(), "--", path]) {
                Ok(raw) => blame_commits(&String::from_utf8_lossy(&raw)),
                Err(_) => self.libgit2_blame_commits(oid, path)?,
            };

        // Authors as libgit2's blame gave them (no mailmap), looked up once
        // per commit.
        let mut authors: HashMap<git2::Oid, String> = HashMap::new();
        let mut lines = Vec::new();
        for (i, content) in text.lines().enumerate() {
            let line_no = i + 1;
            let (commit, author) = match by_line.get(&line_no) {
                Some(&id) => {
                    let author = authors.entry(id).or_insert_with(|| {
                        self.inner
                            .find_commit(id)
                            .map(|c| c.author().name().unwrap_or("").to_string())
                            .unwrap_or_default()
                    });
                    (id.to_string(), author.clone())
                }
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

    /// The commit of each line of `path` as of `oid`, by libgit2's blame.
    fn libgit2_blame_commits(
        &self,
        oid: git2::Oid,
        path: &str,
    ) -> Result<HashMap<usize, git2::Oid>> {
        let mut opts = git2::BlameOptions::new();
        opts.newest_commit(oid);
        let blame = self.inner.blame_file(Path::new(path), Some(&mut opts))?;
        let mut out = HashMap::new();
        for hunk in blame.iter() {
            let start = hunk.final_start_line();
            for line_no in start..start + hunk.lines_in_hunk() {
                out.insert(line_no, hunk.final_commit_id());
            }
        }
        Ok(out)
    }
}

/// The commit of each final line number in `git blame --porcelain` output.
///
/// Each group of lines starts with a header, `<sha> <orig-line> <final-line>
/// [<count>]`; the commit's details (only on its first group) and each line's
/// tab-prefixed text follow. Only the headers matter here: every other line
/// starts with a keyword or a tab, never with 40 hex digits and a space.
fn blame_commits(porcelain: &str) -> HashMap<usize, git2::Oid> {
    let mut out = HashMap::new();
    for line in porcelain.lines() {
        let mut fields = line.split(' ');
        let (Some(id), Some(_orig), Some(final_line)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if id.len() != 40 {
            continue;
        }
        let (Ok(id), Ok(start)) = (git2::Oid::from_str(id), final_line.parse::<usize>()) else {
            continue;
        };
        let count = fields.next().and_then(|c| c.parse().ok()).unwrap_or(1);
        for line_no in start..start + count {
            out.insert(line_no, id);
        }
    }
    out
}
