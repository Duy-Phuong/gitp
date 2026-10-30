//! Git Flow — initialise, start and finish feature / release / hotfix branches
//! — done with plain git, so the `git-flow` tool needn't be installed.
//!
//! The settings live where git-flow keeps them (`gitflow.branch.master`,
//! `gitflow.branch.develop`, `gitflow.prefix.*` in the repo's config), so a
//! repository set up here works with the command-line tool and vice versa.
//!
//! A finish is several git commands in a row. When one stops — a merge
//! conflict, a branch checked out elsewhere — the rest are left undone and the
//! error says which; the merge is left in progress for the conflict resolver.
//! Every step is safe to repeat (merging an already merged branch is a no-op,
//! an existing tag on the right commit is kept), so after resolving, running
//! Finish again completes what remains.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::remote::ref_arg;
use crate::repo::Repo;

/// A repository's Git Flow settings: the two long-lived branches and the
/// prefixes that mark the short-lived ones.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitFlowConfig {
    /// Where releases land (`gitflow.branch.master`), e.g. `main`.
    pub production: String,
    /// Where features are integrated (`gitflow.branch.develop`).
    pub develop: String,
    pub feature: String,
    pub release: String,
    pub hotfix: String,
    /// Put in front of a release's or hotfix's name to make its tag, e.g. `v`.
    /// May be empty.
    pub version_tag: String,
}

/// The kinds of Git Flow branch gitp starts and finishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FlowKind {
    Feature,
    Release,
    Hotfix,
}

impl FlowKind {
    fn word(self) -> &'static str {
        match self {
            FlowKind::Feature => "feature",
            FlowKind::Release => "release",
            FlowKind::Hotfix => "hotfix",
        }
    }
}

impl GitFlowConfig {
    fn prefix(&self, kind: FlowKind) -> &str {
        match kind {
            FlowKind::Feature => &self.feature,
            FlowKind::Release => &self.release,
            FlowKind::Hotfix => &self.hotfix,
        }
    }

    /// Which kind of Git Flow branch `branch` is, and its name without the
    /// prefix — `None` for a branch that isn't one.
    pub fn classify<'a>(&self, branch: &'a str) -> Option<(FlowKind, &'a str)> {
        [FlowKind::Feature, FlowKind::Release, FlowKind::Hotfix]
            .into_iter()
            .find_map(|kind| {
                let name = branch.strip_prefix(self.prefix(kind))?;
                (!name.is_empty()).then_some((kind, name))
            })
    }
}

/// One step of a finish, kept as data so a stop can say what is still to do.
enum Step {
    /// Switch to the branch, then merge the flow branch into it (`--no-ff`).
    Merge(String),
    /// Tag the branch just merged into, annotated.
    Tag(String),
    Delete,
}

impl Step {
    fn describe(&self, branch: &str) -> String {
        match self {
            Step::Merge(into) => format!("merge {branch} into {into}"),
            Step::Tag(tag) => format!("tag {tag}"),
            Step::Delete => format!("delete {branch}"),
        }
    }
}

impl Repo {
    /// The repository's Git Flow settings, or `None` when it hasn't been
    /// initialised (no production or develop branch configured). A prefix
    /// git-flow didn't write takes its usual default.
    pub fn gitflow_config(&self) -> Result<Option<GitFlowConfig>> {
        let entries = self.gitflow_entries()?;
        let get = |key: &str, default: &str| {
            entries
                .get(key)
                .cloned()
                .unwrap_or_else(|| default.to_string())
        };
        let (Some(production), Some(develop)) = (
            entries.get("gitflow.branch.master"),
            entries.get("gitflow.branch.develop"),
        ) else {
            return Ok(None);
        };
        Ok(Some(GitFlowConfig {
            production: production.clone(),
            develop: develop.clone(),
            feature: get("gitflow.prefix.feature", "feature/"),
            release: get("gitflow.prefix.release", "release/"),
            hotfix: get("gitflow.prefix.hotfix", "hotfix/"),
            version_tag: get("gitflow.prefix.versiontag", ""),
        }))
    }

    /// Every `gitflow.*` config value, keyed by its (lower-cased) name.
    fn gitflow_entries(&self) -> Result<HashMap<String, String>> {
        // `--get-regexp` exits 1, printing nothing, when no key matches.
        let out = match self.run_git(&["config", "--get-regexp", r"^gitflow\."]) {
            Ok(out) => out,
            Err(Error::Message(m)) if m.is_empty() => String::new(),
            Err(e) => return Err(e),
        };
        Ok(out
            .lines()
            .map(|line| {
                let (key, value) = line.split_once(' ').unwrap_or((line, ""));
                (key.to_string(), value.to_string())
            })
            .collect())
    }

