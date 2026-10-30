//! Interactive multi-commit cherry-pick: apply an edited plan of commits
//! (reordered, each picked / reworded / squashed / dropped) onto HEAD.
//!
//! Each step is an ordinary `git cherry-pick <sha>`, so a conflict stops the
//! run exactly like a single cherry-pick does — CHERRY_PICK_HEAD, the conflict
//! banner and the resolver all apply unchanged. A reword amends the picked
//! commit's message afterwards; a squash picks the commit and then folds it
//! into the one below, combining both messages. (Picking with `--no-commit`
//! would give the same tree, but a conflict then leaves no CHERRY_PICK_HEAD
//! and the resolver couldn't tell a cherry-pick was under way.)
//!
//! When a step conflicts, the rest of the plan — starting with the stopped
//! step, whose reword/squash still has to happen once it's committed — is
//! saved to `<git-dir>/gitp-pick-plan`, and [`Repo::continue_cherry_pick_plan`]
//! picks it up after the user has resolved and continued the cherry-pick.

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::remote::ref_arg;
use crate::repo::Repo;

/// What to do with a commit in a cherry-pick plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PickAction {
    Pick,
    /// Pick, then replace the message with the step's `message`.
    Reword,
    /// Pick, then meld into the previously picked commit, keeping both messages.
    Squash,
    Drop,
}

impl PickAction {
    fn name(self) -> &'static str {
        match self {
            PickAction::Pick => "pick",
            PickAction::Reword => "reword",
            PickAction::Squash => "squash",
            PickAction::Drop => "drop",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "pick" => PickAction::Pick,
            "reword" => PickAction::Reword,
            "squash" => PickAction::Squash,
            "drop" => PickAction::Drop,
            _ => return None,
        })
    }
}

/// One planned step: a commit, its action, and (for reword) the new message.
#[derive(Debug, Clone, Deserialize)]
pub struct PickStep {
    pub sha: String,
    pub action: PickAction,
    pub message: Option<String>,
}

/// How far a plan run got.
#[derive(Debug, Clone, Serialize)]
pub struct PickPlanOutcome {
    /// git's output from the steps applied by this call.
    pub output: String,
    /// The run stopped on a conflict; the rest is saved for
    /// [`Repo::continue_cherry_pick_plan`].
    pub paused: bool,
    /// HEAD before the plan's first step — where undoing the whole run goes.
    pub start_head: String,
}

/// The saved remainder of a paused plan.
struct SavedPlan {
    start_head: String,
    /// HEAD when the conflicting step stopped. Still HEAD after "continue"
    /// means the stopped commit was never made (the cherry-pick was aborted).
    stopped_head: String,
    /// The stopped step first, then the steps not yet started.
    steps: Vec<PickStep>,
}

const PLAN_FILE: &str = "gitp-pick-plan";

impl Repo {
    /// Apply `steps` (already in the desired order) onto HEAD. A conflict is
    /// not an error: it returns `paused: true` with the cherry-pick left in
    /// progress for the resolver. Any other failure stops the run with `Err`.
    pub fn cherry_pick_plan(&self, steps: &[PickStep]) -> Result<PickPlanOutcome> {
        // Like a rebase todo: there must be a picked commit to squash into.
        if let Some(first) = steps.iter().find(|s| s.action != PickAction::Drop) {
            if first.action == PickAction::Squash {
                return Err(Error::Message(
                    "The first commit can't be squashed into a previous one.".into(),
                ));
            }
        }
        for step in steps {
            ref_arg(&step.sha)?;
            if step.action == PickAction::Reword
                && step.message.as_deref().unwrap_or("").trim().is_empty()
            {
                return Err(Error::Message(format!(
                    "The new message for {} is empty.",
                    short(&step.sha)
                )));
            }
        }
        self.remove_pick_plan();
        let start_head = self.head_commit_id()?;
        self.run_pick_steps(start_head, steps.to_vec(), Vec::new())
    }

    /// Resume a plan paused by a conflict, once the user has resolved it and
    /// the stopped cherry-pick has been committed: finish that step's reword or
    /// squash, then run the rest.
    pub fn continue_cherry_pick_plan(&self) -> Result<PickPlanOutcome> {
        let plan = self
            .load_pick_plan()
            .ok_or_else(|| Error::Message("No cherry-pick plan is paused.".into()))?;
        if self.inner.path().join("CHERRY_PICK_HEAD").exists() {
            return Err(Error::Message(
                "The conflicted cherry-pick isn't finished yet.".into(),
            ));
        }
        if self.head_commit_id()? == plan.stopped_head {
            self.remove_pick_plan();
            return Err(Error::Message(
                "The conflicted commit wasn't cherry-picked, so the rest of the plan was cancelled."
                    .into(),
            ));
        }
        let mut steps = plan.steps.into_iter();
        let mut output = Vec::new();
        if let Some(stopped) = steps.next() {
            if let Err(e) = self.finish_pick_step(&stopped) {
                self.remove_pick_plan();
                return Err(e);
            }
            output.push(format!("Cherry-picked {}.", short(&stopped.sha)));
        }
        self.run_pick_steps(plan.start_head, steps.collect(), output)
    }

