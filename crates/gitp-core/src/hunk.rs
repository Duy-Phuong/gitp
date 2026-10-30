//! Per-hunk staging-area operations: stage, unstage, or discard a single block
//! of a file's diff (as in `git add -p`).
//!
//! The patch for one hunk is produced by libgit2 (`Patch::to_buf`) rather than
//! reconstructed by hand, so git's own header/context/"no newline at end of
//! file" formatting is preserved. That text is then fed to `git apply`, which
//! handles `--cached` (index) and `--reverse` correctly:
//!   - stage:   apply the unstaged hunk to the index
//!   - unstage: reverse-apply the staged hunk on the index
//!   - discard: reverse-apply the unstaged hunk in the working tree
//!   - revert a commit's block: reverse-apply that hunk of the commit's own
//!     diff in the working tree
//!
//! Every operation takes the `context_lines` the diff was shown with: the
//! context size decides where one hunk ends and the next begins, so the hunk
//! the user clicked is only "hunk N" at that same size.

use crate::error::{Error, Result};
use crate::repo::Repo;

impl Repo {
    /// Stage just hunk `hunk_index` of `path`'s unstaged changes.
    pub fn stage_hunk(&self, path: &str, hunk_index: usize, context_lines: u32) -> Result<()> {
        let patch = self.hunk_patch(path, false, hunk_index, context_lines)?;
        self.apply_hunk(&["--cached"], context_lines, &patch)
    }

    /// Unstage just hunk `hunk_index` of `path`'s staged changes.
    pub fn unstage_hunk(&self, path: &str, hunk_index: usize, context_lines: u32) -> Result<()> {
        let patch = self.hunk_patch(path, true, hunk_index, context_lines)?;
        self.apply_hunk(&["--cached", "--reverse"], context_lines, &patch)
    }

    /// Discard just hunk `hunk_index` of `path`'s unstaged changes, reverting
    /// that block in the working tree. Destructive — the change is lost.
    pub fn discard_hunk(&self, path: &str, hunk_index: usize, context_lines: u32) -> Result<()> {
        let patch = self.hunk_patch(path, false, hunk_index, context_lines)?;
        self.apply_hunk(&["--reverse"], context_lines, &patch)
    }

    /// Undo hunk `hunk_index` of commit `rev`'s change to `path` (its diff
    /// against the first parent, at `context_lines`) in the working tree — a
    /// `git revert` of just that block, left unstaged. `old_path` is a
    /// rename's source, as for [`Repo::commit_file_diff`]. Fails, changing
    /// nothing, when the file no longer has those lines where the block put
    /// them.
    pub fn revert_commit_hunk(
        &self,
        rev: &str,
        path: &str,
        old_path: Option<&str>,
        hunk_index: usize,
        context_lines: u32,
    ) -> Result<()> {
        let commit = self.inner.revparse_single(rev)?.peel_to_commit()?;
        let mut opts = git2::DiffOptions::new();
        opts.patience(true)
            .context_lines(context_lines)
            .disable_pathspec_match(true)
            .pathspec(path);
        if let Some(old) = old_path {
            opts.pathspec(old);
        }
        let diff = self.commit_diff(&commit, &mut opts)?;
        let mut patch = path_patch(&diff, path)?;
        let buf = patch.to_buf()?;
        let hunk = single_hunk_patch(&without_rename(patch_text(&buf)?), hunk_index)?;
        self.apply_hunk(&["--reverse"], context_lines, &hunk)
            .map_err(|e| {
                Error::Message(format!(
                    "This block doesn't match {path} in the working tree any more, so it can't \
                     be reverted. The file was left as it was.\n\n{e}"
                ))
            })
    }

