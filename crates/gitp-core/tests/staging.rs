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
fn status_summary_lists_files_without_hunks_and_file_diff_fills_them_in() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    std::fs::write(fx.path().join("a.txt"), "two\n").unwrap(); // modify tracked
    std::fs::write(fx.path().join("new.txt"), "new\n").unwrap(); // untracked

    let repo = Repo::open(fx.path()).unwrap();
    repo.stage("a.txt").unwrap();

    // Summary carries the same paths/statuses as status_lists, but no hunks.
    let sum = repo.status_summary().unwrap();
    let staged: Vec<&str> = sum.staged.iter().map(|f| f.path.as_str()).collect();
    let unstaged: Vec<&str> = sum.unstaged.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(staged, vec!["a.txt"]);
    assert!(unstaged.contains(&"new.txt"));
    assert!(
        sum.staged.iter().chain(&sum.unstaged).all(|f| f.hunks.is_empty()),
        "summary omits hunks"
    );

    // file_diff fills in the hunks for a modified file, in the staged direction.
    let staged_diff = repo.file_diff("a.txt", true).unwrap().expect("a.txt staged diff");
    assert!(!staged_diff.hunks.is_empty(), "staged diff has hunks");
    // An untracked file is reported in the unstaged direction (content-less, same
    // as status_lists, which doesn't enable show_untracked_content).
    let untracked = repo.file_diff("new.txt", false).unwrap().expect("new.txt diff");
    assert_eq!(untracked.status, gitp_core::ChangeKind::Untracked);

    // No change in a direction → None (a.txt has nothing left unstaged).
    assert!(repo.file_diff("a.txt", false).unwrap().is_none(), "a.txt fully staged");
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
