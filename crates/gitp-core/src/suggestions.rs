//! A reviewer's ```suggestion block — the lines a line comment proposes in
//! place of the ones it is on — applied in the pull request branch's worktree
//! and committed: what GitHub's "Commit suggestion" does, here.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::gh::{git_in, require_clean};
use crate::repo::Repo;

/// One suggestion to apply: lines `start_line..=line` (1-based, of the file
/// at the pull request's head) of `path` become `text`.
#[derive(Debug, Clone, Deserialize)]
pub struct Suggestion {
    pub comment_id: u64,
    pub author: String,
    pub path: String,
    pub start_line: u32,
    pub line: u32,
    /// The new lines, joined with `\n`; empty deletes the range.
    pub text: String,
}

/// The text of the first ```suggestion block in a comment body, with `\n`
/// line ends, or `None` when it has none.
pub fn suggestion_in(body: &str) -> Option<String> {
    let body = body.replace("\r\n", "\n");
    let mut lines = body.lines();
    lines.by_ref().find(|l| l.trim_end() == "```suggestion")?;
    let mut out = Vec::new();
    for l in lines {
        if l.trim_end() == "```" {
            return Some(out.join("\n"));
        }
        out.push(l);
    }
    None
}

impl Repo {
    /// Apply `suggestions` in the worktree that has `branch` checked out and
    /// commit them once, as the user. The worktree must be clean and exactly
    /// at the pull request's `head`, since the suggestions' lines are that
    /// commit's; suggestions on overlapping lines are refused. On any failure
    /// the files are put back. Returns the new commit.
    pub fn apply_suggestions(
        &self,
        number: u64,
        head: &str,
        branch: &str,
        suggestions: &[Suggestion],
    ) -> Result<String> {
        if suggestions.is_empty() {
            return Err(Error::Message("No suggestion to apply.".into()));
        }
        let worktree = self
            .worktrees()?
            .into_iter()
            .find(|w| w.branch.as_deref() == Some(branch))
            .ok_or_else(|| {
                Error::Message(format!(
                    "Check the pull request out first: its branch {branch} is in no worktree."
                ))
            })?;
        let dir = Path::new(&worktree.path);
        require_clean(dir)?;
        let at = git_in(dir, &["rev-parse", "HEAD"])?;
        if at != head {
            return Err(Error::Message(format!(
                "{branch} is not at the pull request's head ({}): pull or push it first, so the suggestion's lines are the ones it was made on.",
                &head[..head.len().min(7)]
            )));
        }

        let mut by_path: BTreeMap<&str, Vec<&Suggestion>> = BTreeMap::new();
        for s in suggestions {
            by_path.entry(s.path.as_str()).or_default().push(s);
        }
        let changed: Vec<&str> = by_path.keys().copied().collect();
        let applied = (|| {
            for (path, list) in &by_path {
                apply_to_file(&dir.join(path), path, list)?;
            }
            let mut add = vec!["add", "--"];
            add.extend(&changed);
            git_in(dir, &add)?;
            git_in(dir, &["commit", "-q", "-m", &message(number, suggestions)])?;
            git_in(dir, &["rev-parse", "HEAD"])
        })();
        if applied.is_err() {
            // Clean before, so putting the files back loses nothing of the user's.
            let mut restore = vec!["checkout", "HEAD", "--"];
            restore.extend(&changed);
            let _ = git_in(dir, &["reset", "-q"]);
            let _ = git_in(dir, &restore);
        }
        applied
    }
}

/// Replace each suggestion's lines in `file`, the lowest last, so the line
/// numbers of the others stay right; the file's line end (`\r\n` or `\n`)
/// is kept.
fn apply_to_file(file: &Path, path: &str, list: &[&Suggestion]) -> Result<()> {
    let text = std::fs::read_to_string(file)
        .map_err(|e| Error::Message(format!("can't read {path}: {e}")))?;
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let ends_with_eol = text.ends_with('\n');
    let mut lines: Vec<String> = text
        .lines()
        .map(|l| l.trim_end_matches('\r').to_string())
        .collect();

    let mut sorted: Vec<&Suggestion> = list.to_vec();
    sorted.sort_by_key(|s| std::cmp::Reverse(s.start_line));
    for pair in sorted.windows(2) {
        // `pair[1]` starts lower: it must end before `pair[0]` starts.
        if pair[1].line >= pair[0].start_line {
            return Err(Error::Message(format!(
                "Two suggestions on {path} overlap (lines {}-{} and {}-{}): apply them one at a time.",
                pair[1].start_line, pair[1].line, pair[0].start_line, pair[0].line
            )));
        }
    }
    for s in &sorted {
        let (start, end) = (s.start_line as usize, s.line as usize);
        if start == 0 || start > end || end > lines.len() {
            return Err(Error::Message(format!(
                "The suggestion on {path}:{}-{} is past the file, which has {} lines.",
                s.start_line,
                s.line,
                lines.len()
            )));
        }
        let new: Vec<String> = if s.text.is_empty() {
            vec![]
        } else {
            s.text.split('\n').map(str::to_string).collect()
        };
        lines.splice(start - 1..end, new);
    }
    let mut out = lines.join(eol);
    if ends_with_eol && !lines.is_empty() {
        out.push_str(eol);
    }
    std::fs::write(file, out).map_err(|e| Error::Message(format!("can't write {path}: {e}")))
}

/// "Apply suggestion from @rev" (or "Apply 3 suggestions from @a and @b"),
/// with where each one was, as GitHub words its own.
fn message(number: u64, suggestions: &[Suggestion]) -> String {
    let mut authors: Vec<&str> = suggestions.iter().map(|s| s.author.as_str()).collect();
    authors.dedup();
    authors.sort_unstable();
    authors.dedup();
    let who = authors
        .iter()
        .map(|a| format!("@{a}"))
        .collect::<Vec<_>>()
        .join(" and ");
    let what = if suggestions.len() == 1 {
        "suggestion".to_string()
    } else {
        format!("{} suggestions", suggestions.len())
    };
    let mut m =
        format!("Apply {what} from {who}\n\nReview suggestions on pull request #{number}:\n");
    for s in suggestions {
        let lines = if s.start_line == s.line {
            s.line.to_string()
        } else {
            format!("{}-{}", s.start_line, s.line)
        };
        m.push_str(&format!(
            "- {}:{lines} (comment {})\n",
            s.path, s.comment_id
        ));
    }
    m
}
