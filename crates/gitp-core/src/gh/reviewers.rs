//! A pull request's reviewers: who is asked for a review (people and
//! teams), asking more or asking again, taking a request back, and the
//! people a review can be asked of.

use serde::{Deserialize, Serialize};

use super::{parse_json, Gh, TIMEOUT};
use crate::error::{Error, Result};
use crate::repo::Repo;

/// One reviewer asked for a review and not answered yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrReviewer {
    /// What `gh pr edit --add-reviewer` takes: a login, or `org/team`.
    pub id: String,
    pub team: bool,
}

/// A request as `gh pr view --json reviewRequests` gives it: a user's login,
/// or a team's name and slug.
#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct RawRequest {
    #[serde(rename = "__typename")]
    typename: String,
    login: String,
    name: String,
    slug: String,
}

/// The requests as reviewers; a team's slug gets the repository's `owner`
/// in front when GitHub gave it bare.
pub(super) fn requested_reviewers(raw: Vec<RawRequest>, owner: &str) -> Vec<PrReviewer> {
    raw.into_iter()
        .filter_map(|r| {
            if r.typename == "Team"
                || (r.login.is_empty() && !(r.slug.is_empty() && r.name.is_empty()))
            {
                let slug = if r.slug.is_empty() { r.name } else { r.slug };
                let id = if slug.contains('/') {
                    slug
                } else {
                    format!("{owner}/{slug}")
                };
                Some(PrReviewer { id, team: true })
            } else if !r.login.is_empty() {
                Some(PrReviewer {
                    id: r.login,
                    team: false,
                })
            } else {
                None
            }
        })
        .collect()
}

const ASSIGNABLE_QUERY: &str = "query($owner: String!, $name: String!) { \
    repository(owner: $owner, name: $name) { assignableUsers(first: 100) { nodes { login } } } }";

impl Repo {
    /// Ask `add` for a review of pull request `number` (again, for one who
    /// reviewed already) and take the requests of `remove` back. Each is a
    /// login or `org/team`.
    pub fn set_pull_request_reviewers(
        &self,
        gh: &Gh,
        number: u64,
        add: &[String],
        remove: &[String],
    ) -> Result<()> {
        let clean = |list: &[String]| -> Vec<String> {
            list.iter()
                .map(|r| r.trim().trim_start_matches('@').to_string())
                .filter(|r| !r.is_empty())
                .collect()
        };
        let (add, remove) = (clean(add), clean(remove));
        if add.is_empty() && remove.is_empty() {
            return Err(Error::Message("Name a reviewer first.".into()));
        }
        if let Some(bad) = add
            .iter()
            .chain(&remove)
            .find(|r| r.contains(',') || r.chars().any(char::is_whitespace))
        {
            return Err(Error::Message(format!("Not a login or org/team: {bad}")));
        }
        let target = self.github_target()?;
        let repo = target.repo_arg();
        let n = number.to_string();
        let (add_arg, remove_arg) = (add.join(","), remove.join(","));
        let mut args = vec!["pr", "edit", &n, "--repo", &repo];
        if !add.is_empty() {
            args.extend(["--add-reviewer", &add_arg]);
        }
        if !remove.is_empty() {
            args.extend(["--remove-reviewer", &remove_arg]);
        }
        self.gh_call(gh, &target, &args, None, TIMEOUT)?;
        Ok(())
    }

    /// The people a review can be asked of in this repository (its
    /// assignable users, the first hundred), by login.
    pub fn assignable_users(&self, gh: &Gh) -> Result<Vec<String>> {
        let target = self.github_target()?;
        let (owner, name) = target
            .path
            .split_once('/')
            .ok_or_else(|| Error::Message(format!("not owner/name: {}", target.path)))?;
        let owner_arg = format!("owner={owner}");
        let name_arg = format!("name={name}");
        let query_arg = format!("query={ASSIGNABLE_QUERY}");
        let mut args = Vec::new();
        target.api(&mut args);
        args.extend([
            "graphql", "-F", &owner_arg, "-F", &name_arg, "-f", &query_arg,
        ]);
        let out = self.gh_call(gh, &target, &args, None, TIMEOUT)?;
        let raw: RawAnswer = parse_json(&out.stdout)?;
        let mut logins: Vec<String> = raw
            .data
            .repository
            .assignable_users
            .nodes
            .into_iter()
            .map(|u| u.login)
            .collect();
        logins.sort_by_key(|l| l.to_lowercase());
        Ok(logins)
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
    assignable_users: RawUsers,
}
#[derive(Deserialize)]
struct RawUsers {
    nodes: Vec<RawLogin>,
}
#[derive(Deserialize)]
struct RawLogin {
    login: String,
}

#[cfg(test)]
mod tests {
    use super::super::tests::{github_repo, message, Fake};
    use super::*;

    #[test]
    fn requests_are_people_and_teams_by_what_gh_takes() {
        let raw: Vec<RawRequest> = serde_json::from_str(
            r#"[{"__typename":"User","login":"dung"},
                {"__typename":"Team","name":"team-phoenix","slug":"team-phoenix"},
                {"__typename":"Team","name":"Core","slug":"acme/core"},
                {"__typename":"Mannequin"}]"#,
        )
        .unwrap();
        let ids: Vec<_> = requested_reviewers(raw, "octo")
            .into_iter()
            .map(|r| (r.id, r.team))
            .collect();
        assert_eq!(
            ids,
            [
                ("dung".into(), false),
                ("octo/team-phoenix".into(), true),
                ("acme/core".into(), true)
            ]
        );
    }

    #[test]
    fn adds_and_removes_in_one_edit() {
        let fake = Fake::new();
        fake.answer("pr edit", "", "", 0);
        let (_dir, repo) = github_repo();
        repo.set_pull_request_reviewers(
            &fake.gh(),
            7,
            &["@dung".into(), "octo/phoenix".into()],
            &["tu".into()],
        )
        .unwrap();
        assert_eq!(
            fake.calls()[0],
            [
                "pr",
                "edit",
                "7",
                "--repo",
                "octo/hello",
                "--add-reviewer",
                "dung,octo/phoenix",
                "--remove-reviewer",
                "tu"
            ]
        );
    }

    #[test]
    fn refuses_nobody_and_a_list_in_one_name() {
        let fake = Fake::new();
        let (_dir, repo) = github_repo();
        let none = repo
            .set_pull_request_reviewers(&fake.gh(), 7, &[" ".into()], &[])
            .unwrap_err();
        assert!(message(none).contains("Name a reviewer"));
        let list = repo
            .set_pull_request_reviewers(&fake.gh(), 7, &["a,b".into()], &[])
            .unwrap_err();
        assert!(message(list).contains("Not a login"));
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn lists_the_assignable_users_sorted() {
        let fake = Fake::new();
        fake.answer(
            "api graphql",
            r#"{"data":{"repository":{"assignableUsers":{"nodes":[{"login":"zed"},{"login":"Anna"},{"login":"bob"}]}}}}"#,
            "",
            0,
        );
        let (_dir, repo) = github_repo();
        assert_eq!(
            repo.assignable_users(&fake.gh()).unwrap(),
            ["Anna", "bob", "zed"]
        );
    }
}
