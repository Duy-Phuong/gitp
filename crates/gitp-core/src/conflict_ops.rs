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
    /// What the "ours" side (stage 2) is, in words: the checked-out branch
    /// for a merge, cherry-pick or revert, but the branch being rebased onto
    /// during a rebase, where git swaps the sides.
    pub ours_label: String,
    /// What the "theirs" side (stage 3) is: the merged branch, the picked or
    /// reverted commit, or during a rebase the user's own commit being applied.
    pub theirs_label: String,
    /// During a rebase, the number of the commit being applied and how many
    /// there are, when git's rebase state says.
    pub step: Option<u32>,
    pub steps: Option<u32>,
    /// Conflicted paths whose working file has no conflict markers left (git
    /// rerere replayed a resolution, or it was edited), so they can be marked
    /// resolved as they are. Delete/modify conflicts are never listed.
    pub clean: Vec<String>,
}

/// One commit that changed a conflicted file, for the "why" panel.
#[derive(Debug, Clone, Serialize)]
pub struct ConflictCommit {
    pub short: String,
    pub author: String,
    /// Relative date, e.g. "3 days ago".
    pub when: String,
    pub subject: String,
}

/// The commits each side made to a conflicted file since the sides split.
#[derive(Debug, Clone, Serialize, Default)]
pub struct SideCommits {
    pub ours: Vec<ConflictCommit>,
    pub theirs: Vec<ConflictCommit>,
}

/// How many commits per side the "why" panel lists.
const SIDE_COMMITS: usize = 15;