    /// `git apply <mode> <patch>`. A patch with no context lines needs
    /// `--unidiff-zero`: without context git refuses it, since it can't confirm
    /// the hunk lands where the header says.
    pub(crate) fn apply_hunk(&self, mode: &[&str], context_lines: u32, patch: &str) -> Result<()> {
        let mut args = vec!["apply", "--whitespace=nowarn"];
        args.extend_from_slice(mode);
        if context_lines == 0 {
            args.push("--unidiff-zero");
        }
        self.run_git_stdin(&args, patch).map(|_| ())
    }

    /// Build a minimal, git-appliable patch containing only hunk `hunk_index`
    /// of `path` in the given direction (staged = HEAD→index, else
    /// index→workdir) — the file header plus that one `@@` block.
    fn hunk_patch(
        &self,
        path: &str,
        staged: bool,
        hunk_index: usize,
        context_lines: u32,
    ) -> Result<String> {
        let diff = self.staging_diff(path, staged, context_lines)?;
        let mut patch = path_patch(&diff, path)?;
        let buf = patch.to_buf()?;
        single_hunk_patch(patch_text(&buf)?, hunk_index)
    }
}

/// The textual patch for `path` within `diff`. The delta is picked by name
/// rather than assuming it's the only (or first) one, so a lookalike path can
/// never be patched by mistake.
pub(crate) fn path_patch<'d>(diff: &'d git2::Diff, path: &str) -> Result<git2::Patch<'d>> {
    let idx = diff
        .deltas()
        .position(|d| {
            let is = |f: git2::DiffFile| f.path().is_some_and(|p| p.to_string_lossy() == path);
            is(d.new_file()) || is(d.old_file())
        })
        .ok_or_else(|| Error::Message(format!("{path} has no changes to apply")))?;
    git2::Patch::from_diff(diff, idx)?
        .ok_or_else(|| Error::Message("file has no textual diff to apply".into()))
}

pub(crate) fn patch_text(buf: &[u8]) -> Result<&str> {
    std::str::from_utf8(buf).map_err(|e| Error::Message(format!("patch is not valid UTF-8: {e}")))
}

/// A rename's (or copy's) patch with its header reduced to a plain edit of the
/// new path. Reversed as it stands, `git apply` would also move the file back
/// to its old name — undoing one block must only touch that block's lines.
fn without_rename(patch: &str) -> String {
    let Some(plus) = patch.lines().find_map(|l| l.strip_prefix("+++ ")) else {
        return patch.to_string();
    };
    let is_move = patch
        .lines()
        .take_while(|l| !l.starts_with("@@ "))
        .any(|l| l.starts_with("rename from ") || l.starts_with("copy from "));
    if !is_move {
        return patch.to_string();
    }
    // `b/<path>`, or `"b/<path>"` when git had to quote it.
    let minus = match plus.strip_prefix('"') {
        Some(rest) => format!("\"a{}", rest.strip_prefix('b').unwrap_or(rest)),
        None => format!("a{}", plus.strip_prefix('b').unwrap_or(plus)),
    };
    let body = patch.find("\n@@ ").map_or("", |i| &patch[i + 1..]);
    format!("diff --git {minus} {plus}\n--- {minus}\n+++ {plus}\n{body}")
}

/// Split a full-file unified patch into its header and hunks, and return the
/// header followed by only the `hunk_index`-th hunk. Hunk headers are the lines
/// beginning with `@@ `; content lines never do (they carry a ` `/`+`/`-`
/// prefix), so the split is unambiguous.
fn single_hunk_patch(patch: &str, hunk_index: usize) -> Result<String> {
    let mut header = String::new();
    let mut hunks: Vec<String> = Vec::new();

    for line in patch.split_inclusive('\n') {
        if line.starts_with("@@ ") {
            hunks.push(String::from(line));
        } else if let Some(cur) = hunks.last_mut() {
            cur.push_str(line);
        } else {
            header.push_str(line);
        }
    }

    let hunk = hunks
        .get(hunk_index)
        .ok_or_else(|| Error::Message(format!("hunk {hunk_index} not found in diff")))?;
    Ok(format!("{header}{hunk}"))
}
