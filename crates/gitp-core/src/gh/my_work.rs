//! "What did I do": the user's own work since a day, as the input of a Claude
//! summary for a stand-up — their commits in each repository given, on any
//! branch, and the pull requests they opened, updated or reviewed on GitHub.

use std::path::PathBuf;

use serde::Deserialize;

use super::{parse_json, Gh, TIMEOUT};
use crate::error::{Error, Result};

/// Commits listed per repository at most.
const MAX_COMMITS: &str = "-300";

/// The work since `since` (YYYY-MM-DD) in `repos`, as text for Claude. A
/// repository with no `user.email`, or that isn't one, is left out; GitHub
/// not answering is said in the text rather than failing it.
pub fn my_work_input(gh: &Gh, repos: &[PathBuf], since: &str) -> Result<String> {
    let valid = since.len() == 10
        && since.chars().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                c == '-'
            } else {
                c.is_ascii_digit()
            }
        });
    if !valid {
        return Err(Error::Message(format!("not a day (YYYY-MM-DD): {since}")));
    }
    let mut out = format!("My work since {since}.\n\n## Commits\n");
    let mut any = false;
    for dir in repos {
        let Some(lines) = commits(dir, since) else {
            continue;
        };
        if lines.is_empty() {
            continue;
        }
        any = true;
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        out.push_str(&format!("\n### {name} ({})\n", dir.display()));
        for l in lines {
            out.push_str(&format!("- {l}\n"));
        }
    }
    if !any {
        out.push_str("(none)\n");
    }
    for (title, who) in [
        ("Pull requests I opened or updated", "--author"),
        ("Pull requests I reviewed", "--reviewed-by"),
    ] {
        out.push_str(&format!("\n## {title}\n"));
        match pull_requests(gh, who, since) {
            Ok(prs) if prs.is_empty() => out.push_str("(none)\n"),
            Ok(prs) => {
                for p in prs {
                    out.push_str(&format!(
                        "- {}#{} [{}] {} (updated {})\n",
                        p.repository.name_with_owner,
                        p.number,
                        p.state,
                        p.title,
                        p.updated_at.get(..10).unwrap_or(&p.updated_at)
                    ));
                }
            }
            Err(e) => out.push_str(&format!("(GitHub not read: {e})\n")),
        }
    }
    Ok(out)
}

/// `dir`'s commits by its `user.email` since `since`, on any branch, as
/// "date sha subject"; None when it has no email or isn't a repository.
fn commits(dir: &std::path::Path, since: &str) -> Option<Vec<String>> {
    let git = |args: &[&str]| {
        let out = crate::git_bin::git_command()
            .current_dir(dir)
            .args(args)
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let email = git(&["config", "--get", "user.email"]).filter(|e| !e.is_empty())?;
    let author = format!("--author={email}");
    let after = format!("--since={since}T00:00:00");
    let log = git(&[
        "log",
        "--all",
        "--no-merges",
        MAX_COMMITS,
        &after,
        &author,
        "--date=short",
        "--format=%ad %h %s",
    ])?;
    Some(
        log.lines()
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPr {
    repository: RawRepo,
    number: u64,
    title: String,
    state: String,
    updated_at: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRepo {
    name_with_owner: String,
}

/// `gh search prs` with `who` (`--author` or `--reviewed-by`) set to the
/// signed-in user, updated since `since`.
fn pull_requests(gh: &Gh, who: &str, since: &str) -> Result<Vec<RawPr>> {
    let updated = format!(">={since}");
    let args = [
        "search",
        "prs",
        who,
        "@me",
        "--updated",
        &updated,
        "--limit",
        "100",
        "--json",
        "repository,number,title,state,updatedAt",
    ];
    let out = gh.call(None, &args, None, TIMEOUT, None, None)?;
    parse_json(&out.stdout)
}

#[cfg(test)]
mod tests {
    use super::super::tests::Fake;
    use super::my_work_input;
    use std::process::Command;

    fn git(dir: &std::path::Path, args: &[&str]) {
        assert!(Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap()
            .success());
    }

    #[test]
    fn lists_my_commits_and_my_pull_requests() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        git(d, &["init", "-q", "-b", "main"]);
        git(d, &["config", "user.name", "Me"]);
        git(d, &["config", "user.email", "me@example.com"]);
        git(
            d,
            &[
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "fix: the retry count",
            ],
        );
        git(
            d,
            &[
                "-c",
                "user.email=other@example.com",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "someone else's",
            ],
        );
        let fake = Fake::new();
        fake.answer(
            "search prs",
            r#"[{"repository":{"name":"r","nameWithOwner":"o/r"},"number":12,"title":"Retry fix","state":"open","updatedAt":"2026-11-07T10:00:00Z"}]"#,
            "",
            0,
        );
        let text = my_work_input(
            &fake.gh(),
            &[d.to_path_buf(), d.join("missing")],
            "2000-01-01",
        )
        .unwrap();
        assert!(text.contains("fix: the retry count"), "{text}");
        assert!(!text.contains("someone else's"), "{text}");
        assert!(
            text.contains("- o/r#12 [open] Retry fix (updated 2026-11-07)"),
            "{text}"
        );
        let calls = fake.calls();
        assert!(calls.iter().any(
            |c| c.contains(&"--author".to_string()) && c.contains(&">=2000-01-01".to_string())
        ));
        assert!(calls
            .iter()
            .any(|c| c.contains(&"--reviewed-by".to_string())));
    }

    #[test]
    fn a_bad_day_is_refused_and_github_failing_is_said() {
        let fake = Fake::new();
        assert!(my_work_input(&fake.gh(), &[], "yesterday").is_err());
        fake.answer("search prs", "", "HTTP 401", 1);
        let text = my_work_input(&fake.gh(), &[], "2026-11-06").unwrap();
        assert!(text.contains("(GitHub not read:"), "{text}");
        assert!(text.contains("## Commits\n(none)"), "{text}");
    }
}
