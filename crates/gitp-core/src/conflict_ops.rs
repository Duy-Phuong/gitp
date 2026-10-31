//! Conflict resolution driven by the conflict-resolver view, for every git
//! operation that can stop mid-way with conflict markers: merge (squash
//! included), rebase, cherry-pick, and revert. Reports the in-progress session, reads the three
//! sides of a conflicted file, marks files resolved, and finishes (commit /
//! continue) or aborts. Everything shells out through `run_git` so git's own
//! conflict handling and messages apply as-is.

use serde::Serialize;

use crate::error::{Error, Result};
use crate::remote::literal_pathspec;
use crate::repo::Repo;

/// A snapshot of the current conflict session, for the resolver UI.
#[derive(Debug, Clone, Serialize)]
pub struct ConflictStatus {
    /// `"merge"` (a squash merge too), `"rebase"`, `"cherry-pick"`,
    /// `"revert"`, or `"none"` when nothing is in progress.
    pub kind: String,
    /// Human summary, e.g. `Merging origin/x into dev` or `Rebasing dev`.
    pub summary: String,
    /// Working-tree paths still unmerged (`git diff --diff-filter=U`).
    pub conflicted: Vec<String>,
    /// The default commit message (merge only; empty for rebase/none).
    pub message: String,
}

/// The three staged versions plus the working-tree text of a conflicted file.
#[derive(Debug, Clone, Serialize)]
pub struct ConflictSides {
    /// Stage 2 (ours / current branch); `None` if our side deleted the file.
    pub ours: Option<String>,
    /// Stage 3 (theirs / incoming); `None` if their side deleted the file.
    pub theirs: Option<String>,
    /// Stage 1 (common ancestor); `None` for add/add conflicts.
    pub base: Option<String>,
    /// The current working-tree file, with conflict markers.
    pub working: String,
    /// Any side is binary (or the working file contains a NUL byte).
    pub binary: bool,
    /// The working file was changed after git wrote it: it matches neither
    /// side and has no conflict markers. git leaves one side's version there
    /// (binary and delete/modify conflicts) or its marked-up merge, so
    /// anything else is someone's edit — which taking a side would overwrite.
    pub edited: bool,
}

impl Repo {
    /// Report the in-progress conflict session (merge, rebase, cherry-pick, or
    /// revert), if any.
    pub fn conflict_status(&self) -> Result<ConflictStatus> {
        let git_dir = self.inner.path();
        let merging = git_dir.join("MERGE_HEAD").exists();
        let rebasing =
            git_dir.join("rebase-merge").is_dir() || git_dir.join("rebase-apply").is_dir();
        let cherry_picking = git_dir.join("CHERRY_PICK_HEAD").exists();
        let reverting = git_dir.join("REVERT_HEAD").exists();
        let squashing = self.squash_pending();

        if !merging && !rebasing && !cherry_picking && !reverting && !squashing {
            return Ok(ConflictStatus {
                kind: "none".into(),
                summary: String::new(),
                conflicted: Vec::new(),
                message: String::new(),
            });
        }

        let conflicted = self.unmerged_paths()?;

        if squashing {
            return Ok(ConflictStatus {
                kind: "merge".into(),
                summary: format!("Squash merge into {}", self.current_branch_label()),
                conflicted,
                message: self.squash_message().unwrap_or_default(),
            });
        }

        if rebasing {
            let into = self.rebasing_branch_label();
            return Ok(ConflictStatus {
                kind: "rebase".into(),
                summary: format!("Rebasing {into}"),
                conflicted,
                message: String::new(),
            });
        }

        // Merge, cherry-pick, and revert all stage their pending commit message
        // in MERGE_MSG the same way, so they share this summary logic.
        let kind = if merging {
            "merge"
        } else if cherry_picking {
            "cherry-pick"
        } else {
            "revert"
        };
        let message = std::fs::read_to_string(git_dir.join("MERGE_MSG")).unwrap_or_default();
        let into = self.current_branch_label();
        let default_summary = match kind {
            "cherry-pick" => format!("Cherry-picking onto {into}"),
            "revert" => format!("Reverting on {into}"),
            _ => format!("Merging into {into}"),
        };
        // MERGE_MSG's first line is git's own summary (e.g. "Merge …").
        let summary = message
            .lines()
            .next()
            .map(str::to_string)
            .unwrap_or(default_summary);
        Ok(ConflictStatus {
            kind: kind.into(),
            summary,
            conflicted,
            message,
        })
    }

