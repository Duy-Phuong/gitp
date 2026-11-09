//! A pull request's conflicts with its base, resolved by Claude in the
//! branch's worktree: merge the base in, let Claude edit the conflicted
//! files, and stop there with a preview. Nothing is committed or pushed until
//! the user approves; a discard puts the branch back where it was.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{Error, Result};
use crate::gh::{
    claude_answer, git_in, require_clean, require_contains, run_shell, undo_fix, FIX_TIMEOUT,
};
use crate::repo::Repo;

/// A merge of the base into the pull request's branch, Claude's edits in,
/// waiting for the user's approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConflictResolution {
    /// The worktree it waits in.
    pub worktree: String,
    pub branch: String,
    /// What was merged in: `<remote>/<base>`.
    pub base: String,
    /// The branch's commit before the merge, where a discard goes back to.
    pub before: String,
    /// The files that had conflicts, which Claude edited.
    pub conflicted: Vec<String>,
    /// Every file the merge changes on the branch, with git's status letter.
    pub changed: Vec<ChangedFile>,
    /// What the merge does to the conflicted files on the branch: the diff
    /// against the branch's commit.
    pub diff: String,
    /// What Claude said it did; empty for a merge picked up again.
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChangedFile {
    /// `A`, `M`, `D`, `R`…
    pub status: String,
    pub path: String,
}

/// Whether a line is one of git's conflict markers (the `=======` between
/// the sides is left out: Markdown and RST use it as a heading underline).
fn is_marker(line: &str) -> bool {
    line.starts_with("<<<<<<< ")
        || line.starts_with(">>>>>>> ")
        || line == "<<<<<<<"
        || line == ">>>>>>>"
}

/// The files of `conflicted` under `dir` that still hold conflict markers.
fn files_with_markers(dir: &Path, conflicted: &[String]) -> Vec<String> {
    conflicted
        .iter()
        .filter(|f| {
            std::fs::read(dir.join(f))
                .map(|bytes| String::from_utf8_lossy(&bytes).lines().any(is_marker))
                .unwrap_or(false)
        })
        .cloned()
        .collect()
}

