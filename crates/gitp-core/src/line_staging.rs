//! Per-line staging-area operations: stage, unstage, or discard any selection
//! of a file's changed lines, within one block or across several.
//!
//! A selected line is named the way the diff pane draws it: `(hunk, line)`, the
//! block's index and the line's index within that block's `lines`, at the
//! `context_lines` the diff was shown with (see hunk.rs for why that matters).
//!
//! The patch keeps git's own file header, but each touched block is rebuilt
//! from its lines, cut down to the selection. The side the patch is applied to
//! has to stay exactly as the diff shows it, or `git apply` can't find it — so
//! what happens to an unselected line depends on the direction:
//!   - stage (applied forward to the index, the diff's old side): unselected
//!     `-` lines become context, unselected `+` lines are dropped;
//!   - unstage / discard (applied in reverse to the index / working tree, the
//!     diff's new side): unselected `+` lines become context, unselected `-`
//!     lines are dropped.
//!
//! Block headers are recomputed from the cut-down blocks.

use std::collections::HashSet;
use std::fmt::Write;

use crate::error::{Error, Result};
use crate::hunk::{patch_text, path_patch};
use crate::repo::Repo;

/// A selected diff line: `(hunk index, line index within that hunk)`.
pub type LineRef = (usize, usize);

impl Repo {
    /// Stage just the selected `lines` of `path`'s unstaged changes.
    pub fn stage_lines(&self, path: &str, lines: &[LineRef], context_lines: u32) -> Result<()> {
        let patch = self.lines_patch(path, false, lines, context_lines, false)?;
        self.apply_hunk(&["--cached"], context_lines, &patch)
    }

    /// Unstage just the selected `lines` of `path`'s staged changes.
    pub fn unstage_lines(&self, path: &str, lines: &[LineRef], context_lines: u32) -> Result<()> {
        let patch = self.lines_patch(path, true, lines, context_lines, true)?;
        self.apply_hunk(&["--cached", "--reverse"], context_lines, &patch)
    }

    /// Discard just the selected `lines` of `path`'s unstaged changes, reverting
    /// them in the working tree. Destructive — the change is lost.
    pub fn discard_lines(&self, path: &str, lines: &[LineRef], context_lines: u32) -> Result<()> {
        let patch = self.lines_patch(path, false, lines, context_lines, true)?;
        self.apply_hunk(&["--reverse"], context_lines, &patch)
    }

    /// Build a git-appliable patch of only the selected `lines` of `path` in the
    /// given direction (staged = HEAD→index, else index→workdir). `reverse` is
    /// whether it will be applied in reverse, which decides what becomes of the
    /// unselected lines (see the module docs).
    fn lines_patch(
        &self,
        path: &str,
        staged: bool,
        lines: &[LineRef],
        context_lines: u32,
        reverse: bool,
    ) -> Result<String> {
        let diff = self.staging_diff(path, staged, context_lines)?;
        let mut patch = path_patch(&diff, path)?;
        let buf = patch.to_buf()?;
        let header: String = patch_text(&buf)?
            .split_inclusive('\n')
            .take_while(|l| !l.starts_with("@@ "))
            .collect();

        for &(h, l) in lines {
            if h >= patch.num_hunks() || l >= patch.num_lines_in_hunk(h)? {
                return Err(Error::Message(format!(
                    "line {l} of block {h} not found in diff"
                )));
            }
        }
        let selected: HashSet<LineRef> = lines.iter().copied().collect();

        let mut hunks = String::new();
        // How many lines the blocks emitted so far add (new minus old), to place
        // the next block's header on the side that isn't being matched.
        let mut shift: i64 = 0;
        // Whether any changed line is left out — then the file itself stays.
        let mut partial = false;
        for h in 0..patch.num_hunks() {
            let (hunk, count) = patch.hunk(h)?;
            let (old_start, old_lines) = (hunk.old_start(), hunk.old_lines());
            let (new_start, new_lines) = (hunk.new_start(), hunk.new_lines());

            let mut body: Vec<(char, String)> = Vec::with_capacity(count);
            let mut changes = false;
            for l in 0..count {
                let line = patch.line_in_hunk(h, l)?;
                let origin = line.origin();
                let op = match (origin, selected.contains(&(h, l))) {
                    (' ', _) => Some(' '),
                    ('+' | '-', true) => {
                        changes = true;
                        Some(origin)
                    }
                    ('+', false) => {
                        partial = true;
                        reverse.then_some(' ')
                    }
                    ('-', false) => {
                        partial = true;
                        (!reverse).then_some(' ')
                    }
                    // The "\ No newline at end of file" markers: re-derived
                    // below from whether a kept line ends in a newline.
                    _ => None,
                };
                if let Some(op) = op {
                    let text = std::str::from_utf8(line.content())
                        .map_err(|e| Error::Message(format!("patch is not valid UTF-8: {e}")))?;
                    body.push((op, text.to_string()));
                }
            }
            if !changes {
                continue;
            }
            split_unterminated_context(&mut body, reverse);

            let old_count = body.iter().filter(|(op, _)| *op != '+').count() as i64;
            let new_count = body.iter().filter(|(op, _)| *op != '-').count() as i64;
            // Lines before the block on each side. A header names the first
            // line of a non-empty side, but the line before an empty one.
            let before = |start: u32, n: u32| i64::from(if n > 0 { start - 1 } else { start });
            let (p_old, p_new) = if reverse {
                let p_new = before(new_start, new_lines);
                (p_new - shift, p_new)
            } else {
                let p_old = before(old_start, old_lines);
                (p_old, p_old + shift)
            };
            shift += new_count - old_count;
            let start = |p: i64, n: i64| if n > 0 { p + 1 } else { p };
            let _ = writeln!(
                hunks,
                "@@ -{},{old_count} +{},{new_count} @@",
                start(p_old, old_count),
                start(p_new, new_count)
            );
            for (op, text) in body {
                hunks.push(op);
                hunks.push_str(&text);
                if !text.ends_with('\n') {
                    hunks.push_str("\n\\ No newline at end of file\n");
                }
            }
        }
        if hunks.is_empty() {
            return Err(Error::Message("no changed lines selected".into()));
        }
        let header = if partial {
            keep_file_header(&header, reverse)
        } else {
            header
        };
        Ok(header + &hunks)
    }
}