    /// Read the ours/theirs/base staged versions and the working text of `path`.
    pub fn conflict_sides(&self, path: &str) -> Result<ConflictSides> {
        let stage = |n: u8| -> Option<Vec<u8>> {
            self.run_git_raw(&["show", &format!(":{n}:{path}")]).ok()
        };
        let base = stage(1);
        let ours = stage(2);
        let theirs = stage(3);
        let on_disk = std::fs::read(self.workdir_path()?.join(path)).ok();
        let edited = on_disk.as_deref().is_some_and(|w| {
            Some(w) != ours.as_deref()
                && Some(w) != theirs.as_deref()
                && !w.split(|&b| b == b'\n').any(|l| l.starts_with(b"<<<<<<<"))
        });
        let working = on_disk.unwrap_or_default();

        let has_nul = |b: &[u8]| b.contains(&0);
        let binary = has_nul(&working)
            || [&base, &ours, &theirs]
                .iter()
                .flat_map(|o| o.iter())
                .any(|b| has_nul(b));

        let enc = self.text_encoding();
        let to_text = |o: Option<Vec<u8>>| o.map(|b| enc.decode_lossy(&b).into_owned());
        Ok(ConflictSides {
            ours: to_text(ours),
            theirs: to_text(theirs),
            base: to_text(base),
            working: enc.decode_lossy(&working).into_owned(),
            binary,
            edited,
        })
    }

    /// Write the resolved `content` for `path`, in the repo's encoding, and
    /// stage it (`git add`), which marks the conflict resolved.
    pub fn resolve_conflict(&self, path: &str, content: &str) -> Result<()> {
        let enc = self.text_encoding();
        let bytes = enc.encode(content).ok_or_else(|| {
            Error::Message(format!(
                "the result has characters that {} can't represent, so it wasn't saved",
                enc.name()
            ))
        })?;
        std::fs::write(self.workdir_path()?.join(path), bytes)
            .map_err(|e| crate::error::Error::Message(format!("can't write {path}: {e}")))?;
        self.run_git(&["add", "--", &literal_pathspec(path)])
            .map(|_| ())
    }

    /// Resolve `path` by taking one whole side — `git checkout --ours/--theirs`
    /// then `git add`. Used for binary conflicts (no text merge is possible) and
    /// whole-file "take" actions.
    ///
    /// In a delete/modify conflict the chosen side may have no version at all
    /// (its index stage is absent, so `checkout --ours` fails with "does not
    /// have our version"). Taking that side means taking the deletion: drop the
    /// path from the index and the working tree instead.
    pub fn resolve_conflict_side(&self, path: &str, ours: bool) -> Result<()> {
        let (side, stage) = if ours { ("--ours", 2) } else { ("--theirs", 3) };
        let spec = literal_pathspec(path);
        if self
            .run_git_raw(&["show", &format!(":{stage}:{path}")])
            .is_err()
        {
            self.run_git(&["rm", "-q", "--cached", "--", &spec])?;
            let full = self.workdir_path()?.join(path);
            if full.exists() {
                std::fs::remove_file(&full)
                    .map_err(|e| Error::Message(format!("can't delete {path}: {e}")))?;
            }
            return Ok(());
        }
        self.run_git(&["checkout", side, "--", &spec])?;
        self.run_git(&["add", "--", &spec]).map(|_| ())
    }