    fn run_pick_steps(
        &self,
        start_head: String,
        steps: Vec<PickStep>,
        mut output: Vec<String>,
    ) -> Result<PickPlanOutcome> {
        for (i, step) in steps.iter().enumerate() {
            if step.action == PickAction::Drop {
                continue;
            }
            let before = self.head_commit_id()?;
            match self.run_git(&["cherry-pick", ref_arg(&step.sha)?]) {
                Ok(out) => output.push(out),
                Err(e) => {
                    // Unmerged paths: hand over to the resolver and keep the rest.
                    if self.inner.path().join("CHERRY_PICK_HEAD").exists()
                        && !self.unmerged_paths()?.is_empty()
                    {
                        self.save_pick_plan(&SavedPlan {
                            start_head: start_head.clone(),
                            stopped_head: before,
                            steps: steps[i..].to_vec(),
                        })?;
                        output.push(e.to_string());
                        return Ok(PickPlanOutcome {
                            output: output.join("\n"),
                            paused: true,
                            start_head,
                        });
                    }
                    self.remove_pick_plan();
                    return Err(e);
                }
            }
            self.finish_pick_step(step)?;
        }
        self.remove_pick_plan();
        Ok(PickPlanOutcome {
            output: output.join("\n"),
            paused: false,
            start_head,
        })
    }

    /// The part of a step that comes after its cherry-pick commit exists.
    /// `--no-verify`: only the message changes (or two already-accepted
    /// commits combine), and cherry-pick itself runs no pre-commit hook.
    fn finish_pick_step(&self, step: &PickStep) -> Result<()> {
        match step.action {
            PickAction::Reword => {
                let message = step.message.as_deref().unwrap_or("");
                self.run_git(&["commit", "--amend", "--no-verify", "-m", message])?;
            }
            PickAction::Squash => {
                let message = format!(
                    "{}\n\n{}",
                    self.run_git(&["log", "-1", "--format=%B", "HEAD~1"])?,
                    self.run_git(&["log", "-1", "--format=%B", "HEAD"])?
                );
                self.run_git(&["reset", "--soft", "HEAD~1"])?;
                self.run_git(&["commit", "--amend", "--no-verify", "-m", &message])?;
            }
            PickAction::Pick | PickAction::Drop => {}
        }
        Ok(())
    }

    fn save_pick_plan(&self, plan: &SavedPlan) -> Result<()> {
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut text = format!("start {}\nstopped {}\n", plan.start_head, plan.stopped_head);
        for step in &plan.steps {
            let message = step.message.as_deref().map(|m| b64.encode(m));
            text.push_str(&format!(
                "{} {} {}\n",
                step.action.name(),
                step.sha,
                message.as_deref().unwrap_or("-")
            ));
        }
        std::fs::write(self.inner.path().join(PLAN_FILE), text)
            .map_err(|e| Error::Message(format!("can't save the cherry-pick plan: {e}")))
    }

    fn load_pick_plan(&self) -> Option<SavedPlan> {
        let text = std::fs::read_to_string(self.inner.path().join(PLAN_FILE)).ok()?;
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut lines = text.lines();
        let start_head = lines.next()?.strip_prefix("start ")?.to_string();
        let stopped_head = lines.next()?.strip_prefix("stopped ")?.to_string();
        let mut steps = Vec::new();
        for line in lines {
            let mut parts = line.split(' ');
            let action = PickAction::from_name(parts.next()?)?;
            let sha = parts.next()?.to_string();
            let message = match parts.next()? {
                "-" => None,
                m => Some(String::from_utf8(b64.decode(m).ok()?).ok()?),
            };
            steps.push(PickStep {
                sha,
                action,
                message,
            });
        }
        Some(SavedPlan {
            start_head,
            stopped_head,
            steps,
        })
    }

    fn remove_pick_plan(&self) {
        let _ = std::fs::remove_file(self.inner.path().join(PLAN_FILE));
    }
}

fn short(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}