/// An unselected last line without a newline that was turned into context must
/// still be the last line on both sides. If kept lines follow it, it ends the
/// matched side only: emit it there as is, and on the other side with a newline
/// added (that side really does gain one, as lines now come after it).
fn split_unterminated_context(body: &mut Vec<(char, String)>, reverse: bool) {
    let last = body.len().saturating_sub(1);
    let Some(i) = body
        .iter()
        .position(|(op, text)| *op == ' ' && !text.ends_with('\n'))
        .filter(|&i| i < last)
    else {
        return;
    };
    let eol = if body.iter().any(|(_, t)| t.ends_with("\r\n")) {
        "\r\n"
    } else {
        "\n"
    };
    let text = body[i].1.clone();
    let terminated = format!("{text}{eol}");
    let (del, add) = if reverse {
        (terminated, text)
    } else {
        (text, terminated)
    };
    body.splice(i..=i, [('-', del), ('+', add)]);
}

/// A patch that creates or deletes the file is only right when every changed
/// line is selected. Otherwise the file stays, so the header must describe a
/// plain modification instead: drop the mode line, and name the file on the
/// `/dev/null` side too. Applied forward, that's a deletion; in reverse, a
/// creation.
fn keep_file_header(header: &str, reverse: bool) -> String {
    let (mode, null_side, named, marker, prefix) = if reverse {
        ("new file mode ", "--- /dev/null", "+++ ", "---", "a/")
    } else {
        ("deleted file mode ", "+++ /dev/null", "--- ", "+++", "b/")
    };
    let lines: Vec<&str> = header.split_inclusive('\n').collect();
    let Some(named_line) = lines.iter().find(|l| l.starts_with(named)) else {
        return header.to_string();
    };
    if !lines.iter().any(|l| l.starts_with(mode)) {
        return header.to_string();
    }
    // `+++ b/x` → `--- a/x` (or the other way round), keeping git's quoting.
    let rest = &named_line[4..];
    let (quote, rest) = match rest.strip_prefix('"') {
        Some(r) => ("\"", r),
        None => ("", rest),
    };
    let renamed = format!("{marker} {quote}{prefix}{}", rest.get(2..).unwrap_or(""));
    lines
        .iter()
        .filter(|l| !l.starts_with(mode))
        .map(|l| {
            if l.trim_end() == null_side {
                renamed.as_str()
            } else {
                l
            }
        })
        .collect()
}