/// The files under `.git` that name the commit coming in, by operation.
const OTHER_HEADS: [&str; 4] = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
];

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

        let mut status = ConflictStatus {
            kind: "none".into(),
            summary: String::new(),
            conflicted: Vec::new(),
            message: String::new(),
            ours_label: String::new(),
            theirs_label: String::new(),
            step: None,
            steps: None,
            clean: Vec::new(),
        };
        if !merging && !rebasing && !cherry_picking && !reverting && !squashing {
            return Ok(status);
        }

        status.conflicted = self.unmerged_paths()?;
        status.clean = self.marker_free(&status.conflicted);
        let branch = self.current_branch_label();

        if squashing {
            status.kind = "merge".into();
            status.summary = format!("Squash merge into {branch}");
            status.message = self.squash_message().unwrap_or_default();
            status.ours_label = branch;
            status.theirs_label = "the squashed branch".into();
            return Ok(status);
        }

        if rebasing {
            let into = self.rebasing_branch_label();
            status.kind = "rebase".into();
            status.summary = format!("Rebasing {into}");
            status.ours_label = format!("{} (rebasing onto)", self.rebase_onto_label());
            status.theirs_label = match self.head_file_commit("REBASE_HEAD") {
                Some(c) => format!("your commit {c}"),
                None => format!("your commit on {into}"),
            };
            (status.step, status.steps) = self.rebase_progress();
            return Ok(status);
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
        let default_summary = match kind {
            "cherry-pick" => format!("Cherry-picking onto {branch}"),
            "revert" => format!("Reverting on {branch}"),
            _ => format!("Merging into {branch}"),
        };
        status.theirs_label = match kind {
            "cherry-pick" => self
                .head_file_commit("CHERRY_PICK_HEAD")
                .map(|c| format!("picked commit {c}")),
            "revert" => self
                .head_file_commit("REVERT_HEAD")
                .map(|c| format!("undoing {c}")),
            _ => merged_name(&message).or_else(|| self.head_file_commit("MERGE_HEAD")),
        }
        .unwrap_or_else(|| "incoming".into());
        status.ours_label = branch;
        // MERGE_MSG's first line is git's own summary (e.g. "Merge …").
        status.summary = message
            .lines()
            .next()
            .map(str::to_string)
            .unwrap_or(default_summary);
        status.kind = kind.into();
        status.message = message;
        Ok(status)
    }

    /// The commits that changed `path` on each side since the sides split:
    /// ours from HEAD, theirs from the incoming commit (MERGE_HEAD,
    /// CHERRY_PICK_HEAD, REVERT_HEAD or REBASE_HEAD), newest first and at most
    /// [`SIDE_COMMITS`] each. A side with none of its own (the reverted commit
    /// is the split point) lists the incoming commit itself. Empty when there
    /// is no incoming commit, as in a squash merge.
    pub fn conflict_side_commits(&self, path: &str) -> Result<SideCommits> {
        let git_dir = self.inner.path();
        let Some(other) = OTHER_HEADS
            .iter()
            .find_map(|f| std::fs::read_to_string(git_dir.join(f)).ok())
            .map(|s| s.lines().next().unwrap_or("").trim().to_string())
            .filter(|s| !s.is_empty())
        else {
            return Ok(SideCommits::default());
        };
        let base = self
            .run_git(&["merge-base", "HEAD", &other])?
            .trim()
            .to_string();
        let spec = literal_pathspec(path);
        let log = |range: &str| -> Result<Vec<ConflictCommit>> {
            let max = format!("-{SIDE_COMMITS}");
            let out = self.run_git(&[
                "log",
                &max,
                "--format=%h%x1f%an%x1f%ar%x1f%s",
                range,
                "--",
                &spec,
            ])?;
            Ok(out.lines().filter_map(parse_commit_line).collect())
        };
        let ours = log(&format!("{base}..HEAD"))?;
        let mut theirs = log(&format!("{base}..{other}"))?;
        if theirs.is_empty() {
            let one = self.run_git(&["log", "-1", "--format=%h%x1f%an%x1f%ar%x1f%s", &other])?;
            theirs = one.lines().filter_map(parse_commit_line).collect();
        }
        Ok(SideCommits { ours, theirs })
    }

    /// Run shell line `command` in the work tree to suggest resolutions for a
    /// file's conflicts: `input` (the conflicts, as the caller words them)
    /// goes on its stdin, and what it prints is the answer — the `result` of
    /// a `claude -p --output-format json` run. Read-only by contract: the
    /// command's own tool list keeps it so; nothing here writes.
    pub fn suggest_conflict_resolution(&self, command: &str, input: &str) -> Result<String> {
        let out = crate::gh::run_shell(
            &self.workdir_path()?,
            command,
            input.as_bytes(),
            &[],
            crate::gh::EXPLAIN_TIMEOUT,
            &self.net,
        )?;
        crate::gh::claude_answer(&out.stdout).map(|(text, _)| text)
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

    /// `abc1234 "subject"` for the commit the `.git` file `name` holds.
    fn head_file_commit(&self, name: &str) -> Option<String> {
        let sha = std::fs::read_to_string(self.inner.path().join(name)).ok()?;
        let sha = sha.lines().next()?.trim();
        let out = self
            .run_git(&["log", "-1", "--format=%h%x1f%s", sha])
            .ok()?;
        let (short, subject) = out.trim().split_once('\x1f')?;
        Some(format!("{short} \"{subject}\""))
    }

    /// The branch a rebase replays onto: a branch whose tip is the `onto`
    /// commit (a local one first), else its short id.
    fn rebase_onto_label(&self) -> String {
        let git_dir = self.inner.path();
        let Some(onto) = ["rebase-merge", "rebase-apply"]
            .iter()
            .find_map(|d| std::fs::read_to_string(git_dir.join(d).join("onto")).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        else {
            return "upstream".into();
        };
        self.run_git(&[
            "for-each-ref",
            "--points-at",
            &onto,
            "--format=%(refname:short)",
            "refs/heads",
            "refs/remotes",
        ])
        .ok()
        .and_then(|out| {
            out.lines()
                .map(str::trim)
                .find(|l| !l.is_empty() && !l.ends_with("/HEAD"))
                .map(str::to_string)
        })
        .unwrap_or_else(|| onto.chars().take(7).collect())
    }

    /// The commit a rebase is on and how many it has, from git's rebase
    /// state (`msgnum`/`end`, or `next`/`last` for the apply backend).
    fn rebase_progress(&self) -> (Option<u32>, Option<u32>) {
        let git_dir = self.inner.path();
        let read = |d: &str, f: &str| {
            std::fs::read_to_string(git_dir.join(d).join(f))
                .ok()
                .and_then(|s| s.trim().parse::<u32>().ok())
        };
        if git_dir.join("rebase-merge").is_dir() {
            (read("rebase-merge", "msgnum"), read("rebase-merge", "end"))
        } else {
            (read("rebase-apply", "next"), read("rebase-apply", "last"))
        }
    }

    /// The `paths` whose working file is text with no conflict markers left.
    /// A path missing a side (delete/modify) is left out: no markers is how
    /// git leaves it, not a sign it was resolved.
    fn marker_free(&self, paths: &[String]) -> Vec<String> {
        if paths.is_empty() {
            return Vec::new();
        }
        let Ok(workdir) = self.workdir_path() else {
            return Vec::new();
        };
        let staged = self.run_git(&["ls-files", "-u"]).unwrap_or_default();
        let has_stage = |path: &str, stage: &str| {
            staged.lines().any(|l| {
                l.split_once('\t').is_some_and(|(meta, p)| {
                    p == path && meta.split_whitespace().nth(2) == Some(stage)
                })
            })
        };
        paths
            .iter()
            .filter(|p| has_stage(p, "2") && has_stage(p, "3"))
            .filter(|p| {
                std::fs::read(workdir.join(p.as_str())).is_ok_and(|b| {
                    !b.contains(&0) && !b.split(|&c| c == b'\n').any(|l| l.starts_with(b"<<<<<<<"))
                })
            })
            .cloned()
            .collect()
    }
}

/// The branch a merge brought in, from git's message: the first quoted name
/// of "Merge branch 'x'" or "Merge remote-tracking branch 'origin/x'".
fn merged_name(message: &str) -> Option<String> {
    let first = message.lines().next()?;
    let rest = first.split_once('\'')?.1;
    let name = rest.split_once('\'')?.0;
    (!name.is_empty()).then(|| name.to_string())
}

/// One `%h%x1f%an%x1f%ar%x1f%s` line of `git log`.
fn parse_commit_line(line: &str) -> Option<ConflictCommit> {
    let mut f = line.split('\x1f');
    Some(ConflictCommit {
        short: f.next()?.to_string(),
        author: f.next()?.to_string(),
        when: f.next()?.to_string(),
        subject: f.next().unwrap_or("").to_string(),
    })
}
