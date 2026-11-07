//! The review inbox: what needs the signed-in user across several
//! repositories. Per repository, the user's own open pull requests and those
//! waiting on their review (teams included, through GitHub's search), with
//! each one's unresolved threads and how many of those already have a reply
//! or a fix prepared in the local thread conversations. Read without loading
//! the repository in the main view: its remotes name the GitHub repository,
//! and its git directory holds the conversations.

use super::*;
use crate::pr_threads::prepared_reply;

/// A pull request as the inbox lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InboxPr {
    /// `owner/name` (with the host in front for GitHub Enterprise).
    pub repo: String,
    /// The local repository it was read through, as the caller named it:
    /// what a click opens.
    pub path: String,
    pub number: u64,
    pub title: String,
    pub author: String,
    pub url: String,
    pub updated_at: String,
    /// `success`, `failure` or `pending`; none without checks.
    pub checks: Option<String>,
    pub review_decision: Option<String>,
    /// GitHub's `mergeStateStatus`: `CLEAN` when it can be merged now.
    pub merge_state: String,
    /// Opened by the signed-in user.
    pub mine: bool,
    /// Waiting on the signed-in user's review, or one of their teams'.
    pub review_requested: bool,
    /// Line-comment threads not resolved; none when GitHub didn't say.
    pub unresolved: Option<u32>,
    /// Of those, how many have a reply ready or a fix commit in their
    /// conversation.
    pub prepared: u32,
}

/// What one repository answered: its pull requests, or why it couldn't.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InboxRepo {
    pub path: String,
    pub repo: Option<String>,
    pub prs: Vec<InboxPr>,
    pub error: Option<String>,
}

/// The fields the inbox asks `gh pr list` for.
const INBOX_FIELDS: &str =
    "number,title,author,isDraft,reviewDecision,statusCheckRollup,updatedAt,mergeStateStatus,url";

impl Repo {
    /// The open pull requests that are the signed-in user's or wait on their
    /// review, drafts left out: two `gh pr list` (the review requests through
    /// GitHub's search, so team requests count) and one GraphQL query for the
    /// threads of those listed. A failed thread query leaves the counts
    /// unknown rather than failing the lot.
    pub fn inbox_pull_requests(&self, gh: &Gh) -> Result<Vec<InboxPr>> {
        let target = self.github_target()?;
        let repo = target.repo_arg();
        let list = |filter: [&str; 2]| -> Result<Vec<RawInboxPr>> {
            let args = [
                "pr", "list", "--repo", &repo, "--state", "open", "--limit", "100", "--json",
                INBOX_FIELDS, filter[0], filter[1],
            ];
            parse_json(&self.gh_call(gh, &target, &args, None, TIMEOUT)?.stdout)
        };
        let mine = list(["--author", "@me"])?;
        let requested = list(["--search", "review-requested:@me"])?;
        let path = self.workdir().to_string_lossy().into_owned();
        let mut prs: Vec<InboxPr> = Vec::new();
        for (raw, is_mine) in mine.into_iter().map(|r| (r, true)).chain(requested.into_iter().map(|r| (r, false))) {
            if raw.is_draft {
                continue;
            }
            if let Some(pr) = prs.iter_mut().find(|p| p.number == raw.number) {
                pr.mine |= is_mine;
                pr.review_requested |= !is_mine;
                continue;
            }
            prs.push(InboxPr {
                repo: repo.clone(),
                path: path.clone(),
                number: raw.number,
                title: raw.title,
                author: login(raw.author),
                url: raw.url,
                updated_at: raw.updated_at,
                checks: rollup(&raw.status_check_rollup),
                review_decision: non_empty(raw.review_decision),
                merge_state: raw.merge_state_status,
                mine: is_mine,
                review_requested: !is_mine,
                unresolved: None,
                prepared: 0,
            });
        }
        if prs.is_empty() {
            return Ok(prs);
        }
        let numbers: Vec<u64> = prs.iter().map(|p| p.number).collect();
        if let Ok(open) = self.open_thread_roots(gh, &target, &numbers) {
            for pr in &mut prs {
                let Some(roots) = open.get(&pr.number) else { continue };
                pr.unresolved = Some(roots.len() as u32);
                pr.prepared = roots.iter().filter(|&&root| self.thread_prepared(pr.number, root)).count() as u32;
            }
        }
        Ok(prs)
    }

