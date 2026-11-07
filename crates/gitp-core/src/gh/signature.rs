//! A pull request's signature: the little GitHub says about it that changes
//! whenever anything on it does — its head, when it was last updated, its
//! threads and whether each is resolved, and its checks. The pull request
//! view polls it to know when to read the whole pull request again.

use serde::{Deserialize, Serialize};

use super::{parse_json, Gh, PullRequestDetail, RawCheck, RawNodes, TIMEOUT};
use crate::error::{Error, Result};
use crate::repo::Repo;

/// What a poll compares: a change in any part means the pull request moved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrSignature {
    /// The head commit.
    pub head: String,
    /// When GitHub last saw anything happen on it: a comment, a review, an
    /// edit, a push.
    pub updated_at: String,
    /// Its line-comment threads (the first hundred): node id and resolved.
    pub threads: Vec<(String, bool)>,
    /// The head's checks by name, with their state as the view shows it
    /// (`success`, `failure`, `pending`, `neutral` or `skipped`).
    pub checks: Vec<(String, String)>,
}

/// Head, update time, threads and the head commit's check rollup, in one
/// GraphQL call: `gh pr view --json` has no `reviewThreads`, so it would take
/// two.
const QUERY: &str = "query($owner: String!, $name: String!, $number: Int!) { \
    repository(owner: $owner, name: $name) { pullRequest(number: $number) { \
    headRefOid updatedAt reviewThreads(first: 100) { nodes { id isResolved } } \
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { \
    __typename ... on CheckRun { name status conclusion } \
    ... on StatusContext { context state } } } } } } } } } }";

impl PrSignature {
    /// The signature of `detail`, read at the same moment: what a poll
    /// right after would answer, built the same way.
    pub(crate) fn of(detail: &PullRequestDetail) -> Self {
        let mut checks: Vec<(String, String)> =
            detail.checks.iter().map(|c| (c.name.clone(), c.state.clone())).collect();
        checks.sort();
        PrSignature {
            head: detail.head_oid.clone(),
            updated_at: detail.updated_at.clone(),
            threads: detail.review_threads.iter().map(|t| (t.id.clone(), t.resolved)).collect(),
            checks,
        }
    }
}

impl Repo {
    /// Pull request `number`'s signature (see [`PrSignature`]), in one call.
    pub fn pull_request_signature(&self, gh: &Gh, number: u64) -> Result<PrSignature> {
        let target = self.github_target()?;
        let (owner, name) = target
            .path
            .split_once('/')
            .ok_or_else(|| Error::Message(format!("not owner/name: {}", target.path)))?;
        let mut args = Vec::new();
        target.api(&mut args);
        let owner_arg = format!("owner={owner}");
        let name_arg = format!("name={name}");
        let number_arg = format!("number={number}");
        let query_arg = format!("query={QUERY}");
        args.extend(["graphql", "-F", &owner_arg, "-F", &name_arg, "-F", &number_arg, "-f", &query_arg]);
        let out = self.gh_call(gh, &target, &args, None, TIMEOUT)?;
        let raw: RawAnswer = parse_json(&out.stdout)?;
        let pr = raw.data.repository.pull_request;
        let mut checks: Vec<(String, String)> = pr
            .commits
            .nodes
            .into_iter()
            .last()
            .and_then(|c| c.commit.status_check_rollup)
            .map(|r| r.contexts.nodes)
            .unwrap_or_default()
            .into_iter()
            .map(|c| {
                let check = c.into_check();
                (check.name, check.state)
            })
            .collect();
        checks.sort();
        Ok(PrSignature {
            head: pr.head_ref_oid,
            updated_at: pr.updated_at,
            threads: pr.review_threads.nodes.into_iter().map(|t| (t.id, t.is_resolved)).collect(),
            checks,
        })
    }
}

#[derive(Deserialize)]
struct RawAnswer {
    data: RawData,
}
#[derive(Deserialize)]
struct RawData {
    repository: RawRepo,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRepo {
    pull_request: RawPr,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPr {
    head_ref_oid: String,
    updated_at: String,
    review_threads: RawNodes<RawThread>,
    commits: RawNodes<RawCommitNode>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawThread {
    id: String,
    is_resolved: bool,
}
#[derive(Deserialize)]
struct RawCommitNode {
    commit: RawCommit,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCommit {
    status_check_rollup: Option<RawRollup>,
}
#[derive(Deserialize)]
struct RawRollup {
    contexts: RawNodes<RawCheck>,
}

#[cfg(test)]
mod tests {
    use super::super::tests::{github_repo, message, Fake};
    use super::super::RATE_LIMITED;

    const ANSWER: &str = r#"{"data":{"repository":{"pullRequest":{
        "headRefOid":"abc123","updatedAt":"2026-11-07T10:00:00Z",
        "reviewThreads":{"nodes":[{"id":"T1","isResolved":false},{"id":"T2","isResolved":true}]},
        "commits":{"nodes":[{"commit":{"statusCheckRollup":{"contexts":{"nodes":[
            {"__typename":"CheckRun","name":"test","status":"IN_PROGRESS","conclusion":null},
            {"__typename":"StatusContext","context":"ci/legacy","state":"SUCCESS"},
            {"__typename":"CheckRun","name":"build","status":"COMPLETED","conclusion":"FAILURE"}
        ]}}}}]}}}}}"#;

