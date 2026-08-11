mod common;

use common::FixtureRepo;
use gitp_core::{ChangeKind, Repo};

fn added_lines(file: &gitp_core::FileDiff) -> Vec<String> {
    file.hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .filter(|l| l.origin == '+')
        .map(|l| l.content.clone())
        .collect()
}

fn removed_lines(file: &gitp_core::FileDiff) -> Vec<String> {
    file.hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .filter(|l| l.origin == '-')
        .map(|l| l.content.clone())
        .collect()
}

#[test]
fn reports_metadata_and_an_added_file() {
    let fixture = FixtureRepo::init();
    let c = fixture.commit_file("a.txt", "hello\n", "add a");

    let repo = Repo::open(fixture.path()).unwrap();
    let detail = repo.commit_detail(&c.to_string()).unwrap();

    assert_eq!(detail.id, c.to_string());
    assert_eq!(detail.summary, "add a");
    assert_eq!(detail.author_name, "Fixture Author");
    assert_eq!(detail.author_email, "author@example.com");

    assert_eq!(detail.files.len(), 1);
    let file = &detail.files[0];
    assert_eq!(file.path, "a.txt");
    assert_eq!(file.status, ChangeKind::Added);
    assert!(added_lines(file).iter().any(|l| l.contains("hello")));
}

#[test]
fn reports_a_modification_with_added_and_removed_lines() {
    let fixture = FixtureRepo::init();
    fixture.commit_file("a.txt", "1\n2\n3\n", "init");
    let c2 = fixture.commit_file("a.txt", "1\nCHANGED\n3\n", "edit");

    let repo = Repo::open(fixture.path()).unwrap();
    let detail = repo.commit_detail(&c2.to_string()).unwrap();

    assert_eq!(detail.files.len(), 1);
    let file = &detail.files[0];
    assert_eq!(file.path, "a.txt");
    assert_eq!(file.status, ChangeKind::Modified);
    assert!(added_lines(file).iter().any(|l| l.contains("CHANGED")));
    assert!(removed_lines(file).iter().any(|l| l.trim() == "2"));
}
