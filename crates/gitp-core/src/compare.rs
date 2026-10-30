//! Comparing any two revisions — commits, branches or tags — or a revision and
//! the working directory, as a diff in the same `FileDiff` shape a commit's own
//! diff uses.
//!
//! Two modes, named after git's range syntax: two-dot (`base..head`) diffs the
//! two trees directly; three-dot (`base...head`) diffs from their merge base
//! to `head`, i.e. only what `head` added since the two diverged.
//!
//! Besides a revision, a side can be [`EMPTY_REV`] — no files at all — so a
//! combined diff of a run of commits that starts at a root commit can diff
//! from before it; or [`WORKDIR_REV`], the working directory's tracked files
//! with any uncommitted changes (`git diff <rev>`). The working directory
//! stands for HEAD in the merge base and the ahead / behind counts.

use serde::Serialize;

use crate::diff::{collect_files, FileDiff, MAX_DIFF_LINES};
use crate::error::{Error, Result};
use crate::repo::Repo;

/// The `rev` naming the empty tree as a side of a comparison. It reads as a
/// label because it is shown as one, and can never be a ref name (those can't
/// contain a space), so it can't shadow a real revision.
pub const EMPTY_REV: &str = "Empty Tree";

/// The `rev` naming the working directory as a side of a comparison — see
/// [`EMPTY_REV`] for why it reads as a label.
pub const WORKDIR_REV: &str = "Working Directory";

/// One side of a comparison. `id`, `short_id` and `summary` are empty for
/// [`EMPTY_REV`] and [`WORKDIR_REV`], which are no commit.
#[derive(Debug, Clone, Serialize)]
pub struct CompareEnd {
    /// The revision as given (a ref name or an id), for display.
    pub rev: String,
    pub id: String,
    pub short_id: String,
    pub summary: String,
}

/// What differs between `base` and `head`.
#[derive(Debug, Clone, Serialize)]
pub struct Comparison {
    pub base: CompareEnd,
    pub head: CompareEnd,
    /// Whether `files` run from the merge base (three-dot) or from `base`.
    pub three_dot: bool,
    /// `None` when the two histories share no commit.
    pub merge_base: Option<String>,
    /// Commits reachable from `head` but not from `base`.
    pub ahead: usize,
    /// Commits reachable from `base` but not from `head`.
    pub behind: usize,
    pub files: Vec<FileDiff>,
}

impl Repo {
    /// Compare `base` with `head` (each a ref name, short or full id).
    pub fn compare(&self, base: &str, head: &str, three_dot: bool) -> Result<Comparison> {
        let ends = self.compare_ends(base, head)?;
        let mut opts = git2::DiffOptions::new();
        let files = collect_files(
            &self.compare_diff(&ends, three_dot, opts.patience(true))?,
            Some(MAX_DIFF_LINES),
        )?;
        let (ahead, behind) = match (ends.head.commit_id(), ends.base.commit_id()) {
            (Some(h), Some(b)) => self.inner.graph_ahead_behind(h, b)?,
            // The empty side has no commits: the other has all of its own.
            (Some(h), None) => (self.count_commits(h)?, 0),
            (None, Some(b)) => (0, self.count_commits(b)?),
            (None, None) => (0, 0),
        };
        Ok(Comparison {
            base: end(base, &ends.base),
            head: end(head, &ends.head),
            three_dot,
            merge_base: ends.merge_base.map(|id| id.to_string()),
            ahead,
            behind,
            files,
        })
    }

    /// One file of a comparison re-diffed with `context_lines` of context —
    /// the compare counterpart of [`Repo::commit_file_diff`], with the same
    /// `old_path` pairing for renames. `None` when the file didn't change.
    #[allow(clippy::too_many_arguments)]
    pub fn compare_file_diff(
        &self,
        base: &str,
        head: &str,
        three_dot: bool,
        path: &str,
        old_path: Option<&str>,
        context_lines: u32,
        max_lines: Option<usize>,
    ) -> Result<Option<FileDiff>> {
        self.compare_file_diff_with(
            base,
            head,
            three_dot,
            path,
            old_path,
            context_lines,
            false,
            max_lines,
        )
    }

    /// [`Repo::compare_file_diff`], optionally ignoring whitespace (`git diff
    /// -w`).
    #[allow(clippy::too_many_arguments)]
    pub fn compare_file_diff_with(
        &self,
        base: &str,
        head: &str,
        three_dot: bool,
        path: &str,
        old_path: Option<&str>,
        context_lines: u32,
        ignore_whitespace: bool,
        max_lines: Option<usize>,
    ) -> Result<Option<FileDiff>> {
        let ends = self.compare_ends(base, head)?;
        let mut opts = git2::DiffOptions::new();
        opts.patience(true)
            .context_lines(context_lines)
            .ignore_whitespace(ignore_whitespace)
            .disable_pathspec_match(true)
            .pathspec(path);
        if let Some(old) = old_path {
            opts.pathspec(old);
        }
        let files = collect_files(&self.compare_diff(&ends, three_dot, &mut opts)?, max_lines)?;
        Ok(files.into_iter().find(|f| f.path == path))
    }