    #[test]
    fn the_detail_carries_the_signature_a_poll_would_answer() {
        // One GraphQL answer serves both the detail's threads query and the
        // poll's: the same pull request, read twice.
        let fake = Fake::new();
        fake.answer("api graphql", &ANSWER.replace(r#""isResolved":false}"#, r#""isResolved":false,"comments":{"nodes":[]}}"#)
            .replace(r#""isResolved":true}"#, r#""isResolved":true,"comments":{"nodes":[]}}"#), "", 0);
        fake.answer("api --paginate", "[]", "", 0);
        fake.answer(
            "pr view",
            r#"{"number":12,"title":"T","state":"OPEN","author":{"login":"o"},"baseRefName":"main",
                "headRefName":"t","headRefOid":"abc123","url":"u","reviewDecision":null,
                "updatedAt":"2026-11-07T10:00:00Z","statusCheckRollup":[
                {"__typename":"CheckRun","name":"test","status":"IN_PROGRESS","conclusion":null},
                {"__typename":"StatusContext","context":"ci/legacy","state":"SUCCESS"},
                {"__typename":"CheckRun","name":"build","status":"COMPLETED","conclusion":"FAILURE"}]}"#,
            "",
            0,
        );
        let (_dir, repo) = github_repo();
        let detail = repo.pull_request(&fake.gh(), 12).unwrap();
        let polled = repo.pull_request_signature(&fake.gh(), 12).unwrap();
        assert_eq!(detail.signature, Some(polled));
    }

    #[test]
    fn a_detail_without_its_threads_has_no_signature() {
        let fake = Fake::new();
        fake.answer("api graphql", "", "HTTP 502", 1);
        fake.answer("api --paginate", "[]", "", 0);
        fake.answer(
            "pr view",
            r#"{"number":12,"title":"T","state":"OPEN","author":{"login":"o"},"baseRefName":"main",
                "headRefName":"t","url":"u","reviewDecision":null}"#,
            "",
            0,
        );
        let (_dir, repo) = github_repo();
        assert_eq!(repo.pull_request(&fake.gh(), 12).unwrap().signature, None);
    }

    #[test]
    fn signature_is_one_graphql_call_and_reads_head_threads_and_checks() {
        let fake = Fake::new();
        fake.answer("api graphql", ANSWER, "", 0);
        let (_dir, repo) = github_repo();
        let sig = repo.pull_request_signature(&fake.gh(), 12).unwrap();

        let calls = fake.calls();
        assert_eq!(calls.len(), 1, "one call per poll");
        assert_eq!(calls[0][..2], ["api", "graphql"]);
        assert!(calls[0].iter().any(|a| a == "owner=octo"));
        assert!(calls[0].iter().any(|a| a == "name=hello"));
        assert!(calls[0].iter().any(|a| a == "number=12"));

        assert_eq!(sig.head, "abc123");
        assert_eq!(sig.updated_at, "2026-11-07T10:00:00Z");
        assert_eq!(sig.threads, vec![("T1".to_string(), false), ("T2".to_string(), true)]);
        // By name, so GitHub listing them in another order is no change.
        assert_eq!(
            sig.checks,
            vec![
                ("build".to_string(), "failure".to_string()),
                ("ci/legacy".to_string(), "success".to_string()),
                ("test".to_string(), "pending".to_string()),
            ]
        );
    }

    #[test]
    fn signature_without_checks_or_commits_has_none() {
        let fake = Fake::new();
        fake.answer(
            "api graphql",
            r#"{"data":{"repository":{"pullRequest":{"headRefOid":"abc","updatedAt":"t",
                "reviewThreads":{"nodes":[]},
                "commits":{"nodes":[{"commit":{"statusCheckRollup":null}}]}}}}}"#,
            "",
            0,
        );
        let (_dir, repo) = github_repo();
        let sig = repo.pull_request_signature(&fake.gh(), 3).unwrap();
        assert!(sig.checks.is_empty());
        assert!(sig.threads.is_empty());

        fake.answer(
            "api graphql",
            r#"{"data":{"repository":{"pullRequest":{"headRefOid":"abc","updatedAt":"t",
                "reviewThreads":{"nodes":[]},"commits":{"nodes":[]}}}}}"#,
            "",
            0,
        );
        assert!(repo.pull_request_signature(&fake.gh(), 3).unwrap().checks.is_empty());
    }

    #[test]
    fn signature_rate_limit_says_rate_limit() {
        let fake = Fake::new();
        fake.answer("api graphql", "", "GraphQL: API rate limit exceeded for user ID 1.\n", 1);
        let (_dir, repo) = github_repo();
        let err = repo.pull_request_signature(&fake.gh(), 3).unwrap_err();
        assert!(message(err).starts_with(RATE_LIMITED));
    }
}
