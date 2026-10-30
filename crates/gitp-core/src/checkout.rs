//! Branch checkout — the first operation that mutates the working tree.

use serde::Serialize;

use crate::error::{Error, Result};
use crate::remote::ref_arg;
use crate::repo::Repo;

/// What [`Repo::stash_and_switch`] did.
#[derive(Debug, Clone, Serialize)]
pub struct StashSwitch {
    /// git's output from the switch and the pop.
    pub output: String,
    /// Re-applying the work on the new HEAD conflicted: the files carry
    /// conflict markers and the auto-stash is still on the stack (`stash@{0}`).
    pub stash_kept: bool,
    /// What was staged couldn't be staged again on the new HEAD, so the work
    /// came back all unstaged.
    pub staging_lost: bool,
}

impl Repo {
    /// Check out `name` (a branch or any revision), updating the working tree and
    /// HEAD. A *safe* checkout: it refuses rather than clobbering uncommitted
    /// local modifications. When switching would overwrite conflicting changes,
    /// nothing is touched — HEAD stays put and the working tree is preserved —
    /// and a clear, actionable error is returned instead of git2's cryptic one.
    pub fn checkout_branch(&self, name: &str) -> Result<()> {
        self.refuse_switch_mid_operation(name)?;
        // A local branch wins over anything else called `name`. `revparse_ext`
        // follows git's DWIM order, which tries `refs/tags/<name>` *before*
        // `refs/heads/<name>` — so with a same-named tag it would hand back the
        // tag, and attaching HEAD to that makes every later commit move the tag.
        let (object, reference) = match self.inner.find_branch(name, git2::BranchType::Local) {
            Ok(branch) => {
                // HEAD is attached below with a plain ref write, which (unlike
                // `git checkout`) wouldn't stop two worktrees sharing a branch.
                if let Some(path) = self.branch_checked_out_elsewhere(name) {
                    return Err(Error::Message(format!(
                        "Can't switch to {name}: it is already checked out in the worktree \
                         at {path}. Open that worktree instead — nothing was changed."
                    )));
                }
                let reference = branch.into_reference();
                (reference.peel(git2::ObjectType::Any)?, Some(reference))
            }
            Err(_) => self.inner.revparse_ext(name)?,
        };

        let mut checkout = git2::build::CheckoutBuilder::new();
        checkout.safe();
        if let Err(e) = self.inner.checkout_tree(&object, Some(&mut checkout)) {
            // A safe checkout aborts (touching nothing) when local changes would
            // be overwritten. Turn that into a message that says what to do.
            if e.code() == git2::ErrorCode::Conflict {
                return Err(Error::Message(format!(
                    "Can't switch to {name}: you have uncommitted changes that would be \
                     overwritten. Commit or stash them first — nothing was changed."
                )));
            }
            return Err(e.into());
        }

        // Point HEAD at the branch ref when there is one; otherwise detach —
        // only a branch may be HEAD's symbolic target, never a tag or other ref.
        // Write the same "checkout: moving from A to B" HEAD-reflog message the
        // `git` CLI uses, so switches made here show up in the Recent list
        // (which is read from that reflog). git2's plain set_head wouldn't.
        match reference
            .as_ref()
            .filter(|r| r.is_branch())
            .and_then(git2::Reference::name)
        {
            Some(refname) => {
                let from = self
                    .inner
                    .head()
                    .ok()
                    .and_then(|h| h.shorthand().map(str::to_string))
                    .unwrap_or_default();
                let to = reference
                    .as_ref()
                    .and_then(git2::Reference::shorthand)
                    .unwrap_or(name);
                let msg = format!("checkout: moving from {from} to {to}");
                self.inner.reference_symbolic("HEAD", refname, true, &msg)?;
            }
            None => self.inner.set_head_detached(object.id())?,
        }
        Ok(())
    }

    /// Check out a remote-tracking branch (e.g. `origin/draft-develop/3.34.0`).
    /// If a local branch of the corresponding name already exists, just switch
    /// to it; otherwise create a local branch tracking the remote and switch.
    /// Returns git's output for display.
    pub fn checkout_remote(&self, remote_ref: &str) -> Result<String> {
        let remote_ref = ref_arg(remote_ref)?;
        self.refuse_switch_mid_operation(remote_ref)?;
        let local = self.local_name_for_remote(remote_ref);
        if self
            .inner
            .find_branch(&local, git2::BranchType::Local)
            .is_ok()
        {
            self.checkout_branch(&local)?;
            return Ok(format!("Switched to {local}"));
        }
        // Shelling out gives git's DWIM tracking setup, hooks, and reflog.
        self.run_git(&["checkout", "-b", &local, "--track", remote_ref])
    }

