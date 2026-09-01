//! Single-level undo/redo reversal: each recorded [`Undoable`] must undo and
//! redo an action exactly, the way the GUI records it around a real operation.

mod common;

use common::FixtureRepo;
use gitp_core::{DeletedBranch, FileBlob, Repo, Undoable};

fn read(fx: &FixtureRepo, name: &str) -> Option<String> {
    std::fs::read_to_string(fx.path().join(name)).ok()
}

#[test]
fn undo_commit_moves_the_tip_back_but_keeps_the_change_staged() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();

    std::fs::write(fx.path().join("a.txt"), "two\n").unwrap();
    repo.stage("a.txt").unwrap();
    let before = repo.head_commit_id().unwrap();
    repo.commit("c2", "", false).unwrap();
    let after = repo.head_commit_id().unwrap();
    assert_ne!(before, after);

    let action = Undoable::HeadMoved {
        label: "Commit".into(),
        before: before.clone(),
        after: after.clone(),
        soft: true,
    };

    repo.undo(&action).unwrap();
    assert_eq!(repo.head_commit_id().unwrap(), before, "tip back at the parent");
    // A soft reset keeps the working tree, so the committed change is still there.
    assert_eq!(read(&fx, "a.txt").as_deref(), Some("two\n"));

    repo.redo(&action).unwrap();
    assert_eq!(repo.head_commit_id().unwrap(), after, "tip restored to the commit");
}

#[test]
fn undo_checkout_returns_to_the_previous_branch() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let head = fx.repo.head().unwrap().peel_to_commit().unwrap();
    fx.repo.branch("feature", &head, false).unwrap();

    let repo = Repo::open(fx.path()).unwrap();
    let before = repo.head_ref_name().unwrap();
    repo.checkout_branch("feature").unwrap();
    let after = repo.head_ref_name().unwrap();
    assert_eq!(after, "feature");

    let action = Undoable::Switched {
        label: "Checkout feature".into(),
        before: before.clone(),
        after: after.clone(),
    };

    repo.undo(&action).unwrap();
    assert_eq!(repo.head_ref_name().unwrap(), before);
    repo.redo(&action).unwrap();
    assert_eq!(repo.head_ref_name().unwrap(), "feature");
}

#[test]
fn undo_delete_branch_recreates_it_at_the_same_commit() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let head = fx.repo.head().unwrap().peel_to_commit().unwrap();
    fx.repo.branch("feature", &head, false).unwrap();

    let repo = Repo::open(fx.path()).unwrap();
    let oid = repo.branch_commit_id("feature").unwrap();
    repo.delete_branch("feature", true).unwrap();
    assert!(repo.branch_commit_id("feature").is_err(), "branch is gone");

    let action = Undoable::BranchesDeleted {
        label: "Delete branch feature".into(),
        branches: vec![DeletedBranch {
            name: "feature".into(),
            oid: oid.clone(),
            upstream: None,
        }],
    };

    repo.undo(&action).unwrap();
    assert_eq!(repo.branch_commit_id("feature").unwrap(), oid, "recreated at its tip");
    repo.redo(&action).unwrap();
    assert!(repo.branch_commit_id("feature").is_err(), "deleted again");
}

/// A bulk delete is one action, so undo has to bring back every branch in it —
/// the case Quick Launch's Clean up depends on.
#[test]
fn undo_recreates_every_branch_of_a_multi_branch_delete() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let head = fx.repo.head().unwrap().peel_to_commit().unwrap();
    for name in ["one", "two", "three"] {
        fx.repo.branch(name, &head, false).unwrap();
    }

    let repo = Repo::open(fx.path()).unwrap();
    let branches: Vec<DeletedBranch> = ["one", "two", "three"]
        .iter()
        .map(|name| DeletedBranch {
            name: (*name).to_string(),
            oid: repo.branch_commit_id(name).unwrap(),
            upstream: None,
        })
        .collect();
    for b in &branches {
        repo.delete_branch(&b.name, true).unwrap();
    }

    let action = Undoable::BranchesDeleted { label: "Delete 3 branches".into(), branches: branches.clone() };
    repo.undo(&action).unwrap();
    for b in &branches {
        assert_eq!(repo.branch_commit_id(&b.name).unwrap(), b.oid, "{} restored", b.name);
    }

    repo.redo(&action).unwrap();
    for b in &branches {
        assert!(repo.branch_commit_id(&b.name).is_err(), "{} deleted again", b.name);
    }
}

#[test]
fn undo_discard_restores_the_file_content() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();

    std::fs::write(fx.path().join("a.txt"), "two\n").unwrap();
    let before = repo.read_workfile("a.txt").unwrap();
    repo.discard_files(&["a.txt".into()]).unwrap();
    let after = repo.read_workfile("a.txt").unwrap();
    assert_eq!(read(&fx, "a.txt").as_deref(), Some("one\n"), "discard reverted to HEAD");

    let action = Undoable::Discarded {
        label: "Discard 1 file".into(),
        files: vec![FileBlob { path: "a.txt".into(), before, after }],
    };

    repo.undo(&action).unwrap();
    assert_eq!(read(&fx, "a.txt").as_deref(), Some("two\n"), "discarded edit restored");
    repo.redo(&action).unwrap();
    assert_eq!(read(&fx, "a.txt").as_deref(), Some("one\n"), "re-discarded");
}

#[test]
fn undo_discard_of_a_new_file_recreates_and_removes_it() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1"); // so HEAD exists
    let repo = Repo::open(fx.path()).unwrap();

    std::fs::write(fx.path().join("new.txt"), "hi\n").unwrap();
    let before = repo.read_workfile("new.txt").unwrap(); // Some
    repo.discard_files(&["new.txt".into()]).unwrap();
    let after = repo.read_workfile("new.txt").unwrap(); // None — new file deleted
    assert_eq!(after, None);

    let action = Undoable::Discarded {
        label: "Discard 1 file".into(),
        files: vec![FileBlob { path: "new.txt".into(), before, after }],
    };

    repo.undo(&action).unwrap();
    assert_eq!(read(&fx, "new.txt").as_deref(), Some("hi\n"), "new file recreated");
    repo.redo(&action).unwrap();
    assert_eq!(read(&fx, "new.txt"), None, "removed again");
}
