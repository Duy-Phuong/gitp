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

#[test]
fn commit_file_diff_follows_the_requested_context() {
    let fixture = FixtureRepo::init();
    let base: String = (1..=12).map(|n| format!("line {n}\n")).collect();
    fixture.commit_file("f.txt", &base, "base");
    let edited = base
        .replace("line 2\n", "LINE 2\n")
        .replace("line 11\n", "LINE 11\n");
    let c = fixture.commit_file("f.txt", &edited, "edit");
    let repo = Repo::open(fixture.path()).unwrap();
    let rev = c.to_string();

    let default = repo
        .commit_file_diff(&rev, "f.txt", None, 3, None)
        .unwrap()
        .unwrap();
    assert_eq!(default.hunks.len(), 2);

    let full = repo
        .commit_file_diff(&rev, "f.txt", None, u32::MAX, None)
        .unwrap()
        .unwrap();
    assert_eq!(full.hunks.len(), 1);
    assert_eq!(full.hunks[0].lines.len(), 14, "every line of the file");
    assert_eq!(added_lines(&full), vec!["LINE 2", "LINE 11"]);

    assert!(repo
        .commit_file_diff(&rev, "missing.txt", None, 3, None)
        .unwrap()
        .is_none());
}

#[test]
fn commit_file_diff_keeps_a_rename_paired() {
    let fixture = FixtureRepo::init();
    let body: String = (1..=20).map(|n| format!("line {n}\n")).collect();
    fixture.commit_file("old.txt", &body, "add");
    let git = |args: &[&str]| {
        let ok = std::process::Command::new("git")
            .current_dir(fixture.path())
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    };
    git(&["mv", "old.txt", "new.txt"]);
    std::fs::write(
        fixture.path().join("new.txt"),
        body.replace("line 5\n", "LINE 5\n"),
    )
    .unwrap();
    git(&["commit", "-qam", "rename"]);
    let repo = Repo::open(fixture.path()).unwrap();

    let file = repo
        .commit_file_diff("HEAD", "new.txt", Some("old.txt"), 3, None)
        .unwrap()
        .unwrap();
    assert_eq!(file.status, ChangeKind::Renamed);
    assert_eq!(file.old_path.as_deref(), Some("old.txt"));
    assert_eq!(added_lines(&file), vec!["LINE 5"]);
}

#[test]
fn commit_file_diff_can_ignore_whitespace() {
    let fixture = FixtureRepo::init();
    fixture.commit_file("f.txt", "fn a() {\n    x();\n}\nkeep\n", "base");
    // Re-indent one line (whitespace only) and really change another.
    let c = fixture.commit_file("f.txt", "fn a() {\n\tx();\n}\nKEEP\n", "edit");
    let repo = Repo::open(fixture.path()).unwrap();
    let rev = c.to_string();

    let all = repo
        .commit_file_diff_with(&rev, "f.txt", None, 3, false, None)
        .unwrap()
        .unwrap();
    assert_eq!(added_lines(&all), vec!["\tx();", "KEEP"]);

    let no_ws = repo
        .commit_file_diff_with(&rev, "f.txt", None, 3, true, None)
        .unwrap()
        .unwrap();
    assert_eq!(added_lines(&no_ws), vec!["KEEP"], "the re-indent is hidden");
}

#[test]
fn a_huge_file_is_truncated_by_default_and_whole_on_request() {
    let fx = FixtureRepo::init();
    fx.commit_file("small.txt", "one\n", "c1");
    let big: String = (0..gitp_core::MAX_DIFF_LINES + 10)
        .map(|i| format!("line {i}\n"))
        .collect();
    let oid = fx.commit_file("big.txt", &big, "c2");
    let repo = Repo::open(fx.path()).unwrap();

    // The commit's own diff keeps only the hunks that fit under the cap — for
    // one hunk bigger than the cap, that is none — and says so.
    let detail = repo.commit_detail(&oid.to_string()).unwrap();
    let big_file = detail.files.iter().find(|f| f.path == "big.txt").unwrap();
    assert!(big_file.truncated);
    assert!(big_file.hunks.is_empty());

    // Asking for the file without a cap returns everything.
    let full = repo
        .commit_file_diff(&oid.to_string(), "big.txt", None, 3, None)
        .unwrap()
        .unwrap();
    assert!(!full.truncated);
    assert_eq!(full.hunks.len(), 1);
    assert_eq!(full.hunks[0].lines.len(), gitp_core::MAX_DIFF_LINES + 10);

    // A small file is untouched either way.
    let small = detail.files.iter().find(|f| f.path == "small.txt");
    assert!(small.is_none() || !small.unwrap().truncated);
}