    /// Abort the in-progress merge, rebase, cherry-pick, or revert, restoring
    /// the pre-op state.
    pub fn abort_conflict(&self) -> Result<String> {
        let git_dir = self.inner.path();
        if git_dir.join("MERGE_HEAD").exists() {
            self.run_git(&["merge", "--abort"])
        } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
            self.run_git(&["cherry-pick", "--abort"])
        } else if git_dir.join("REVERT_HEAD").exists() {
            self.run_git(&["revert", "--abort"])
        } else if self.squash_pending() {
            // `merge --abort` needs MERGE_HEAD, which a squash never writes;
            // `reset --merge` is what it would run. Drop the message too, or
            // the squash would still look pending.
            let out = self.run_git(&["reset", "--merge"])?;
            let msg = git_dir.join("SQUASH_MSG");
            if msg.exists() {
                std::fs::remove_file(&msg)
                    .map_err(|e| Error::Message(format!("can't remove SQUASH_MSG: {e}")))?;
            }
            Ok(out)
        } else {
            let out = self.run_git(&["rebase", "--abort"]);
            self.cleanup_rebase_scratch();
            out
        }
    }

    /// Finish the conflict session once every file is resolved: commit the
    /// merge with `message`, or continue the rebase/cherry-pick/revert (each of
    /// which reuses its own pending message).
    pub fn finish_conflict(&self, message: &str) -> Result<String> {
        let git_dir = self.inner.path();
        if git_dir.join("MERGE_HEAD").exists() || self.squash_pending() {
            self.run_git_stdin(&["commit", "-F", "-"], message)
        } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
            self.continue_without_editor(&["cherry-pick", "--continue"])
        } else if git_dir.join("REVERT_HEAD").exists() {
            self.continue_without_editor(&["revert", "--continue"])
        } else {
            // A rebase stopped on a conflict asks to confirm the commit's
            // message in an editor too; there is none here.
            let out = self.continue_without_editor(&["rebase", "--continue"]);
            self.cleanup_rebase_scratch();
            out
        }
    }

    /// Run a `--continue` that would otherwise pop an editor to confirm the
    /// pending commit message (cherry-pick and revert both reuse the original
    /// commit's message by default). There's no TTY here, so GIT_EDITOR=true
    /// auto-accepts it — same fix as the interactive-rebase reword handling.
    fn continue_without_editor(&self, args: &[&str]) -> Result<String> {
        let workdir = self.workdir_path()?;
        let output = crate::activity::output(
            crate::git_bin::git_command()
                .current_dir(workdir)
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("GIT_EDITOR", "true")
                .args(args),
        )
        .map_err(|e| Error::Message(format!("failed to run git: {e}")))?;
        let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
        combined.push_str(&String::from_utf8_lossy(&output.stderr));
        let combined = combined.trim().to_string();
        if output.status.success() {
            Ok(combined)
        } else {
            Err(Error::Message(combined))
        }
    }

    /// A `git merge --squash` is waiting to be committed. It writes no
    /// MERGE_HEAD — only SQUASH_MSG, plus unmerged files when it conflicted —
    /// yet it is a merge to resolve, commit or abort all the same. git removes
    /// the file on commit and reset; should a stale one sit beside another
    /// operation's state, that operation wins.
    ///
    /// Discarding the staged result, or a switch, leaves SQUASH_MSG behind
    /// too. With nothing unmerged and the index equal to HEAD there is no
    /// squash left, so a leftover message is deleted here rather than taken
    /// for one — Abort's `reset --merge` would wipe whatever is staged next.
    pub(crate) fn squash_pending(&self) -> bool {
        let git_dir = self.inner.path();
        let msg = git_dir.join("SQUASH_MSG");
        if !msg.exists()
            || ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]
                .iter()
                .any(|f| git_dir.join(f).exists())
            || ["rebase-merge", "rebase-apply"]
                .iter()
                .any(|d| git_dir.join(d).is_dir())
        {
            return false;
        }
        let unmerged = self.unmerged_paths().map_or(true, |p| !p.is_empty());
        if unmerged || !self.index_matches_head().unwrap_or(false) {
            return true;
        }
        let _ = std::fs::remove_file(&msg);
        false
    }

    /// The index holds exactly HEAD's tree (nothing staged).
    fn index_matches_head(&self) -> Result<bool> {
        let head_tree = self.inner.head().ok().and_then(|h| h.peel_to_tree().ok());
        let mut index = self.inner.index()?;
        index.read(true)?;
        let diff = self
            .inner
            .diff_tree_to_index(head_tree.as_ref(), Some(&index), None)?;
        Ok(diff.deltas().len() == 0)
    }

    /// Working-tree paths with unresolved conflicts.
    pub(crate) fn unmerged_paths(&self) -> Result<Vec<String>> {
        Ok(self
            .run_git(&["diff", "--name-only", "--diff-filter=U"])?
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(str::to_string)
            .collect())
    }

    /// The branch being rebased. HEAD is detached for the whole rebase, so the
    /// name comes from git's rebase state (`head-name`, e.g. `refs/heads/dev`);
    /// falls back to the HEAD label when it can't be read.
    fn rebasing_branch_label(&self) -> String {
        let git_dir = self.inner.path();
        ["rebase-merge", "rebase-apply"]
            .iter()
            .find_map(|d| std::fs::read_to_string(git_dir.join(d).join("head-name")).ok())
            .map(|n| {
                let n = n.trim();
                n.strip_prefix("refs/heads/").unwrap_or(n).to_string()
            })
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| self.current_branch_label())
    }

    /// Short name of the checked-out branch, or `HEAD` when detached.
    fn current_branch_label(&self) -> String {
        self.inner
            .head()
            .ok()
            .and_then(|h| h.shorthand().map(str::to_string))
            .unwrap_or_else(|| "HEAD".into())
    }
}
