//! The files of a pull request the signed-in user marked "Viewed" on GitHub,
//! and marking one or taking the mark off: the same marks as the checkbox on
//! github.com, so the two agree.

use serde::{Deserialize, Serialize};

use super::{parse_json, Gh, TIMEOUT};
use crate::error::{Error, Result};
use crate::repo::Repo;

/// A pull request's Viewed marks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrViewed {
    /// The pull request's node id, which a mark names.
    pub id: String,
    /// The paths marked Viewed. A file changed since its mark (GitHub's
    /// `DISMISSED`) is not, as on github.com.
    pub viewed: Vec<String>,
}

/// Pages of a hundred files read at most: three thousand files.
const MAX_PAGES: usize = 30;

const QUERY: &str = "query($owner: String!, $name: String!, $number: Int!, $after: String) { \
    repository(owner: $owner, name: $name) { pullRequest(number: $number) { id \
    files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } \
    nodes { path viewerViewedState } } } } }";

impl Repo {
    /// Which files of pull request `number` are marked Viewed (see [`PrViewed`]).
    pub fn pull_request_viewed(&self, gh: &Gh, number: u64) -> Result<PrViewed> {
        let target = self.github_target()?;
        let (owner, name) = target
            .path
            .split_once('/')
            .ok_or_else(|| Error::Message(format!("not owner/name: {}", target.path)))?;
        let owner_arg = format!("owner={owner}");
        let name_arg = format!("name={name}");
        let number_arg = format!("number={number}");
        let query_arg = format!("query={QUERY}");
        let mut id = String::new();
        let mut viewed = Vec::new();
        let mut after: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let mut args = Vec::new();
            target.api(&mut args);
            args.extend(["graphql", "-F", &owner_arg, "-F", &name_arg, "-F", &number_arg, "-f", &query_arg]);
            let after_arg = after.as_ref().map(|a| format!("after={a}"));
            if let Some(a) = &after_arg {
                args.extend(["-f", a]);
            }
            let out = self.gh_call(gh, &target, &args, None, TIMEOUT)?;
            let raw: RawAnswer = parse_json(&out.stdout)?;
            let pr = raw.data.repository.pull_request;
            id = pr.id;
            viewed.extend(pr.files.nodes.into_iter().filter(|f| f.viewer_viewed_state == "VIEWED").map(|f| f.path));
            if !pr.files.page_info.has_next_page {
                break;
            }
            after = pr.files.page_info.end_cursor;
        }
        Ok(PrViewed { id, viewed })
    }

    /// Mark `path` of the pull request with node id `pr_id` Viewed, or take
    /// the mark off with `viewed` false.
    pub fn set_pull_request_file_viewed(&self, gh: &Gh, pr_id: &str, path: &str, viewed: bool) -> Result<()> {
        let target = self.github_target()?;
        let mutation = if viewed { "markFileAsViewed" } else { "unmarkFileAsViewed" };
        let query = format!(
            "query=mutation($id: ID!, $path: String!) {{ {mutation}(input: {{pullRequestId: $id, path: $path}}) {{ clientMutationId }} }}"
        );
        let id = format!("id={pr_id}");
        let path_arg = format!("path={path}");
        let mut args = Vec::new();
        target.api(&mut args);
        args.extend(["graphql", "-f", &id, "-f", &path_arg, "-f", &query]);
        self.gh_call(gh, &target, &args, None, TIMEOUT)?;
        Ok(())
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
struct RawPr {
    id: String,
    files: RawFiles,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFiles {
    page_info: RawPageInfo,
    nodes: Vec<RawFile>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFile {
    path: String,
    viewer_viewed_state: String,
}

#[cfg(test)]
mod tests {
    use super::super::tests::{github_repo, Fake};

    #[test]
    fn reads_the_viewed_files_across_pages() {
        // Two pages: this script answers its n-th call with page.n.
        let fake = Fake::with_script(
            r#"#!/bin/sh
d="$(dirname "$0")"
(IFS="$(printf '\t')"; printf '%s\n' "$*") >> "$d/argv"
n=$(wc -l < "$d/argv" | tr -d ' ')
cat "$d/page.$n"
"#,
        );
        fake.write(
            "page.1",
            r#"{"data":{"repository":{"pullRequest":{"id":"PR_1","files":{
                "pageInfo":{"hasNextPage":true,"endCursor":"C1"},
                "nodes":[{"path":"a.ts","viewerViewedState":"VIEWED"},{"path":"b.ts","viewerViewedState":"UNVIEWED"}]}}}}}"#,
        );
        fake.write(
            "page.2",
            r#"{"data":{"repository":{"pullRequest":{"id":"PR_1","files":{
                "pageInfo":{"hasNextPage":false,"endCursor":null},
                "nodes":[{"path":"c.ts","viewerViewedState":"DISMISSED"},{"path":"d.ts","viewerViewedState":"VIEWED"}]}}}}}"#,
        );
        let (_dir, repo) = github_repo();
        let v = repo.pull_request_viewed(&fake.gh(), 7).unwrap();
        assert_eq!(v.id, "PR_1");
        assert_eq!(v.viewed, ["a.ts", "d.ts"]);
        let calls = fake.calls();
        assert_eq!(calls.len(), 2);
        assert!(!calls[0].iter().any(|a| a.starts_with("after=")));
        assert!(calls[1].contains(&"after=C1".to_string()));
    }

    #[test]
    fn marks_and_unmarks_a_file() {
        let fake = Fake::new();
        fake.answer("api graphql", "{}", "", 0);
        let (_dir, repo) = github_repo();
        repo.set_pull_request_file_viewed(&fake.gh(), "PR_1", "src/a.ts", true).unwrap();
        repo.set_pull_request_file_viewed(&fake.gh(), "PR_1", "src/a.ts", false).unwrap();
        let calls = fake.calls();
        assert!(calls[0].contains(&"id=PR_1".to_string()) && calls[0].contains(&"path=src/a.ts".to_string()));
        assert!(calls[0].iter().any(|a| a.contains("markFileAsViewed(input:") && !a.contains("unmark")));
        assert!(calls[1].iter().any(|a| a.contains("unmarkFileAsViewed(input:")));
    }
}
