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

// --- staging -----------------------------------------------------------------
//
// Staging is recorded as the index's tree on each side rather than a list of
// paths. These pin the reason why: partial staging and mixed states have to come
// back exactly, which a per-path record cannot express.

/// What `git status --porcelain` reports, as a stable sorted string.
fn porcelain(fx: &FixtureRepo) -> String {
    let out = std::process::Command::new("git")
        .current_dir(fx.path())
        .args(["status", "--porcelain"])
        .output()
        .expect("git status");
    let mut lines: Vec<&str> = std::str::from_utf8(&out.stdout).unwrap().lines().collect();
    lines.sort_unstable();
    lines.join("\n")
}

#[test]
fn undo_restores_the_staging_area_exactly_and_redo_reapplies_it() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    fx.commit_file("b.txt", "one\n", "c2");
    let repo = Repo::open(fx.path()).unwrap();

    std::fs::write(fx.path().join("a.txt"), "edited a\n").unwrap();
    std::fs::write(fx.path().join("b.txt"), "edited b\n").unwrap();

    // A mixed state: a.txt staged, b.txt not.
    repo.stage("a.txt").unwrap();
    let before = repo.snapshot_index("t-before").unwrap().expect("snapshot");
    let mixed = porcelain(&fx);

    repo.stage("b.txt").unwrap();
    let after = repo.snapshot_index("t-after").unwrap().expect("snapshot");
    let both = porcelain(&fx);
    assert_ne!(mixed, both, "staging b.txt changed the status");

    let action = Undoable::IndexChanged { label: "Stage".into(), before, after };

    repo.undo(&action).unwrap();
    assert_eq!(porcelain(&fx), mixed, "undo returns to exactly the mixed state");

    repo.redo(&action).unwrap();
    assert_eq!(porcelain(&fx), both, "redo stages b.txt again");
}

#[test]
fn undoing_stage_all_returns_to_the_mixture_that_was_there_not_to_nothing_staged() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    fx.commit_file("b.txt", "one\n", "c2");
    let repo = Repo::open(fx.path()).unwrap();

    std::fs::write(fx.path().join("a.txt"), "edited a\n").unwrap();
    std::fs::write(fx.path().join("b.txt"), "edited b\n").unwrap();
    repo.stage("a.txt").unwrap(); // a staged, b not — the state to come back to

    let before = repo.snapshot_index("t-before").unwrap().unwrap();
    let mixed = porcelain(&fx);
    repo.stage_all().unwrap();
    let after = repo.snapshot_index("t-after").unwrap().unwrap();

    let status = repo.status_summary().unwrap();
    assert_eq!(status.staged.len(), 2, "stage all staged both");

    repo.undo(&Undoable::IndexChanged { label: "Stage all".into(), before, after }).unwrap();
    assert_eq!(
        porcelain(&fx),
        mixed,
        "a.txt must still be staged — undo is not 'unstage everything'"
    );
}

#[test]
fn undoing_a_stage_leaves_the_working_tree_alone() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();

    std::fs::write(fx.path().join("a.txt"), "my edit\n").unwrap();
    let before = repo.snapshot_index("t-before").unwrap().unwrap();
    repo.stage("a.txt").unwrap();
    let after = repo.snapshot_index("t-after").unwrap().unwrap();

    repo.undo(&Undoable::IndexChanged { label: "Stage".into(), before, after }).unwrap();

    // Unstaging must never touch the file itself.
    assert_eq!(
        std::fs::read_to_string(fx.path().join("a.txt")).unwrap(),
        "my edit\n",
        "the edit itself survives an undo of staging"
    );
}

// --- tags --------------------------------------------------------------------

#[test]
fn undo_of_a_tag_creation_removes_it_and_redo_puts_it_back() {
    let fx = FixtureRepo::init();
    let oid = fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    repo.create_tag_at("v1.0", &oid.to_string()).unwrap();

    let target = repo.tag_ref_target("v1.0").unwrap();
    let action = Undoable::TagCreated {
        label: "Tag v1.0".into(),
        name: "v1.0".into(),
        target,
    };

    repo.undo(&action).unwrap();
    assert!(!repo.refs().unwrap().tags.iter().any(|t| t.name == "v1.0"), "tag gone");

    repo.redo(&action).unwrap();
    assert!(repo.refs().unwrap().tags.iter().any(|t| t.name == "v1.0"), "tag back");
}

#[test]
fn undo_of_a_tag_delete_restores_an_annotated_tag_with_its_message() {
    let fx = FixtureRepo::init();
    let oid = fx.commit_file("a.txt", "one\n", "c1");
    let target = fx.repo.find_object(oid, None).unwrap();
    let sig = git2::Signature::new("T", "t@t.io", &git2::Time::new(1_700_000_000, 0)).unwrap();
    fx.repo.tag("v2.0", &target, &sig, "the release\n", false).unwrap();

    let repo = Repo::open(fx.path()).unwrap();
    // The *ref* target: the tag object, not the commit it peels to.
    let ref_target = repo.tag_ref_target("v2.0").unwrap();
    repo.delete_tag("v2.0").unwrap();

    let action = Undoable::TagDeleted {
        label: "Delete tag v2.0".into(),
        name: "v2.0".into(),
        target: ref_target,
    };
    repo.undo(&action).unwrap();

    let detail = repo.tag_detail("v2.0").expect("tag is back");
    assert!(detail.annotated, "restored as an annotated tag, not a lightweight one");
    assert_eq!(detail.message.as_deref(), Some("the release\n"));
    assert_eq!(detail.target, oid.to_string());

    repo.redo(&action).unwrap();
    assert!(repo.tag_detail("v2.0").is_err(), "redo deletes it again");
}

