//! A branch's CI on GitHub: the Actions runs of the newest commit pushed to
//! it, summed up as one state for the status bar.

use serde::{Deserialize, Serialize};

use super::{parse_json, Gh, TIMEOUT};
use crate::error::Result;
use crate::repo::Repo;

/// The CI of a branch's newest pushed commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BranchCi {
    /// `success`, `failure`, `running`, or `none` (no run, or only cancelled ones).
    pub state: String,
    /// The commit the runs are for.
    pub sha: String,
    /// The run to open: the failed one, else a running one, else the newest.
    pub url: String,
    /// Its workflow's name and title, for the tooltip.
    pub workflow: String,
    pub title: String,
}

/// Runs read: enough to hold every workflow of the newest commit.
const RUNS: &str = "20";

impl Repo {
    /// The CI of `branch` (see [`BranchCi`]); `none` when it has no run.
    pub fn branch_ci(&self, gh: &Gh, branch: &str) -> Result<BranchCi> {
        let target = self.github_target()?;
        let repo = target.repo_arg();
        let args = [
            "run",
            "list",
            "--repo",
            &repo,
            "--branch",
            branch,
            "--limit",
            RUNS,
            "--json",
            "status,conclusion,workflowName,headSha,url,displayTitle",
        ];
        let out = self.gh_call(gh, &target, &args, None, TIMEOUT)?;
        let runs: Vec<RawRun> = parse_json(&out.stdout)?;
        Ok(sum_up(&runs))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRun {
    status: String,
    #[serde(default)]
    conclusion: String,
    #[serde(default)]
    workflow_name: String,
    head_sha: String,
    url: String,
    #[serde(default)]
    display_title: String,
}

/// One run's state.
fn state(run: &RawRun) -> &'static str {
    if run.status != "completed" {
        return "running";
    }
    match run.conclusion.as_str() {
        "success" | "skipped" | "neutral" => "success",
        "cancelled" | "" => "none",
        _ => "failure",
    }
}

/// The runs of the newest commit (gh lists the newest first), as one: a
/// failure in any, else one still running, else success.
fn sum_up(runs: &[RawRun]) -> BranchCi {
    let Some(newest) = runs.first() else {
        return BranchCi {
            state: "none".into(),
            sha: String::new(),
            url: String::new(),
            workflow: String::new(),
            title: String::new(),
        };
    };
    let of_commit: Vec<&RawRun> = runs
        .iter()
        .filter(|r| r.head_sha == newest.head_sha)
        .collect();
    let pick = |wanted: &str| of_commit.iter().find(|r| state(r) == wanted).copied();
    let (state, run) = if let Some(r) = pick("failure") {
        ("failure", r)
    } else if let Some(r) = pick("running") {
        ("running", r)
    } else if let Some(r) = pick("success") {
        ("success", r)
    } else {
        ("none", newest)
    };
    BranchCi {
        state: state.into(),
        sha: run.head_sha.clone(),
        url: run.url.clone(),
        workflow: run.workflow_name.clone(),
        title: run.display_title.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{github_repo, Fake};

    const RUNS: &str = r#"[
        {"status":"in_progress","conclusion":"","workflowName":"CI","headSha":"bbb","url":"u/3","displayTitle":"new"},
        {"status":"completed","conclusion":"failure","workflowName":"Lint","headSha":"bbb","url":"u/2","displayTitle":"new"},
        {"status":"completed","conclusion":"success","workflowName":"CI","headSha":"aaa","url":"u/1","displayTitle":"old"}
    ]"#;

    #[test]
    fn the_newest_commits_runs_sum_up_to_its_worst() {
        let fake = Fake::new();
        fake.answer("run list", RUNS, "", 0);
        let (_dir, repo) = github_repo();
        let ci = repo.branch_ci(&fake.gh(), "main").unwrap();
        assert_eq!(
            (
                ci.state.as_str(),
                ci.sha.as_str(),
                ci.url.as_str(),
                ci.workflow.as_str()
            ),
            ("failure", "bbb", "u/2", "Lint")
        );
        let call = &fake.calls()[0];
        assert_eq!(call[..4], ["run", "list", "--repo", "octo/hello"]);
        assert!(call.windows(2).any(|w| w == ["--branch", "main"]));
    }

    #[test]
    fn running_then_passed_then_none() {
        let fake = Fake::new();
        let (_dir, repo) = github_repo();
        fake.answer("run list", &RUNS.replace("failure", "success"), "", 0);
        assert_eq!(repo.branch_ci(&fake.gh(), "main").unwrap().state, "running");
        fake.answer(
            "run list",
            &RUNS
                .replace("failure", "success")
                .replace("in_progress", "completed")
                .replace(r#""conclusion":"","#, r#""conclusion":"success","#),
            "",
            0,
        );
        assert_eq!(repo.branch_ci(&fake.gh(), "main").unwrap().state, "success");
        fake.answer("run list", "[]", "", 0);
        assert_eq!(repo.branch_ci(&fake.gh(), "main").unwrap().state, "none");
    }
}