    /// The root comment of each unresolved thread of pull requests `numbers`,
    /// by number, in one GraphQL query (an alias per pull request).
    fn open_thread_roots(&self, gh: &Gh, target: &GitHubRepo, numbers: &[u64]) -> Result<HashMap<u64, Vec<u64>>> {
        let (owner, name) = target
            .path
            .split_once('/')
            .ok_or_else(|| Error::Message(format!("not owner/name: {}", target.path)))?;
        let fields: String = numbers
            .iter()
            .map(|n| {
                format!(
                    "p{n}: pullRequest(number: {n}) {{ number reviewThreads(first: 100) {{ nodes {{ isResolved \
                     comments(first: 1) {{ nodes {{ databaseId }} }} }} }} }} "
                )
            })
            .collect();
        let query = format!(
            "query($owner: String!, $name: String!) {{ repository(owner: $owner, name: $name) {{ {fields}}} }}"
        );
        let mut args = Vec::new();
        target.api(&mut args);
        let owner_arg = format!("owner={owner}");
        let name_arg = format!("name={name}");
        let query_arg = format!("query={query}");
        args.extend(["graphql", "-F", &owner_arg, "-F", &name_arg, "-f", &query_arg]);
        let out = self.gh_call(gh, target, &args, None, TIMEOUT)?;
        let raw: RawInboxAnswer = parse_json(&out.stdout)?;
        Ok(raw
            .data
            .repository
            .into_values()
            .flatten()
            .map(|pr| {
                let roots = pr
                    .review_threads
                    .nodes
                    .into_iter()
                    .filter(|t| !t.is_resolved)
                    .map(|t| t.comments.nodes.first().and_then(|c| c.database_id).unwrap_or(0))
                    .collect();
                (pr.number, roots)
            })
            .collect())
    }

    /// Whether the conversation of thread `root` on `number` has a reply
    /// ready or a fix commit.
    fn thread_prepared(&self, number: u64, root: u64) -> bool {
        let Ok(Some(c)) = self.thread_conversation(number, root) else {
            return false;
        };
        prepared_reply(&c).is_some()
            || c.turns.iter().any(|t| t.kind == TurnKind::Fix && t.commit.is_some())
    }
}

/// The repositories to ask, once each: `paths` in order, opened only to read
/// their remotes, merged by GitHub repository — the first path of each wins.
/// The paths that can't be asked come back as error rows.
pub fn inbox_sources(paths: &[String]) -> (Vec<(String, String)>, Vec<InboxRepo>) {
    let mut sources: Vec<(String, String)> = Vec::new();
    let mut errors = Vec::new();
    for path in paths {
        let failed = |error: String| InboxRepo { path: path.clone(), repo: None, prs: Vec::new(), error: Some(error) };
        match Repo::open(path) {
            Err(e) => errors.push(failed(format!("not a git repository: {e}"))),
            Ok(repo) => match repo.github_repo() {
                None => errors.push(failed(inbox_reason(Error::Message(NO_GITHUB_REMOTE.into())))),
                Some(name) => {
                    if !sources.iter().any(|(_, n)| *n == name) {
                        sources.push((path.clone(), name));
                    }
                }
            },
        }
    }
    (sources, errors)
}

/// One repository's inbox rows, or why there are none.
pub fn inbox_repo(gh: &Gh, path: &str) -> InboxRepo {
    let mut answer = InboxRepo { path: path.to_string(), repo: None, prs: Vec::new(), error: None };
    let repo = match Repo::open(path) {
        Ok(repo) => repo,
        Err(e) => {
            answer.error = Some(format!("not a git repository: {e}"));
            return answer;
        }
    };
    answer.repo = repo.github_repo();
    match repo.inbox_pull_requests(gh) {
        Ok(prs) => {
            answer.prs = prs.into_iter().map(|pr| InboxPr { path: path.to_string(), ..pr }).collect()
        }
        Err(e) => answer.error = Some(inbox_reason(e)),
    }
    answer
}