fn merging(dir: &Path) -> bool {
    git_in(dir, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok()
}

fn lines(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

impl Repo {
    fn pr_worktree(&self, branch: &str) -> Result<PathBuf> {
        self.worktrees()?
            .into_iter()
            .find(|w| w.branch.as_deref() == Some(branch))
            .map(|w| PathBuf::from(w.path))
            .ok_or_else(|| {
                Error::Message(format!(
                    "Check the pull request out first: its branch {branch} is in no worktree."
                ))
            })
    }

    /// Merge `base` (fetched from the GitHub remote) into the worktree that
    /// has `branch` checked out, then run `command` there to resolve the
    /// conflicts: it gets the conflicted files on stdin and in
    /// `GITP_CONFLICT_FILES`, edits them, and must leave no conflict marker,
    /// no new file and no commit. The merge then waits, staged, for
    /// [`Repo::approve_conflict_resolution`] or
    /// [`Repo::discard_conflict_resolution`]. A worktree already waiting with
    /// a resolved merge is shown again as it is. Any failure puts the branch
    /// back.
    pub fn resolve_pr_conflicts(
        &self,
        number: u64,
        head: &str,
        branch: &str,
        base: &str,
        command: &str,
    ) -> Result<ConflictResolution> {
        let remote = self
            .github_remote_name()
            .ok_or_else(|| Error::Message("This repository has no GitHub remote.".into()))?;
        self.resolve_conflicts_from(&remote, number, head, branch, base, command)
    }

    /// [`Repo::resolve_pr_conflicts`] with the base fetched from `remote`.
    fn resolve_conflicts_from(
        &self,
        remote: &str,
        number: u64,
        head: &str,
        branch: &str,
        base: &str,
        command: &str,
    ) -> Result<ConflictResolution> {
        let dir = self.pr_worktree(branch)?;
        let base_ref = format!("{remote}/{base}");
        if merging(&dir) {
            let unmerged = lines(&git_in(&dir, &["diff", "--name-only", "--diff-filter=U"])?);
            if unmerged.is_empty() {
                let before = git_in(&dir, &["rev-parse", "HEAD"])?;
                return self.resolution_preview(&dir, branch, &base_ref, &before, String::new());
            }
            return Err(Error::Message(format!(
                "{} is in the middle of a merge with conflicts left: finish or abort it there first.",
                dir.display()
            )));
        }
        let command = command.trim();
        if command.is_empty() {
            return Err(Error::Message(
                "No command to resolve conflicts with.".into(),
            ));
        }
        require_clean(&dir)?;
        self.ensure_pull_request_head(number, head)?;
        require_contains(&dir, head)?;
        self.run_git_network(&["fetch", "--no-tags", remote, base])?;
        let before = git_in(&dir, &["rev-parse", "HEAD"])?;

        let run = || -> Result<ConflictResolution> {
            // Exit 1 is "conflicts"; what is left unmerged says which.
            let merged = git_in(&dir, &["merge", "--no-ff", "--no-commit", &base_ref]);
            if !merging(&dir) {
                return Err(match merged {
                    Err(e) => e,
                    Ok(_) => Error::Message(format!(
                        "{branch} already has everything in {base_ref}: nothing to merge."
                    )),
                });
            }
            let conflicted = lines(&git_in(&dir, &["diff", "--name-only", "--diff-filter=U"])?);
            let mut summary = String::new();
            if !conflicted.is_empty() {
                let input = format!(
                    "Merging {base_ref} into {branch} stopped with conflicts in these files:\n{}\n",
                    conflicted.join("\n")
                );
                let out = run_shell(
                    &dir,
                    command,
                    input.as_bytes(),
                    &[
                        ("GITP_CONFLICT_FILES", conflicted.join("\n")),
                        ("GITP_MERGE_BASE_REF", base_ref.clone()),
                        ("GITP_BRANCH", branch.to_string()),
                    ],
                    FIX_TIMEOUT,
                    &self.net,
                )?;
                summary = claude_answer(&out.stdout)?.0.trim().to_string();
                if git_in(&dir, &["rev-parse", "HEAD"])? != before || !merging(&dir) {
                    return Err(Error::Message(
                        "Claude committed or ended the merge itself; it was undone.".into(),
                    ));
                }
                let left = files_with_markers(&dir, &conflicted);
                if !left.is_empty() {
                    return Err(Error::Message(format!(
                        "Conflict markers are still in {}; the merge was undone.",
                        left.join(", ")
                    )));
                }
                let untracked = git_in(&dir, &["ls-files", "--others", "--exclude-standard"])?;
                if !untracked.is_empty() {
                    return Err(Error::Message(format!(
                        "Claude left new files behind ({}); the merge was undone.",
                        lines(&untracked).join(", ")
                    )));
                }
                let mut add = vec!["add", "--"];
                add.extend(conflicted.iter().map(String::as_str));
                git_in(&dir, &add)?;
            }
            self.resolution_preview(&dir, branch, &base_ref, &before, summary)
        };
        run().map_err(|e| self.undo_merge(&dir, branch, &before, e))
    }

    fn resolution_preview(
        &self,
        dir: &Path,
        branch: &str,
        base_ref: &str,
        before: &str,
        summary: String,
    ) -> Result<ConflictResolution> {
        // The files both sides changed since they split are the ones that
        // could conflict; of those, the ones this merge changes on the branch.
        let merge_head = git_in(dir, &["rev-parse", "MERGE_HEAD"])?;
        let split = git_in(dir, &["merge-base", before, &merge_head])?;
        let ours = lines(&git_in(dir, &["diff", "--name-only", &split, before])?);
        let changed: Vec<ChangedFile> = lines(&git_in(
            dir,
            &["diff", "--cached", "--name-status", "HEAD"],
        )?)
        .into_iter()
        .filter_map(|l| {
            let mut parts = l.split('\t');
            let status = parts.next()?.chars().next()?.to_string();
            let path = parts.next_back()?.to_string();
            Some(ChangedFile { status, path })
        })
        .collect();
        let conflicted: Vec<String> = changed
            .iter()
            .filter(|c| ours.contains(&c.path))
            .map(|c| c.path.clone())
            .collect();
        let mut args = vec!["diff", "--cached", "HEAD", "--"];
        args.extend(conflicted.iter().map(String::as_str));
        let diff = if conflicted.is_empty() {
            String::new()
        } else {
            git_in(dir, &args)?
        };
        Ok(ConflictResolution {
            worktree: dir.to_string_lossy().into_owned(),
            branch: branch.to_string(),
            base: base_ref.to_string(),
            before: before.to_string(),
            conflicted,
            changed,
            diff,
            summary,
        })
    }

    /// Commit the waiting merge in `branch`'s worktree and push the branch,
    /// so GitHub sees the conflicts resolved. Refused unless the worktree is
    /// still mid-merge at `before` with nothing unresolved — or holds the
    /// merge committed already on `before`, whose push failed: then it is
    /// pushed again. Returns the merge commit.
    ///
    /// The repository's pre-commit and commit-msg hooks don't run, as they
    /// don't for a merge git commits by itself: they would check again every
    /// file the base brought in, checked when it landed there, with tools a
    /// fresh worktree often lacks (a project's node_modules, a formatter's
    /// JDK). The resolution itself was approved in the preview.
    pub fn approve_conflict_resolution(&self, branch: &str, before: &str) -> Result<String> {
        let dir = self.pr_worktree(branch)?;
        let head = git_in(&dir, &["rev-parse", "HEAD"])?;
        // A merge commit (two parents) whose first parent is `before`.
        let parents = git_in(&dir, &["rev-list", "--parents", "-n", "1", &head])?;
        let parents: Vec<&str> = parents.split(' ').skip(1).collect();
        let committed_already = !merging(&dir) && parents.len() == 2 && parents[0] == before;
        let commit = if committed_already {
            head
        } else {
            if !merging(&dir) || head != before {
                return Err(Error::Message(
                    "The merge isn't waiting any more: resolve the conflicts again.".into(),
                ));
            }
            if !git_in(&dir, &["diff", "--name-only", "--diff-filter=U"])?.is_empty() {
                return Err(Error::Message(
                    "Some conflicts are still unresolved.".into(),
                ));
            }
            git_in(&dir, &["commit", "-q", "--no-edit", "--no-verify"]).map_err(|e| {
                Error::Message(format!(
                    "Couldn't commit the merge: {e}\n\nIt still waits, staged, in {}.",
                    dir.display()
                ))
            })?;
            git_in(&dir, &["rev-parse", "HEAD"])?
        };
        self.push_branch(branch, None).map_err(|e| {
            Error::Message(format!(
                "The merge is committed on {branch} ({}) but the push failed: {e}\n\nApprove again, or push {branch}, to send it.",
                &commit[..commit.len().min(7)]
            ))
        })?;
        Ok(commit)
    }

    /// Abort the waiting merge in `branch`'s worktree, back to `before`.
    pub fn discard_conflict_resolution(&self, branch: &str, before: &str) -> Result<()> {
        let dir = self.pr_worktree(branch)?;
        if merging(&dir) {
            let _ = git_in(&dir, &["merge", "--abort"]);
        }
        undo_fix(&dir, branch, before)
    }

    fn undo_merge(&self, dir: &Path, branch: &str, before: &str, e: Error) -> Error {
        if merging(dir) {
            let _ = git_in(dir, &["merge", "--abort"]);
        }
        match undo_fix(dir, branch, before) {
            Ok(()) => e,
            Err(undo) => Error::Message(format!(
                "{e}\n\nAnd the undo failed in {}: {undo}",
                dir.display()
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A GitHub-like `origin` (bare) whose `main` and `feature` both changed
    /// line 2 of `a.txt`, a clone with `feature` in a worktree of its own.
    fn setup() -> (tempfile::TempDir, Repo, PathBuf, String) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let seed = root.join("seed");
        std::fs::create_dir(&seed).unwrap();
        git(&seed, &["init", "-q", "-b", "main"]);
        git(&seed, &["config", "user.email", "t@t"]);
        git(&seed, &["config", "user.name", "t"]);
        std::fs::write(seed.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(seed.join("b.txt"), "b\n").unwrap();
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-qm", "start"]);
        git(&seed, &["checkout", "-qb", "feature"]);
        std::fs::write(seed.join("a.txt"), "one\nTWO feature\nthree\n").unwrap();
        git(&seed, &["commit", "-qam", "feature"]);
        git(&seed, &["checkout", "-q", "main"]);
        std::fs::write(seed.join("a.txt"), "one\nTWO main\nthree\n").unwrap();
        std::fs::write(seed.join("b.txt"), "b main\n").unwrap();
        git(&seed, &["commit", "-qam", "main"]);
        let bare = root.join("hello.git");
        git(
            root,
            &[
                "clone",
                "-q",
                "--bare",
                seed.to_str().unwrap(),
                bare.to_str().unwrap(),
            ],
        );
        let clone = root.join("clone");
        git(
            root,
            &[
                "clone",
                "-q",
                bare.to_str().unwrap(),
                clone.to_str().unwrap(),
            ],
        );
        git(&clone, &["config", "user.email", "t@t"]);
        git(&clone, &["config", "user.name", "t"]);
        let wt = root.join("wt");
        git(
            &clone,
            &[
                "worktree",
                "add",
                "-q",
                "--track",
                "-b",
                "feature",
                wt.to_str().unwrap(),
                "origin/feature",
            ],
        );
        let head = git(&wt, &["rev-parse", "HEAD"]);
        (tmp, Repo::open(&clone).unwrap(), wt, head)
    }

    #[test]
    fn markers_are_git_s_own() {
        assert!(is_marker("<<<<<<< HEAD"));
        assert!(is_marker(">>>>>>> origin/main"));
        assert!(!is_marker("======="));
        assert!(!is_marker("<<<<<<<< not quite"));
    }

    #[test]
    fn a_marker_left_is_found() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("x"), "a\n<<<<<<< HEAD\nb\n").unwrap();
        std::fs::write(dir.path().join("y"), "a\n=======\nb\n").unwrap();
        assert_eq!(
            files_with_markers(dir.path(), &["x".into(), "y".into()]),
            ["x"]
        );
    }

    #[test]
    fn claude_s_edit_waits_for_approval_then_is_committed_and_pushed() {
        let (_tmp, repo, wt, head) = setup();
        let resolve = "printf 'one\\nTWO both\\nthree\\n' > a.txt; echo resolved it";
        let r = repo
            .resolve_conflicts_from("origin", 7, &head, "feature", "main", resolve)
            .unwrap();
        assert_eq!(r.conflicted, ["a.txt"]);
        assert_eq!(r.summary, "resolved it");
        assert!(r.diff.contains("+TWO both"), "{}", r.diff);
        let paths: Vec<_> = r
            .changed
            .iter()
            .map(|c| (c.status.as_str(), c.path.as_str()))
            .collect();
        assert_eq!(paths, [("M", "a.txt"), ("M", "b.txt")]);
        assert_eq!(
            git(&wt, &["rev-parse", "HEAD"]),
            head,
            "nothing committed before the approval"
        );

        // Shown again as it is, without running anything.
        let again = repo
            .resolve_conflicts_from("origin", 7, &head, "feature", "main", "exit 1")
            .unwrap();
        assert_eq!(again.conflicted, ["a.txt"]);

        let merge = repo
            .approve_conflict_resolution("feature", &r.before)
            .unwrap();
        assert_eq!(
            git(&wt, &["rev-list", "--parents", "-n", "1", "HEAD"])
                .split(' ')
                .count(),
            3
        );
        let pushed = git(&_tmp.path().join("hello.git"), &["rev-parse", "feature"]);
        assert_eq!(pushed, merge);
    }

    #[test]
    fn markers_left_undo_the_merge() {
        let (_tmp, repo, wt, head) = setup();
        let err = repo
            .resolve_conflicts_from("origin", 7, &head, "feature", "main", "echo did nothing")
            .unwrap_err();
        assert!(
            err.to_string()
                .contains("Conflict markers are still in a.txt"),
            "{err}"
        );
        assert!(!merging(&wt));
        assert_eq!(git(&wt, &["rev-parse", "HEAD"]), head);
        assert_eq!(git(&wt, &["status", "--porcelain"]), "");
    }

    #[test]
    fn the_repository_s_commit_hooks_don_t_stop_the_merge_commit() {
        let (tmp, repo, wt, head) = setup();
        let hooks = tmp.path().join("hooks");
        std::fs::create_dir(&hooks).unwrap();
        for hook in ["pre-commit", "commit-msg"] {
            let path = hooks.join(hook);
            std::fs::write(
                &path,
                "#!/bin/sh\necho needs tools this worktree lacks >&2\nexit 1\n",
            )
            .unwrap();
            std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o755))
                .unwrap();
        }
        git(&wt, &["config", "core.hooksPath", hooks.to_str().unwrap()]);
        let r = repo
            .resolve_conflicts_from(
                "origin",
                7,
                &head,
                "feature",
                "main",
                "printf 'one\\nTWO both\\nthree\\n' > a.txt",
            )
            .unwrap();
        let merge = repo
            .approve_conflict_resolution("feature", &r.before)
            .unwrap();
        assert_eq!(
            git(&tmp.path().join("hello.git"), &["rev-parse", "feature"]),
            merge
        );
    }

    #[test]
    fn a_failed_push_keeps_the_commit_and_approving_again_pushes_it() {
        let (tmp, repo, wt, head) = setup();
        let r = repo
            .resolve_conflicts_from(
                "origin",
                7,
                &head,
                "feature",
                "main",
                "printf 'one\\nTWO both\\nthree\\n' > a.txt",
            )
            .unwrap();
        let bare = tmp.path().join("hello.git");
        git(
            &wt,
            &[
                "remote",
                "set-url",
                "--push",
                "origin",
                tmp.path().join("nowhere.git").to_str().unwrap(),
            ],
        );
        let err = repo
            .approve_conflict_resolution("feature", &r.before)
            .unwrap_err();
        assert!(err.to_string().contains("is committed on feature"), "{err}");
        assert!(!merging(&wt));
        let merge = git(&wt, &["rev-parse", "HEAD"]);
        assert_ne!(merge, head);

        git(
            &wt,
            &[
                "remote",
                "set-url",
                "--push",
                "origin",
                bare.to_str().unwrap(),
            ],
        );
        assert_eq!(
            repo.approve_conflict_resolution("feature", &r.before)
                .unwrap(),
            merge
        );
        assert_eq!(git(&bare, &["rev-parse", "feature"]), merge);
    }

    #[test]
    fn a_discard_puts_the_branch_back() {
        let (_tmp, repo, wt, head) = setup();
        let r = repo
            .resolve_conflicts_from(
                "origin",
                7,
                &head,
                "feature",
                "main",
                "printf 'x\\n' > a.txt",
            )
            .unwrap();
        repo.discard_conflict_resolution("feature", &r.before)
            .unwrap();
        assert!(!merging(&wt));
        assert_eq!(git(&wt, &["rev-parse", "HEAD"]), head);
        assert_eq!(git(&wt, &["status", "--porcelain"]), "");
    }

    #[test]
    fn a_commit_by_claude_is_undone() {
        let (_tmp, repo, wt, head) = setup();
        let cmd = "printf 'one\\n' > a.txt; git add a.txt; git -c user.name=c -c user.email=c commit -qm sneaky";
        let err = repo
            .resolve_conflicts_from("origin", 7, &head, "feature", "main", cmd)
            .unwrap_err();
        assert!(err.to_string().contains("committed"), "{err}");
        assert_eq!(git(&wt, &["rev-parse", "HEAD"]), head);
    }
}
