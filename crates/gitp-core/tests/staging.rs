//! Staging area: status split into staged/unstaged, stage/unstage, and commit.

mod common;

use common::FixtureRepo;
use gitp_core::Repo;

#[test]
fn status_splits_staged_from_unstaged_and_stage_moves_between_them() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    std::fs::write(fx.path().join("a.txt"), "two\n").unwrap(); // modify tracked
    std::fs::write(fx.path().join("new.txt"), "new\n").unwrap(); // untracked

    let repo = Repo::open(fx.path()).unwrap();

    let s = repo.status_lists().unwrap();
    assert!(s.staged.is_empty(), "nothing staged yet");
    let unstaged: Vec<&str> = s.unstaged.iter().map(|f| f.path.as_str()).collect();
    assert!(unstaged.contains(&"a.txt") && unstaged.contains(&"new.txt"));

    repo.stage("a.txt").unwrap();
    let s = repo.status_lists().unwrap();
    let staged: Vec<&str> = s.staged.iter().map(|f| f.path.as_str()).collect();
    let unstaged: Vec<&str> = s.unstaged.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(staged, vec!["a.txt"], "a.txt is now staged");
    assert!(unstaged.contains(&"new.txt") && !unstaged.contains(&"a.txt"));

    repo.unstage("a.txt").unwrap();
    assert!(repo.status_lists().unwrap().staged.is_empty(), "a.txt unstaged again");
}

#[test]
fn commit_records_staged_changes_and_clears_the_staging_area() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    std::fs::write(fx.path().join("a.txt"), "two\n").unwrap();

    let repo = Repo::open(fx.path()).unwrap();
    repo.stage_all().unwrap();
    repo.commit("change a", "the body", false).unwrap();

    // Nothing left staged, and the new commit is HEAD.
    assert!(repo.status_lists().unwrap().staged.is_empty(), "staging cleared after commit");
    let head = repo.commit_detail("HEAD").unwrap();
    assert_eq!(head.summary, "change a");
    assert!(head.message.contains("the body"), "body recorded in the message");
}