// --- upstream ----------------------------------------------------------------
//
// `git branch --set-upstream-to` only accepts a ref it recognises as a remote
// branch, which means the remote needs its fetch refspec configured — a bare
// `refs/remotes/...` ref isn't enough.
fn configure_origin(fx: &FixtureRepo) {
    let mut cfg = fx.repo.config().unwrap();
    cfg.set_str("remote.origin.url", ".").unwrap();
    cfg.set_str("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*").unwrap();
}

#[test]
fn undo_restores_the_previous_upstream() {
    let fx = FixtureRepo::init();
    let oid = fx.commit_file("a.txt", "one\n", "c1");
    configure_origin(&fx);
    fx.repo.reference("refs/remotes/origin/one", oid, true, "t").unwrap();
    fx.repo.reference("refs/remotes/origin/two", oid, true, "t").unwrap();
    let repo = Repo::open(fx.path()).unwrap();
    let head = repo.refs().unwrap().head.expect("on a branch");

    repo.set_upstream(&head, "origin/one").unwrap();
    let before = repo.branch_upstream(&head).unwrap();
    repo.set_upstream(&head, "origin/two").unwrap();
    let after = repo.branch_upstream(&head).unwrap();
    assert_ne!(before, after);

    let action = Undoable::UpstreamChanged {
        label: "Set upstream".into(),
        branch: head.clone(),
        before: before.clone(),
        after: after.clone(),
    };
    repo.undo(&action).unwrap();
    assert_eq!(repo.branch_upstream(&head).unwrap(), before);
    repo.redo(&action).unwrap();
    assert_eq!(repo.branch_upstream(&head).unwrap(), after);
}

#[test]
fn undo_of_unset_upstream_puts_the_tracking_back() {
    let fx = FixtureRepo::init();
    let oid = fx.commit_file("a.txt", "one\n", "c1");
    configure_origin(&fx);
    fx.repo.reference("refs/remotes/origin/one", oid, true, "t").unwrap();
    let repo = Repo::open(fx.path()).unwrap();
    let head = repo.refs().unwrap().head.unwrap();

    repo.set_upstream(&head, "origin/one").unwrap();
    let before = repo.branch_upstream(&head).unwrap();
    repo.unset_upstream(&head).unwrap();
    assert_eq!(repo.branch_upstream(&head).unwrap(), None, "cleared");

    repo.undo(&Undoable::UpstreamChanged {
        label: "Unset upstream".into(),
        branch: head.clone(),
        before: before.clone(),
        after: None,
    })
    .unwrap();
    assert_eq!(repo.branch_upstream(&head).unwrap(), before);
}

// --- stash -------------------------------------------------------------------

/// `git stash push -m` — the crate's own `stash()` takes no message, and these
/// tests need to tell entries apart.
fn stash_with_message(fx: &FixtureRepo, message: &str) {
    let status = std::process::Command::new("git")
        .current_dir(fx.path())
        .args(["stash", "push", "-m", message])
        .status()
        .expect("git stash push");
    assert!(status.success(), "stash push failed");
}

#[test]
fn undo_of_a_stash_drop_puts_the_entry_back_with_its_message() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();

    std::fs::write(fx.path().join("a.txt"), "work in progress\n").unwrap();
    stash_with_message(&fx, "my wip");
    assert_eq!(repo.refs().unwrap().stashes.len(), 1);

    let oid = repo.stash_commit_id(0).unwrap();
    let message = repo.stash_message(0).unwrap();
    repo.stash_drop(0).unwrap();
    assert!(repo.refs().unwrap().stashes.is_empty(), "dropped");

    let action = Undoable::StashDropped {
        label: "Drop stash".into(),
        oid: oid.clone(),
        message,
    };
    repo.undo(&action).unwrap();

    let stashes = repo.refs().unwrap().stashes;
    assert_eq!(stashes.len(), 1, "the entry is back on the stack");
    assert!(stashes[0].message.contains("my wip"), "and keeps its message: {:?}", stashes[0].message);
    assert_eq!(repo.stash_commit_id(0).unwrap(), oid, "the same commit, not a new one");

    repo.redo(&action).unwrap();
    assert!(repo.refs().unwrap().stashes.is_empty(), "redo drops it again");
}

#[test]
fn undoing_a_stash_drop_does_not_disturb_other_entries() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();

    std::fs::write(fx.path().join("a.txt"), "first\n").unwrap();
    stash_with_message(&fx, "first wip");
    std::fs::write(fx.path().join("a.txt"), "second\n").unwrap();
    stash_with_message(&fx, "second wip");
    assert_eq!(repo.refs().unwrap().stashes.len(), 2);

    // Drop the older entry (index 1), keeping the newer one.
    let oid = repo.stash_commit_id(1).unwrap();
    let message = repo.stash_message(1).unwrap();
    repo.stash_drop(1).unwrap();
    assert_eq!(repo.refs().unwrap().stashes.len(), 1);

    let action = Undoable::StashDropped { label: "Drop stash".into(), oid, message };
    repo.undo(&action).unwrap();
    let stashes = repo.refs().unwrap().stashes;
    assert_eq!(stashes.len(), 2, "both entries present again");

    // Redo must remove the restored one wherever it landed, not blindly drop
    // stash@{0} — restoring pushes it onto the top of the stack.
    repo.redo(&action).unwrap();
    let after = repo.refs().unwrap().stashes;
    assert_eq!(after.len(), 1, "exactly one left");
    assert!(
        after[0].message.contains("second wip"),
        "the survivor is the one we never touched, got {:?}",
        after[0].message
    );
}
