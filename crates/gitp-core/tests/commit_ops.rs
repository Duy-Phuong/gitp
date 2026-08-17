//! Commit-scoped history operations driven by the log's right-click menu.

mod common;

use common::FixtureRepo;
use gitp_core::{Repo, ResetMode};

/// A repo with three linear commits on `main`; returns their oids oldest→newest.
fn linear_repo() -> (FixtureRepo, Vec<String>) {
    let fx = FixtureRepo::init();
    let c1 = fx.commit_file("a.txt", "one\n", "c1");
    let c2 = fx.commit_file("a.txt", "two\n", "c2");
    let c3 = fx.commit_file("a.txt", "three\n", "c3");
    (fx, vec![c1.to_string(), c2.to_string(), c3.to_string()])
}

#[test]
fn checkout_commit_detaches_head_at_that_commit() {
    let (fx, oids) = linear_repo();
    let repo = Repo::open(fx.path()).unwrap();

    repo.checkout_commit(&oids[0]).unwrap();

    // Detached HEAD: no branch is current, and the tree matches the old commit.
    assert!(repo.refs().unwrap().head.is_none(), "HEAD is detached");
    assert_eq!(std::fs::read_to_string(fx.path().join("a.txt")).unwrap(), "one\n");
}

#[test]
fn create_branch_at_makes_and_checks_out_a_branch_at_the_commit() {
    let (fx, oids) = linear_repo();
    let repo = Repo::open(fx.path()).unwrap();

    repo.create_branch_at("hotfix", &oids[0]).unwrap();

    assert_eq!(repo.refs().unwrap().head.as_deref(), Some("hotfix"));
    assert_eq!(std::fs::read_to_string(fx.path().join("a.txt")).unwrap(), "one\n");
}

#[test]
fn create_tag_at_tags_the_commit_without_moving_head() {
    let (fx, oids) = linear_repo();
    let repo = Repo::open(fx.path()).unwrap();

    repo.create_tag_at("v1.0", &oids[1]).unwrap();

    let refs = repo.refs().unwrap();
    let tag = refs.tags.iter().find(|t| t.name == "v1.0").expect("tag exists");
    assert_eq!(tag.target, oids[1], "tag points at the requested commit");
    assert_eq!(refs.head.as_deref(), Some("master"), "HEAD unchanged");
}

#[test]
fn reset_hard_moves_the_branch_and_discards_later_commits() {
    let (fx, oids) = linear_repo();
    let repo = Repo::open(fx.path()).unwrap();

    repo.reset(&oids[0], ResetMode::Hard).unwrap();

    // main now tips at c1; only c1 remains reachable, tree reverted.
    assert_eq!(repo.log(Default::default()).unwrap().len(), 1);
    assert_eq!(std::fs::read_to_string(fx.path().join("a.txt")).unwrap(), "one\n");
}

#[test]
fn revert_adds_an_inverse_commit() {
    let (fx, _oids) = linear_repo();
    let repo = Repo::open(fx.path()).unwrap();
    let head = fx.repo.head().unwrap().peel_to_commit().unwrap().id().to_string();

    repo.revert(&head).unwrap();

    // A new commit was added on top, undoing c3's change back to "two".
    assert_eq!(repo.log(Default::default()).unwrap().len(), 4);
    assert_eq!(std::fs::read_to_string(fx.path().join("a.txt")).unwrap(), "two\n");
}

#[test]
fn cherry_pick_applies_a_commit_from_another_branch() {
    // master: c1 → c2 ; side branches at c1 and adds side.txt.
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let c1 = fx.repo.head().unwrap().peel_to_commit().unwrap();
    fx.repo.branch("side", &c1, false).unwrap();
    fx.commit_file("a.txt", "two\n", "c2");

    let repo = Repo::open(fx.path()).unwrap();
    repo.checkout_branch("side").unwrap();
    let side = fx.commit_file("side.txt", "hi\n", "add side");

    repo.checkout_branch("master").unwrap();
    repo.cherry_pick(&side.to_string()).unwrap();

    // The cherry-picked file now exists on master.
    assert!(fx.path().join("side.txt").exists(), "cherry-picked file present on master");
}