    fn require_gitflow(&self) -> Result<GitFlowConfig> {
        self.gitflow_config()?.ok_or_else(|| {
            Error::Message("Git Flow isn't set up in this repository. Initialize it first.".into())
        })
    }

    /// Set the repository up for Git Flow: store `cfg` in its config and create
    /// the develop branch when it doesn't exist — from `origin`'s develop when
    /// there is one, so the two don't start out diverged, else from the
    /// production branch. Nothing is checked out.
    pub fn gitflow_init(&self, cfg: &GitFlowConfig) -> Result<String> {
        let production = ref_arg(&cfg.production)?;
        let develop = ref_arg(&cfg.develop)?;
        if production == develop {
            return Err(Error::Message(
                "The production and develop branches must be different.".into(),
            ));
        }
        // An empty prefix would make every branch a feature (or a release).
        if [&cfg.feature, &cfg.release, &cfg.hotfix]
            .iter()
            .any(|p| p.is_empty())
        {
            return Err(Error::Message(
                "The feature, release and hotfix prefixes can't be empty.".into(),
            ));
        }
        // They start branch and tag names, and are passed to `git config`.
        for prefix in [&cfg.feature, &cfg.release, &cfg.hotfix, &cfg.version_tag] {
            ref_arg(prefix)?;
        }
        if self
            .inner
            .find_branch(production, git2::BranchType::Local)
            .is_err()
        {
            return Err(Error::Message(format!(
                "There is no local branch {production} to use as the production branch."
            )));
        }

        let mut done = Vec::new();
        if self
            .inner
            .find_branch(develop, git2::BranchType::Local)
            .is_err()
        {
            let remote = format!("origin/{develop}");
            if self
                .inner
                .find_branch(&remote, git2::BranchType::Remote)
                .is_ok()
            {
                self.run_git(&["branch", "--track", develop, &remote])?;
                done.push(format!("Created {develop} from {remote}."));
            } else {
                self.run_git(&["branch", develop, production])?;
                done.push(format!("Created {develop} from {production}."));
            }
        }

        let existing = self.gitflow_entries()?;
        let mut settings = vec![
            ("gitflow.branch.master", production),
            ("gitflow.branch.develop", develop),
            ("gitflow.prefix.feature", cfg.feature.as_str()),
            ("gitflow.prefix.release", cfg.release.as_str()),
            ("gitflow.prefix.hotfix", cfg.hotfix.as_str()),
            ("gitflow.prefix.versiontag", cfg.version_tag.as_str()),
        ];
        // git-flow only counts a repository as initialised once these are set
        // too, though gitp doesn't use them.
        for (key, default) in [
            ("gitflow.prefix.bugfix", "bugfix/"),
            ("gitflow.prefix.support", "support/"),
        ] {
            if !existing.contains_key(key) {
                settings.push((key, default));
            }
        }
        for (key, value) in settings {
            self.run_git(&["config", key, value])?;
        }
        done.push(format!(
            "Git Flow initialized: production {production}, develop {develop}."
        ));
        Ok(done.join("\n"))
    }

