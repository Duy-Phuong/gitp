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

    /// `git apply <mode> <patch>`. A patch with no context lines needs
    /// `--unidiff-zero`: without context git refuses it, since it can't confirm
    /// the hunk lands where the header says.
    fn apply_hunk(&self, mode: &[&str], context_lines: u32, patch: &str) -> Result<()> {
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
        let mut patch = git2::Patch::from_diff(&diff, 0)?
            .ok_or_else(|| Error::Message("file has no textual diff to apply".into()))?;
        let buf = patch.to_buf()?;
        let text = std::str::from_utf8(&buf)
            .map_err(|e| Error::Message(format!("patch is not valid UTF-8: {e}")))?;
        single_hunk_patch(text, hunk_index)
    }
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