/// The short reason a row of unreadable repositories shows.
fn inbox_reason(e: Error) -> String {
    let text = e.to_string();
    match text.as_str() {
        NOT_SIGNED_IN => "not signed in".into(),
        NO_GITHUB_REMOTE => "no GitHub remote".into(),
        NOT_INSTALLED => "gh is not installed".into(),
        _ => text,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawInboxPr {
    number: u64,
    title: String,
    author: Option<RawUser>,
    #[serde(default)]
    is_draft: bool,
    review_decision: Option<String>,
    #[serde(default)]
    status_check_rollup: Vec<RawCheck>,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    merge_state_status: String,
    url: String,
}

#[derive(Deserialize)]
struct RawInboxAnswer {
    data: RawInboxData,
}
#[derive(Deserialize)]
struct RawInboxData {
    /// Alias (`p<number>`) to the pull request; null when there is none.
    repository: HashMap<String, Option<RawInboxThreads>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawInboxThreads {
    number: u64,
    review_threads: RawNodes<RawInboxThread>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawInboxThread {
    is_resolved: bool,
    comments: RawNodes<RawThreadComment>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pr_threads::{ThreadConversation, ThreadTurn, TurnKind};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    /// A fake `gh` that logs its arguments and answers the author list, the
    /// review-requested search and the GraphQL query from files of their own:
    /// `out.mine`, `out.review`, `out.graphql` (`code.*` for the exit status).
    const FAKE_GH: &str = r#"#!/bin/sh
d="$(dirname "$0")"
(IFS="$(printf '\t')"; printf '%s\n' "$*") >> "$d/argv"
case "$*" in
  *review-requested:@me*) k=review ;;
  *graphql*) k=graphql ;;
  *) k=mine ;;
esac
cat "$d/out.$k" 2>/dev/null
cat "$d/err.$k" >&2 2>/dev/null
exit "$(cat "$d/code.$k" 2>/dev/null || echo 0)"
"#;

    struct Fake(tempfile::TempDir);

    impl Fake {
        fn new() -> Self {
            let bin = tempfile::tempdir().unwrap();
            let gh = bin.path().join("gh");
            fs::write(&gh, FAKE_GH).unwrap();
            fs::set_permissions(&gh, fs::Permissions::from_mode(0o755)).unwrap();
            Self(bin)
        }
        fn answer(&self, key: &str, stdout: &str, stderr: &str, code: i32) -> &Self {
            let d = self.0.path();
            fs::write(d.join(format!("out.{key}")), stdout).unwrap();
            fs::write(d.join(format!("err.{key}")), stderr).unwrap();
            fs::write(d.join(format!("code.{key}")), code.to_string()).unwrap();
            self
        }
        fn gh(&self) -> Gh {
            let real = std::env::var_os("PATH").unwrap_or_default();
            let dirs = std::iter::once(self.0.path().to_path_buf()).chain(std::env::split_paths(&real));
            Gh::with_search_path(std::env::join_paths(dirs).unwrap())
        }
        fn calls(&self) -> Vec<Vec<String>> {
            fs::read_to_string(self.0.path().join("argv"))
                .unwrap_or_default()
                .lines()
                .map(|l| l.split('\t').map(str::to_string).collect())
                .collect()
        }
    }

    fn repo_at(dir: &Path, remote: Option<&str>) -> Repo {
        let git = git2::Repository::init(dir).unwrap();
        let sig = git2::Signature::now("T", "t@example.com").unwrap();
        let tree = git.treebuilder(None).unwrap().write().unwrap();
        let tree = git.find_tree(tree).unwrap();
        git.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        if let Some(url) = remote {
            git.remote("origin", url).unwrap();
        }
        Repo::open(dir).unwrap()
    }

    fn github_repo() -> (tempfile::TempDir, Repo) {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo_at(dir.path(), Some("git@github.com:octo/hello.git"));
        (dir, repo)
    }

    const MINE: &str = r#"[
      {"number": 12, "title": "Add widgets", "author": {"login": "me"}, "isDraft": false,
       "reviewDecision": "APPROVED", "mergeStateStatus": "CLEAN",
       "updatedAt": "2026-11-06T10:00:00Z", "url": "https://github.com/octo/hello/pull/12",
       "statusCheckRollup": [{"__typename": "CheckRun", "name": "build", "status": "COMPLETED", "conclusion": "FAILURE"}]},
      {"number": 9, "title": "WIP", "author": {"login": "me"}, "isDraft": true, "reviewDecision": "",
       "mergeStateStatus": "DRAFT", "updatedAt": "2026-11-06T09:00:00Z", "url": "u9", "statusCheckRollup": []}
    ]"#;
    const REVIEW: &str = r#"[
      {"number": 30, "title": "Fix login", "author": {"login": "anna"}, "isDraft": false,
       "reviewDecision": "REVIEW_REQUIRED", "mergeStateStatus": "BLOCKED",
       "updatedAt": "2026-11-07T08:00:00Z", "url": "u30", "statusCheckRollup": []}
    ]"#;

    fn threads(nodes12: &str) -> String {
        format!(
            r#"{{"data": {{"repository": {{
              "p12": {{"number": 12, "reviewThreads": {{"nodes": {nodes12}}}}},
              "p30": {{"number": 30, "reviewThreads": {{"nodes": []}}}}
            }}}}}}"#
        )
    }

    fn thread(resolved: bool, root: u64) -> String {
        format!(r#"{{"isResolved": {resolved}, "comments": {{"nodes": [{{"databaseId": {root}}}]}}}}"#)
    }

    #[test]
    fn inbox_lists_mine_and_review_requested_without_drafts() {
        let fake = Fake::new();
        fake.answer("mine", MINE, "", 0)
            .answer("review", REVIEW, "", 0)
            .answer("graphql", &threads(&format!("[{}, {}]", thread(false, 1), thread(true, 2))), "", 0);
        let (_dir, repo) = github_repo();
        let prs = repo.inbox_pull_requests(&fake.gh()).unwrap();

        let calls = fake.calls();
        assert_eq!(calls.len(), 3);
        let mine = calls.iter().find(|c| c.contains(&"--author".to_string())).unwrap();
        assert_eq!(mine[..6], ["pr", "list", "--repo", "octo/hello", "--state", "open"]);
        let fields = &mine[mine.iter().position(|a| a == "--json").unwrap() + 1];
        assert!(fields.split(',').any(|f| f == "mergeStateStatus"), "{fields}");
        assert!(mine.ends_with(&["--author".to_string(), "@me".to_string()]));
        let review = calls.iter().find(|c| c.contains(&"review-requested:@me".to_string())).unwrap();
        assert!(review.ends_with(&["--search".to_string(), "review-requested:@me".to_string()]));
        let graphql = calls.iter().find(|c| c.contains(&"graphql".to_string())).unwrap();
        let query = graphql.iter().find(|a| a.starts_with("query=")).unwrap();
        assert!(query.contains("p12: pullRequest(number: 12)") && query.contains("p30: pullRequest(number: 30)"), "{query}");

        let numbers: Vec<u64> = prs.iter().map(|p| p.number).collect();
        assert_eq!(numbers, [12, 30], "the draft is left out");
        let p12 = &prs[0];
        assert_eq!(p12.repo, "octo/hello");
        assert_eq!((p12.mine, p12.review_requested), (true, false));
        assert_eq!(p12.checks.as_deref(), Some("failure"));
        assert_eq!(p12.review_decision.as_deref(), Some("APPROVED"));
        assert_eq!(p12.merge_state, "CLEAN");
        assert_eq!((p12.unresolved, p12.prepared), (Some(1), 0));
        assert_eq!(p12.updated_at, "2026-11-06T10:00:00Z");
        let p30 = &prs[1];
        assert_eq!((p30.mine, p30.review_requested, p30.author.as_str()), (false, true, "anna"));
        assert_eq!((p30.checks.clone(), p30.unresolved), (None, Some(0)));
    }

    fn conversation(thread: u64, turns: Vec<ThreadTurn>) -> ThreadConversation {
        ThreadConversation { version: 1, pr: 12, thread, path: "a.rs".into(), session: None, fix_session: None, turns }
    }

    #[test]
    fn prepared_counts_unresolved_threads_with_a_ready_reply_or_a_fix_commit() {
        let fake = Fake::new();
        let nodes = format!("[{}, {}, {}, {}, {}]", thread(false, 100), thread(false, 101), thread(true, 102), thread(false, 103), thread(false, 104));
        fake.answer("mine", MINE, "", 0).answer("review", "[]", "", 0).answer("graphql", &threads(&nodes), "", 0);
        let (_dir, repo) = github_repo();
        let reply = || ThreadTurn::claude(TurnKind::ReplyDraft, "h".into(), "Done.".into());
        let mut fix = ThreadTurn::claude(TurnKind::Fix, "h".into(), "Fixed.".into());
        fix.commit = Some("abc".into());
        let mut posted = reply();
        posted.posted = Some("https://x".into());
        repo.save_thread_conversation(&conversation(100, vec![reply()])).unwrap();
        repo.save_thread_conversation(&conversation(101, vec![fix])).unwrap();
        repo.save_thread_conversation(&conversation(102, vec![reply()])).unwrap(); // resolved
        repo.save_thread_conversation(&conversation(103, vec![posted])).unwrap();
        repo.save_thread_conversation(&conversation(104, vec![ThreadTurn::claude(TurnKind::Explain, "h".into(), "?".into())])).unwrap();

        let prs = repo.inbox_pull_requests(&fake.gh()).unwrap();
        assert_eq!((prs[0].unresolved, prs[0].prepared), (Some(4), 2));
    }

    #[test]
    fn a_failed_thread_query_leaves_the_counts_unknown() {
        let fake = Fake::new();
        fake.answer("mine", MINE, "", 0).answer("review", REVIEW, "", 0).answer("graphql", "", "HTTP 502", 1);
        let (_dir, repo) = github_repo();
        let prs = repo.inbox_pull_requests(&fake.gh()).unwrap();
        assert_eq!(prs.len(), 2);
        assert!(prs.iter().all(|p| p.unresolved.is_none() && p.prepared == 0));
    }

    #[test]
    fn nothing_listed_asks_no_thread_query() {
        let fake = Fake::new();
        fake.answer("mine", "[]", "", 0).answer("review", "[]", "", 0);
        let (_dir, repo) = github_repo();
        assert!(repo.inbox_pull_requests(&fake.gh()).unwrap().is_empty());
        assert_eq!(fake.calls().len(), 2);
    }

    #[test]
    fn sources_merge_paths_by_github_repo_first_path_wins() {
        let root = tempfile::tempdir().unwrap();
        let (a, b, lab) = (root.path().join("a"), root.path().join("b"), root.path().join("lab"));
        for d in [&a, &b, &lab] {
            fs::create_dir(d).unwrap();
        }
        repo_at(&a, Some("git@github.com:octo/hello.git"));
        repo_at(&b, Some("https://github.com/octo/hello"));
        repo_at(&lab, Some("git@gitlab.com:me/x.git"));
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let gone = s(&root.path().join("gone"));
        let (sources, errors) = inbox_sources(&[s(&b), s(&a), s(&lab), gone.clone()]);
        assert_eq!(sources, [(s(&b), "octo/hello".to_string())]);
        assert_eq!(errors.len(), 2);
        assert_eq!((errors[0].path.clone(), errors[0].error.as_deref()), (s(&lab), Some("no GitHub remote")));
        assert_eq!(errors[1].path, gone);
        assert!(errors[1].error.as_deref().unwrap().starts_with("not a git repository"), "{:?}", errors[1].error);
    }

    #[test]
    fn a_signed_out_gh_is_named_as_such() {
        let fake = Fake::new();
        fake.answer("mine", "", "To get started with GitHub CLI, please run:  gh auth login", 4);
        let (dir, _repo) = github_repo();
        let path = dir.path().to_string_lossy().into_owned();
        let r = inbox_repo(&fake.gh(), &path);
        assert_eq!(r.repo.as_deref(), Some("octo/hello"));
        assert_eq!(r.error.as_deref(), Some("not signed in"));
        assert!(r.prs.is_empty());
    }

    #[test]
    fn a_repo_answers_with_its_rows() {
        let fake = Fake::new();
        fake.answer("mine", MINE, "", 0).answer("review", "[]", "", 0).answer("graphql", &threads("[]"), "", 0);
        let (dir, _repo) = github_repo();
        let path = dir.path().to_string_lossy().into_owned();
        let r = inbox_repo(&fake.gh(), &path);
        assert_eq!((r.error, r.prs.len()), (None, 1));
        assert_eq!(r.prs[0].path, path, "the path as given, which a click opens");
    }
}