    fn compare_ends(&self, base: &str, head: &str) -> Result<Ends<'_>> {
        let base = self.compare_side(base)?;
        let head = self.compare_side(head)?;
        let merge_base = match (base.commit_id(), head.commit_id()) {
            (Some(b), Some(h)) => match self.inner.merge_base(b, h) {
                Ok(id) => Some(id),
                Err(e) if e.code() == git2::ErrorCode::NotFound => None,
                Err(e) => return Err(e.into()),
            },
            _ => None,
        };
        Ok(Ends {
            base,
            head,
            merge_base,
        })
    }

    fn compare_side(&self, rev: &str) -> Result<Side<'_>> {
        if rev == EMPTY_REV {
            return Ok(Side::Empty);
        }
        if rev == WORKDIR_REV {
            // An unborn branch has no HEAD commit yet.
            let head = self.inner.head().ok().and_then(|h| h.target());
            return Ok(Side::Workdir(head));
        }
        Ok(Side::Commit(
            self.inner.revparse_single(rev)?.peel_to_commit()?,
        ))
    }

    /// How many commits `id` has in its history, itself included.
    fn count_commits(&self, id: git2::Oid) -> Result<usize> {
        let mut walk = self.inner.revwalk()?;
        walk.push(id)?;
        Ok(walk.count())
    }

    /// The diff for a comparison, with renames detected. The working directory
    /// is diffed through the index, as `git diff <rev>` does: tracked files,
    /// staged changes or not; untracked files are left out.
    fn compare_diff(
        &self,
        ends: &Ends,
        three_dot: bool,
        opts: &mut git2::DiffOptions,
    ) -> Result<git2::Diff<'_>> {
        let from = || -> Result<Option<git2::Tree<'_>>> {
            if !three_dot {
                return ends.base.tree();
            }
            let id = ends.merge_base.ok_or_else(|| {
                Error::Message(
                    "these revisions have no common ancestor — use a two-dot comparison".into(),
                )
            })?;
            Ok(Some(self.inner.find_commit(id)?.tree()?))
        };
        let mut diff = match (&ends.base, &ends.head) {
            (Side::Workdir(_), Side::Workdir(_)) => {
                self.inner.diff_tree_to_tree(None, None, Some(opts))?
            }
            (_, Side::Workdir(_)) => self
                .inner
                .diff_tree_to_workdir_with_index(from()?.as_ref(), Some(opts))?,
            // From the working directory to a revision: that revision's diff
            // to it, reversed.
            (Side::Workdir(_), head) if !three_dot => self
                .inner
                .diff_tree_to_workdir_with_index(head.tree()?.as_ref(), Some(opts.reverse(true)))?,
            (_, head) => {
                self.inner
                    .diff_tree_to_tree(from()?.as_ref(), head.tree()?.as_ref(), Some(opts))?
            }
        };
        diff.find_similar(Some(&mut git2::DiffFindOptions::new()))?;
        Ok(diff)
    }
}

/// Both sides of a comparison, resolved, plus their merge base.
struct Ends<'r> {
    base: Side<'r>,
    head: Side<'r>,
    merge_base: Option<git2::Oid>,
}

/// One side of a comparison, resolved.
enum Side<'r> {
    Commit(git2::Commit<'r>),
    /// [`EMPTY_REV`].
    Empty,
    /// [`WORKDIR_REV`], with the HEAD commit it stands for in history.
    Workdir(Option<git2::Oid>),
}

impl<'r> Side<'r> {
    fn commit_id(&self) -> Option<git2::Oid> {
        match self {
            Side::Commit(c) => Some(c.id()),
            Side::Empty => None,
            Side::Workdir(head) => *head,
        }
    }

    /// The side's files; `None` is the empty tree. The working directory has
    /// no tree — `compare_diff` diffs against it directly.
    fn tree(&self) -> Result<Option<git2::Tree<'r>>> {
        match self {
            Side::Commit(c) => Ok(Some(c.tree()?)),
            Side::Empty => Ok(None),
            Side::Workdir(_) => Err(Error::Message("the working directory is not a tree".into())),
        }
    }
}

fn end(rev: &str, side: &Side) -> CompareEnd {
    let Side::Commit(commit) = side else {
        return CompareEnd {
            rev: rev.to_string(),
            id: String::new(),
            short_id: String::new(),
            summary: String::new(),
        };
    };
    let id = commit.id().to_string();
    CompareEnd {
        rev: rev.to_string(),
        short_id: id[..7].to_string(),
        id,
        summary: commit.summary().unwrap_or("").to_string(),
    }
}
