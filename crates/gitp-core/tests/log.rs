mod common;

use common::FixtureRepo;
use gitp_core::{LogOptions, Repo};

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
