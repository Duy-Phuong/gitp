//! Branch checkout and uncommitted work.
//!
//! `checkout_branch` uses git2's *safe* strategy, so a switch that would
//! overwrite local modifications must abort and change nothing. These pin that,
//! because the failure mode is silent data loss rather than a wrong number on
//! screen — the one class of bug a comment claiming "nothing was changed" isn't
//! good enough for.

mod common;

use common::FixtureRepo;
use gitp_core::Repo;

fn read(fx: &FixtureRepo, name: &str) -> String {
    std::fs::read_to_string(fx.path().join(name)).expect("file exists")
}

fn head_branch(repo: &Repo) -> String {
    repo.refs().unwrap().head.expect("on a branch")
}

/// master has `a.txt` = "master", `feature` has "feature", and HEAD is master.
fn two_branches_differing_in_a_txt() -> (FixtureRepo, Repo) {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "master\n", "c1");
    // Scoped so the borrow of fx.repo ends before fx is returned.
    {
        let c1 = fx.repo.head().unwrap().peel_to_commit().unwrap();
        fx.repo.branch("feature", &c1, false).unwrap();
    }

    let repo = Repo::open(fx.path()).unwrap();
    repo.checkout_branch("feature").unwrap();
    fx.commit_file("a.txt", "feature\n", "c2");
    repo.checkout_branch("master").unwrap();
    assert_eq!(read(&fx, "a.txt"), "master\n");
    (fx, repo)
}

#[test]
fn a_conflicting_switch_is_refused_and_keeps_the_uncommitted_work() {
    let (fx, repo) = two_branches_differing_in_a_txt();

    // Uncommitted work on the very file the two branches disagree about.
    std::fs::write(fx.path().join("a.txt"), "my precious work\n").unwrap();

    let err = repo.checkout_branch("feature").expect_err("must refuse");

    // The edit survives, byte for byte.
    assert_eq!(
        read(&fx, "a.txt"),
        "my precious work\n",
        "uncommitted changes must not be overwritten"
    );
    // And we're still on the branch we started on, not half-switched.
    assert_eq!(head_branch(&repo), "master", "HEAD must not move");
    // The message has to say what to do about it.
    let msg = err.to_string();
    assert!(msg.contains("uncommitted changes"), "unhelpful message: {msg}");
    assert!(msg.contains("nothing was changed"), "unhelpful message: {msg}");
}

#[test]
fn a_non_conflicting_change_carries_over_to_the_new_branch() {
    let (fx, repo) = two_branches_differing_in_a_txt();

    // Work on a file neither branch touches — git carries this across.
    std::fs::write(fx.path().join("scratch.txt"), "work in progress\n").unwrap();

    repo.checkout_branch("feature").expect("switch is allowed");

    assert_eq!(head_branch(&repo), "feature");
    assert_eq!(read(&fx, "a.txt"), "feature\n", "branch content switched");
    assert_eq!(
        read(&fx, "scratch.txt"),
        "work in progress\n",
        "unrelated work must come along, not be discarded"
    );
}

#[test]
fn an_untracked_file_the_target_branch_would_overwrite_blocks_the_switch() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let c1 = fx.repo.head().unwrap().peel_to_commit().unwrap();
    fx.repo.branch("feature", &c1, false).unwrap();
    let repo = Repo::open(fx.path()).unwrap();

    // `feature` gains new.txt; master doesn't have it.
    repo.checkout_branch("feature").unwrap();
    fx.commit_file("new.txt", "from the branch\n", "c2");
    repo.checkout_branch("master").unwrap();
    assert!(!fx.path().join("new.txt").exists());

    // An untracked file of the same name, with different content, is still the
    // user's data — switching must not silently replace it.
    std::fs::write(fx.path().join("new.txt"), "mine, untracked\n").unwrap();

    let result = repo.checkout_branch("feature");

    assert!(result.is_err(), "must not clobber an untracked file");
    assert_eq!(read(&fx, "new.txt"), "mine, untracked\n", "untracked file preserved");
    assert_eq!(head_branch(&repo), "master", "HEAD must not move");
}

#[test]
fn staged_but_uncommitted_work_on_a_conflicting_file_is_also_kept() {
    let (fx, repo) = two_branches_differing_in_a_txt();

    std::fs::write(fx.path().join("a.txt"), "staged work\n").unwrap();
    repo.stage("a.txt").unwrap();

    assert!(repo.checkout_branch("feature").is_err(), "must refuse");
    assert_eq!(read(&fx, "a.txt"), "staged work\n");
    assert_eq!(head_branch(&repo), "master");
    // Still staged: the index entry wasn't reset out from under the user.
    let status = repo.status_summary().unwrap();
    assert_eq!(status.staged.len(), 1, "the staged change is still staged");
    assert_eq!(status.staged[0].path, "a.txt");
}