    /// The branch a start of `kind` called `name` creates, and the branch it
    /// starts from: develop for a feature or release, production for a hotfix.
    pub fn gitflow_start_target(&self, kind: FlowKind, name: &str) -> Result<(String, String)> {
        let cfg = self.require_gitflow()?;
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::Message(format!("Give the {} a name.", kind.word())));
        }
        let branch = format!("{}{name}", cfg.prefix(kind));
        ref_arg(&branch)?;
        let base = match kind {
            FlowKind::Hotfix => cfg.production,
            FlowKind::Feature | FlowKind::Release => cfg.develop,
        };
        Ok((branch, base))
    }

    /// Start a feature, release or hotfix: create its branch from where it
    /// starts (see `gitflow_start_target`) and check it out.
    pub fn gitflow_start(&self, kind: FlowKind, name: &str) -> Result<String> {
        let (branch, base) = self.gitflow_start_target(kind, name)?;
        self.refuse_switch_mid_operation(&branch)?;
        self.run_git(&["switch", "-c", ref_arg(&branch)?, ref_arg(&base)?])
    }

    /// Finish the Git Flow branch `branch`. A feature is merged (`--no-ff`)
    /// into develop. A release or hotfix is merged into production, tagged
    /// there with the version-tag prefix plus its name (annotated with
    /// `tag_message`), then merged into develop. Either way the branch is
    /// deleted at the end, leaving develop checked out.
    ///
    /// Refuses up front while there are uncommitted changes or another
    /// operation is paused. A step that fails stops the finish there: see the
    /// module docs for how it is resumed.
    pub fn gitflow_finish(&self, branch: &str, tag_message: Option<&str>) -> Result<String> {
        let cfg = self.require_gitflow()?;
        let (kind, name) = cfg
            .classify(branch)
            .ok_or_else(|| Error::Message(format!("{branch} isn't a Git Flow branch.")))?;
        let branch = ref_arg(branch)?;
        self.refuse_switch_mid_operation(&cfg.develop)?;
        let dirty = self.run_git(&["status", "--porcelain", "--untracked-files=no"])?;
        if !dirty.is_empty() {
            return Err(Error::Message(format!(
                "Can't finish {branch}: you have uncommitted changes. Commit or stash them \
                 first — nothing was changed."
            )));
        }

        let steps = match kind {
            FlowKind::Feature => vec![Step::Merge(cfg.develop.clone()), Step::Delete],
            FlowKind::Release | FlowKind::Hotfix => vec![
                Step::Merge(cfg.production.clone()),
                Step::Tag(format!("{}{name}", cfg.version_tag)),
                Step::Merge(cfg.develop.clone()),
                Step::Delete,
            ],
        };
        let default_message = match kind {
            FlowKind::Release => format!("Release {name}"),
            _ => format!("Hotfix {name}"),
        };
        let message = tag_message
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .unwrap_or(&default_message);

        let mut done = Vec::new();
        for (i, step) in steps.iter().enumerate() {
            let result = match step {
                Step::Merge(into) => self.flow_merge(branch, into),
                Step::Tag(tag) => self.flow_tag(tag, message),
                Step::Delete => self.run_git(&["branch", "-d", branch]),
            };
            if let Err(e) = result {
                return Err(self.flow_stopped(branch, &steps, i, e));
            }
            done.push(step.describe(branch));
        }
        Ok(format!(
            "Finished {} {name}: {}.",
            kind.word(),
            done.join(", ")
        ))
    }

    /// Switch to `into` and merge `branch` into it, always with a merge commit.
    fn flow_merge(&self, branch: &str, into: &str) -> Result<String> {
        self.run_git(&["switch", ref_arg(into)?])?;
        self.run_git(&["merge", "--no-ff", "--no-edit", branch])
    }

    /// Tag HEAD `tag`, annotated with `message`. A tag of that name already on
    /// HEAD is kept, so a finish run again after a conflict goes on past it.
    fn flow_tag(&self, tag: &str, message: &str) -> Result<String> {
        let tag = ref_arg(tag)?;
        if let Ok(existing) = self.inner.revparse_single(&format!("refs/tags/{tag}")) {
            let head = self.inner.head()?.peel_to_commit()?.id();
            if existing.peel_to_commit()?.id() == head {
                return Ok(String::new());
            }
            return Err(Error::Message(format!(
                "A tag {tag} already exists on another commit."
            )));
        }
        self.run_git(&["tag", "-a", "--cleanup=whitespace", "-m", message, tag])
    }

    /// The error for a finish that failed at step `at`: git's own message,
    /// then what it stopped doing and what is left.
    fn flow_stopped(&self, branch: &str, steps: &[Step], at: usize, err: Error) -> Error {
        let rest: Vec<String> = steps[at + 1..].iter().map(|s| s.describe(branch)).collect();
        let rest = if rest.is_empty() {
            String::new()
        } else {
            format!(" Still to do: {}.", rest.join(", "))
        };
        let conflicted = self.inner.path().join("MERGE_HEAD").exists();
        let what = steps[at].describe(branch);
        let advice = if conflicted {
            format!(
                "Git Flow stopped on conflicts while it tried to {what}. Resolve them and \
                 commit the merge, then Finish again to complete the rest.{rest}"
            )
        } else {
            format!("Git Flow stopped: couldn't {what}.{rest}")
        };
        Error::Message(format!("{err}\n\n{advice}").trim().to_string())
    }
}