    /// The local branch name for a remote-tracking ref: strip the remote name
    /// prefix (`origin/foo/bar` → `foo/bar`). Falls back to dropping the first
    /// path segment when the remote can't be matched.
    fn local_name_for_remote(&self, remote_ref: &str) -> String {
        if let Ok(remotes) = self.inner.remotes() {
            for remote in remotes.iter().flatten() {
                if let Some(rest) = remote_ref.strip_prefix(&format!("{remote}/")) {
                    return rest.to_string();
                }
            }
        }
        remote_ref
            .split_once('/')
            .map_or(remote_ref, |x| x.1)
            .to_string()
    }

    /// Create a branch named `name` at the current HEAD commit and check it out.
    /// Errors if the branch already exists.
    pub fn create_branch(&self, name: &str) -> Result<()> {
        // Checked before the branch exists, so a refusal leaves no stray branch.
        self.refuse_switch_mid_operation(name)?;
        let head = self.inner.head()?.peel_to_commit()?;
        self.inner.branch(name, &head, false)?;
        self.checkout_branch(name)
    }

    /// Stash & Switch: put the uncommitted work (untracked files included)
    /// away as "Auto-stash before switching to <target>", run `switch`, then
    /// pop the stash on the new HEAD — staged and unstaged apart, as they were
    /// — so local changes that would clash with `target` no longer block the
    /// switch.
    ///
    /// The work is never left only in the stash without saying so: when the
    /// switch itself fails, the stash goes straight back onto the original
    /// HEAD (staged state included) and the switch's error is returned. When
    /// the pop on the new HEAD conflicts, git keeps the entry and leaves the
    /// markers; that's a successful switch with `stash_kept` set.
    pub fn stash_and_switch(
        &self,
        target: &str,
        switch: impl FnOnce(&Repo) -> Result<String>,
    ) -> Result<StashSwitch> {
        // Stashing mid-merge would fail on the unmerged files anyway, but the
        // refusal says why.
        self.refuse_switch_mid_operation(target)?;
        let message = format!("Auto-stash before switching to {target}");
        let before = self.stash_top();
        self.run_git(&["stash", "push", "--include-untracked", "-m", &message])?;
        // "No local changes to save" pushes nothing: only pop what we pushed.
        let stashed = self.stash_top() != before;

        let output = match switch(self) {
            Ok(out) => out,
            Err(e) if stashed => {
                return Err(match self.run_git(&["stash", "pop", "--index"]) {
                    Ok(_) => Error::Message(format!(
                        "{e}\n\nYour uncommitted changes were put back as they were."
                    )),
                    Err(pop) => Error::Message(format!(
                        "{e}\n\nPutting your uncommitted changes back failed too; they are \
                         safe in stash@{{0}} (\"{message}\").\n\n{pop}"
                    )),
                });
            }
            Err(e) => return Err(e),
        };
        if !stashed {
            return Ok(StashSwitch {
                output,
                stash_kept: false,
                staging_lost: false,
            });
        }
        // `--index` stages again what was staged. When that part won't apply
        // to the new HEAD's index, git refuses before touching anything
        // ("Try without --index"; LC_ALL=C keeps that matchable), and a plain
        // pop still brings the work back — all unstaged, which is reported.
        let mut staging_lost = false;
        let popped = match self.run_git_env(&["stash", "pop", "--index"], &[("LC_ALL", "C")]) {
            Err(e) if e.to_string().contains("Try without --index") => {
                staging_lost = true;
                self.run_git(&["stash", "pop"])
            }
            other => other,
        };
        match popped {
            Ok(pop) => Ok(StashSwitch {
                output: format!("{output}\n{pop}").trim().to_string(),
                stash_kept: false,
                staging_lost,
            }),
            // HEAD has moved, so this is still a switch: report the pop's
            // trouble alongside it rather than as a failure of the switch.
            Err(pop) => Ok(StashSwitch {
                output: pop.to_string(),
                stash_kept: self.stash_top() != before,
                staging_lost,
            }),
        }
    }

    /// The commit at the top of the stash stack, if any.
    fn stash_top(&self) -> Option<git2::Oid> {
        self.inner.refname_to_id("refs/stash").ok()
    }

    /// Refuse to move HEAD while a merge (squash included), rebase,
    /// cherry-pick or revert is paused, as `git switch` does. git2's checkout (and `git checkout`) would
    /// switch anyway when the files happen not to clash: the pending merge then
    /// commits onto the new branch, and a continued rebase rewrites the branch
    /// switched to.
    pub(crate) fn refuse_switch_mid_operation(&self, target: &str) -> Result<()> {
        let git_dir = self.inner.path();
        let op = if git_dir.join("MERGE_HEAD").exists() {
            "a merge"
        } else if git_dir.join("rebase-merge").is_dir() || git_dir.join("rebase-apply").is_dir() {
            "a rebase"
        } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
            "a cherry-pick"
        } else if git_dir.join("REVERT_HEAD").exists() {
            "a revert"
        } else if self.squash_pending() {
            "a squash merge"
        } else {
            return Ok(());
        };
        Err(Error::Message(format!(
            "Can't switch to {target}: {op} is in progress. Finish or abort it first \
             — nothing was changed."
        )))
    }
}
