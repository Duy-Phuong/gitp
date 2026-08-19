mod common;

use common::FixtureRepo;
use gitp_core::{LogOptions, Repo};

#[test]
fn log_includes_commits_on_branches_not_reachable_from_head() {
    use std::process::Command;
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "1\n", "base");
    let run = |args: &[&str]| {
        let out = Command::new("git").current_dir(fx.path()).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    let start = String::from_utf8(
        Command::new("git")
            .current_dir(fx.path())
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let start = start.trim().to_string();

    // Put a commit on `feature` that HEAD's branch never sees.
    run(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(fx.path().join("b.txt"), "on feature\n").unwrap();
    run(&["add", "."]);
    run(&["commit", "-qm", "only on feature"]);
    run(&["checkout", "-q", &start]); // back to the base branch (HEAD)

    let opts = LogOptions { all_branches: true, ..Default::default() };
    let summaries: Vec<String> = Repo::open(fx.path())
        .unwrap()
        .log(opts)
        .unwrap()
        .into_iter()
        .map(|r| r.summary)
        .collect();
    assert!(
        summaries.iter().any(|s| s == "only on feature"),
        "all_branches walks every branch, not just HEAD: {summaries:?}"
    );

    // And the default (HEAD only) must NOT include the off-HEAD branch.
    let head_only: Vec<String> = Repo::open(fx.path())
        .unwrap()
        .log(LogOptions::default())
        .unwrap()
        .into_iter()
        .map(|r| r.summary)
        .collect();
    assert!(
        !head_only.iter().any(|s| s == "only on feature"),
        "HEAD-only walk excludes the off-HEAD branch: {head_only:?}"
    );
}

#[test]
fn returns_commits_newest_first() {
    let fixture = FixtureRepo::init();
    fixture.commit_file("a.txt", "1", "first");
    fixture.commit_file("a.txt", "2", "second");
    fixture.commit_file("a.txt", "3", "third");

    let repo = Repo::open(fixture.path()).unwrap();
    let rows = repo.log(LogOptions::default()).unwrap();

    let summaries: Vec<&str> = rows.iter().map(|r| r.summary.as_str()).collect();
    assert_eq!(summaries, vec!["third", "second", "first"]);
}

#[test]
fn commit_row_carries_identity_and_parents() {
    let fixture = FixtureRepo::init();
    let first = fixture.commit_file("a.txt", "1", "first");
    let second = fixture.commit_file("a.txt", "2", "second");

    let repo = Repo::open(fixture.path()).unwrap();
    let rows = repo.log(LogOptions::default()).unwrap();

    let head = &rows[0];
    assert_eq!(head.id, second.to_string());
    assert_eq!(head.short_id, &second.to_string()[..7]);
    assert_eq!(head.author_name, "Fixture Author");
    assert_eq!(head.author_email, "author@example.com");
    assert_eq!(head.parents, vec![first.to_string()]);
}

#[test]
fn max_count_limits_rows() {
    let fixture = FixtureRepo::init();
    fixture.commit_file("a.txt", "1", "first");
    fixture.commit_file("a.txt", "2", "second");
    fixture.commit_file("a.txt", "3", "third");

    let repo = Repo::open(fixture.path()).unwrap();
    let rows = repo
        .log(LogOptions {
            max_count: Some(2),
            ..Default::default()
        })
        .unwrap();

    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].summary, "third");
    assert_eq!(rows[1].summary, "second");
}
