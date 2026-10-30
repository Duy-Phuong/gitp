//! Single-level undo/redo reversal: each recorded [`Undoable`] must undo and
//! redo an action exactly, the way the GUI records it around a real operation.

mod common;

use common::FixtureRepo;
use gitp_core::{DeletedBranch, FileBlob, HeadMoveMode, Repo, ResetMode, Undoable};

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
    repo.commit("c2", "", false, None, false).unwrap();
    let after = repo.head_commit_id().unwrap();
    assert_ne!(before, after);

    let action = Undoable::HeadMoved {
        label: "Commit".into(),
        before: before.clone(),
        after: after.clone(),
        mode: HeadMoveMode::Soft,
        backup: None,
    };

    repo.undo(&action).unwrap();
    assert_eq!(
        repo.head_commit_id().unwrap(),
        before,
        "tip back at the parent"
    );
    // A soft reset keeps the working tree, so the committed change is still there.
    assert_eq!(read(&fx, "a.txt").as_deref(), Some("two\n"));

    repo.redo(&action).unwrap();
    assert_eq!(
        repo.head_commit_id().unwrap(),
        after,
        "tip restored to the commit"
    );
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
    assert_eq!(
        repo.branch_commit_id("feature").unwrap(),
        oid,
        "recreated at its tip"
    );
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

    let action = Undoable::BranchesDeleted {
        label: "Delete 3 branches".into(),
        branches: branches.clone(),
    };
    repo.undo(&action).unwrap();
    for b in &branches {
        assert_eq!(
            repo.branch_commit_id(&b.name).unwrap(),
            b.oid,
            "{} restored",
            b.name
        );
    }

    repo.redo(&action).unwrap();
    for b in &branches {
        assert!(
            repo.branch_commit_id(&b.name).is_err(),
            "{} deleted again",
            b.name
        );
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
    assert_eq!(
        read(&fx, "a.txt").as_deref(),
        Some("one\n"),
        "discard reverted to HEAD"
    );

    let action = Undoable::Discarded {
        label: "Discard 1 file".into(),
        files: vec![FileBlob {
            path: "a.txt".into(),
            before,
            after,
            before_mode: None,
            after_mode: None,
        }],
        index_before: None,
        index_after: None,
    };

    repo.undo(&action).unwrap();
    assert_eq!(
        read(&fx, "a.txt").as_deref(),
        Some("two\n"),
        "discarded edit restored"
    );
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
        files: vec![FileBlob {
            path: "new.txt".into(),
            before,
            after,
            before_mode: None,
            after_mode: None,
        }],
        index_before: None,
        index_after: None,
    };

    repo.undo(&action).unwrap();
    assert_eq!(
        read(&fx, "new.txt").as_deref(),
        Some("hi\n"),
        "new file recreated"
    );
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

    let action = Undoable::IndexChanged {
        label: "Stage".into(),
        before,
        after,
    };

    repo.undo(&action).unwrap();
    assert_eq!(
        porcelain(&fx),
        mixed,
        "undo returns to exactly the mixed state"
    );

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

    repo.undo(&Undoable::IndexChanged {
        label: "Stage all".into(),
        before,
        after,
    })
    .unwrap();
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

    repo.undo(&Undoable::IndexChanged {
        label: "Stage".into(),
        before,
        after,
    })
    .unwrap();

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
    assert!(
        !repo.refs().unwrap().tags.iter().any(|t| t.name == "v1.0"),
        "tag gone"
    );

    repo.redo(&action).unwrap();
    assert!(
        repo.refs().unwrap().tags.iter().any(|t| t.name == "v1.0"),
        "tag back"
    );
}

#[test]
fn undo_of_a_tag_delete_restores_an_annotated_tag_with_its_message() {
    let fx = FixtureRepo::init();
    let oid = fx.commit_file("a.txt", "one\n", "c1");
    let target = fx.repo.find_object(oid, None).unwrap();
    let sig = git2::Signature::new("T", "t@t.io", &git2::Time::new(1_700_000_000, 0)).unwrap();
    fx.repo
        .tag("v2.0", &target, &sig, "the release\n", false)
        .unwrap();

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
    assert!(
        detail.annotated,
        "restored as an annotated tag, not a lightweight one"
    );
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
    cfg.set_str("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
        .unwrap();
}

#[test]
fn undo_restores_the_previous_upstream() {
    let fx = FixtureRepo::init();
    let oid = fx.commit_file("a.txt", "one\n", "c1");
    configure_origin(&fx);
    fx.repo
        .reference("refs/remotes/origin/one", oid, true, "t")
        .unwrap();
    fx.repo
        .reference("refs/remotes/origin/two", oid, true, "t")
        .unwrap();
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
    fx.repo
        .reference("refs/remotes/origin/one", oid, true, "t")
        .unwrap();
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
    assert!(
        stashes[0].message.contains("my wip"),
        "and keeps its message: {:?}",
        stashes[0].message
    );
    assert_eq!(
        repo.stash_commit_id(0).unwrap(),
        oid,
        "the same commit, not a new one"
    );

    repo.redo(&action).unwrap();
    assert!(
        repo.refs().unwrap().stashes.is_empty(),
        "redo drops it again"
    );
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

    let action = Undoable::StashDropped {
        label: "Drop stash".into(),
        oid,
        message,
    };
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

// --- preconditions -------------------------------------------------------------
//
// Undo applies a recorded target; it must first check the repository is still
// where the action left it, or it reverses whatever happened since instead.

#[test]
fn undo_is_refused_after_an_out_of_band_commit() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    let before = repo.head_commit_id().unwrap();
    fx.commit_file("a.txt", "two\n", "c2");
    let after = repo.head_commit_id().unwrap();
    let action = Undoable::HeadMoved {
        label: "Commit".into(),
        before: before.clone(),
        after,
        mode: HeadMoveMode::Soft,
        backup: None,
    };
    repo.can_undo(&action).expect("still at c2");

    // c3 made elsewhere (the terminal): undoing "Commit" would now drop it.
    let c3 = fx.commit_file("a.txt", "three\n", "c3");
    let err = repo.can_undo(&action).unwrap_err().to_string();
    assert!(err.contains("changed since"), "got {err}");
    assert_eq!(repo.head_commit_id().unwrap(), c3.to_string(), "untouched");

    // And redo is the mirror: only valid while back at `before`.
    assert!(repo.can_redo(&action).is_err());
    repo.reset(&before, gitp_core::ResetMode::Soft).unwrap();
    repo.can_redo(&action)
        .expect("back at before, redo allowed");
}

#[test]
fn undo_and_redo_are_refused_while_a_merge_is_in_progress() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    let head = repo.head_commit_id().unwrap();
    let action = Undoable::Switched {
        label: "Checkout".into(),
        before: head.clone(),
        after: repo.head_ref_name().unwrap(),
    };
    repo.can_undo(&action).expect("ok before the merge starts");

    // A merge session is nothing more than this file as far as git is concerned.
    std::fs::write(fx.path().join(".git/MERGE_HEAD"), format!("{head}\n")).unwrap();
    assert!(repo.operation_in_progress());
    let err = repo.can_undo(&action).unwrap_err().to_string();
    assert!(err.contains("in progress"), "got {err}");
    assert!(repo.can_redo(&action).is_err());
}

#[test]
fn stale_index_and_discard_snapshots_are_detected() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();

    std::fs::write(fx.path().join("a.txt"), "edited\n").unwrap();
    let before = repo.snapshot_index("t-before").unwrap().unwrap();
    repo.stage("a.txt").unwrap();
    let after = repo.snapshot_index("t-after").unwrap().unwrap();
    let staged = Undoable::IndexChanged {
        label: "Stage".into(),
        before,
        after,
    };
    repo.can_undo(&staged).expect("index is as recorded");
    repo.unstage("a.txt").unwrap(); // the terminal unstaged it meanwhile
    assert!(repo.can_undo(&staged).is_err(), "index no longer matches");

    let discard = Undoable::Discarded {
        label: "Discard".into(),
        files: vec![FileBlob {
            path: "a.txt".into(),
            before: Some(b"edited\n".to_vec()),
            after: Some(b"one\n".to_vec()),
            before_mode: None,
            after_mode: None,
        }],
        index_before: None,
        index_after: None,
    };
    assert!(
        repo.can_undo(&discard).is_err(),
        "the file still holds the edit, not the discarded result"
    );
    repo.can_redo(&discard)
        .expect("the file is at its `before` bytes");
}

#[test]
fn undo_of_create_branch_is_refused_once_the_branch_has_moved() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    let prev = repo.head_ref_name().unwrap();
    let at = repo.head_commit_id().unwrap();
    repo.create_branch("feature").unwrap();
    let action = Undoable::BranchCreated {
        label: "Create branch feature".into(),
        name: "feature".into(),
        at,
        prev,
    };
    repo.can_undo(&action).expect("fresh branch, nothing on it");

    // A commit on the new branch: `branch -D` would lose it.
    fx.commit_file("b.txt", "two\n", "on feature");
    assert!(repo.can_undo(&action).is_err());
}

// --- idempotent branch restore -------------------------------------------------

#[test]
fn undo_of_a_bulk_delete_skips_branches_already_back_and_reports_the_rest() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let head = fx.repo.head().unwrap().peel_to_commit().unwrap();
    for name in ["one", "two"] {
        fx.repo.branch(name, &head, false).unwrap();
    }
    let repo = Repo::open(fx.path()).unwrap();
    let oid = repo.branch_commit_id("one").unwrap();
    repo.delete_branch("one", true).unwrap();
    repo.delete_branch("two", true).unwrap();

    // `one` was already recreated (say, by a first undo that then failed on
    // `two`). A retry must not fail on "already exists" for it.
    fx.repo.branch("one", &head, false).unwrap();
    let action = Undoable::BranchesDeleted {
        label: "Delete 2 branches".into(),
        branches: vec![
            DeletedBranch {
                name: "one".into(),
                oid: oid.clone(),
                upstream: None,
            },
            DeletedBranch {
                name: "two".into(),
                oid: oid.clone(),
                upstream: None,
            },
        ],
    };
    repo.can_undo(&action)
        .expect("a branch already at its tip is fine");
    repo.undo(&action).unwrap();
    assert_eq!(repo.branch_commit_id("two").unwrap(), oid);

    // A branch that cannot be recreated is reported, after the others are tried.
    repo.delete_branch("two", true).unwrap();
    let bad = Undoable::BranchesDeleted {
        label: "Delete 2 branches".into(),
        branches: vec![
            DeletedBranch {
                name: "bad name".into(),
                oid: oid.clone(),
                upstream: None,
            },
            DeletedBranch {
                name: "two".into(),
                oid: oid.clone(),
                upstream: None,
            },
        ],
    };
    let err = repo.undo(&bad).unwrap_err().to_string();
    assert!(err.contains("bad name"), "names the failure: {err}");
    assert_eq!(
        repo.branch_commit_id("two").unwrap(),
        oid,
        "the branch after the failure was still restored"
    );
}

// --- tags are never force-restored ---------------------------------------------

#[test]
fn undo_of_a_tag_delete_does_not_retarget_a_tag_the_user_recreated() {
    let fx = FixtureRepo::init();
    let c1 = fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    repo.create_tag_at("v1", &c1.to_string()).unwrap();
    let target = repo.tag_ref_target("v1").unwrap();
    repo.delete_tag("v1").unwrap();
    let action = Undoable::TagDeleted {
        label: "Delete tag v1".into(),
        name: "v1".into(),
        target,
    };
    repo.can_undo(&action).expect("tag absent, as recorded");

    // The user re-creates v1 somewhere else.
    let c2 = fx.commit_file("a.txt", "two\n", "c2");
    repo.create_tag_at("v1", &c2.to_string()).unwrap();
    assert!(repo.can_undo(&action).is_err(), "the guard refuses");
    assert!(
        repo.undo(&action).is_err(),
        "and the restore itself never forces"
    );
    assert_eq!(repo.tag_ref_target("v1").unwrap(), c2.to_string());
}

// --- index restore safety ------------------------------------------------------

#[test]
fn restoring_the_index_is_refused_while_another_git_holds_the_lock() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    std::fs::write(fx.path().join("a.txt"), "edited\n").unwrap();
    let before = repo.snapshot_index("t-before").unwrap().unwrap();
    repo.stage("a.txt").unwrap();
    let after = repo.snapshot_index("t-after").unwrap().unwrap();

    std::fs::write(fx.path().join(".git/index.lock"), b"").unwrap();
    let err = repo
        .undo(&Undoable::IndexChanged {
            label: "Stage".into(),
            before,
            after,
        })
        .unwrap_err()
        .to_string();
    assert!(err.contains("locked"), "got {err}");
    assert_eq!(
        repo.status_summary().unwrap().staged.len(),
        1,
        "index untouched"
    );
}

#[test]
fn undo_of_a_discard_restores_the_staged_part_too() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();

    // `MM a.txt`: a staged edit plus a further unstaged edit.
    std::fs::write(fx.path().join("a.txt"), "staged\n").unwrap();
    repo.stage("a.txt").unwrap();
    std::fs::write(fx.path().join("a.txt"), "staged\nunstaged\n").unwrap();
    let mixed = porcelain(&fx);
    assert_eq!(mixed, "MM a.txt");

    let index_before = repo.snapshot_index("t-before").unwrap();
    let before = repo.read_workfile("a.txt").unwrap();
    repo.discard_files(&["a.txt".into()]).unwrap();
    let index_after = repo.snapshot_index("t-after").unwrap();
    let after = repo.read_workfile("a.txt").unwrap();
    assert_eq!(porcelain(&fx), "", "discard reset both index and file");

    let action = Undoable::Discarded {
        label: "Discard 1 file".into(),
        files: vec![FileBlob {
            path: "a.txt".into(),
            before,
            after,
            before_mode: None,
            after_mode: None,
        }],
        index_before,
        index_after,
    };
    repo.undo(&action).unwrap();
    assert_eq!(
        porcelain(&fx),
        mixed,
        "the staged hunk is back in the index, not just the file"
    );
    repo.redo(&action).unwrap();
    assert_eq!(porcelain(&fx), "");
}

#[test]
fn a_dropped_stash_is_only_restorable_while_it_is_off_the_stack() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    std::fs::write(fx.path().join("a.txt"), "wip\n").unwrap();
    stash_with_message(&fx, "wip");
    let action = Undoable::StashDropped {
        label: "Drop stash".into(),
        oid: repo.stash_commit_id(0).unwrap(),
        message: "wip".into(),
    };
    assert!(repo.can_undo(&action).is_err(), "still on the stack");
    repo.can_redo(&action)
        .expect("on the stack, so it can be dropped");
    repo.stash_drop(0).unwrap();
    repo.can_undo(&action).expect("gone, so it can come back");
    assert!(repo.can_redo(&action).is_err());
}

/// `git status` rewrites `.git/index` whenever stat data changes — touching an
/// unchanged file is enough — so the precondition must compare what is staged,
/// not the file's bytes.
#[test]
fn undo_of_a_stage_survives_a_stat_only_index_rewrite() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    fx.commit_file("b.txt", "one\n", "c2");
    let repo = Repo::open(fx.path()).unwrap();

    std::fs::write(fx.path().join("a.txt"), "edited\n").unwrap();
    let before = repo.snapshot_index("t-before").unwrap().unwrap();
    repo.stage("a.txt").unwrap();
    let after = repo.snapshot_index("t-after").unwrap().unwrap();
    let action = Undoable::IndexChanged {
        label: "Stage".into(),
        before,
        after: after.clone(),
    };

    // Touch b.txt (same bytes, new mtime) and let `git status` refresh the index.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    std::fs::write(fx.path().join("b.txt"), "one\n").unwrap();
    let _ = porcelain(&fx);
    assert_ne!(
        std::fs::read(fx.path().join(".git/index")).unwrap(),
        std::fs::read(&after).unwrap(),
        "the index bytes did change (stat data)"
    );

    repo.can_undo(&action)
        .expect("the staging area itself is unchanged");
    repo.undo(&action).unwrap();
    assert!(repo.status_summary().unwrap().staged.is_empty(), "unstaged");
}

// --- resets --------------------------------------------------------------------
//
// A reset is undone with the mode that can't lose work for it: `--mixed` for a
// mixed reset (whose leftover edits `--keep` refuses), `--keep` plus the saved
// backup for a hard one.

/// The `HeadMoved` record the GUI makes around a reset.
fn head_moved(before: &str, after: &str, mode: HeadMoveMode, backup: Option<String>) -> Undoable {
    Undoable::HeadMoved {
        label: "Reset".into(),
        before: before.into(),
        after: after.into(),
        mode,
        backup,
    }
}

#[test]
fn mixed_reset_undo_and_redo_keep_the_working_tree_edits() {
    let fx = FixtureRepo::init();
    let c1 = fx.commit_file("a.txt", "one\n", "c1").to_string();
    let c2 = fx.commit_file("a.txt", "two\n", "c2").to_string();
    let repo = Repo::open(fx.path()).unwrap();

    repo.reset(&c1, ResetMode::Mixed).unwrap();
    assert_eq!(
        porcelain(&fx),
        " M a.txt",
        "the reset left c2's change as an edit"
    );
    // And an edit of the user's own on top, which neither move may touch.
    std::fs::write(fx.path().join("a.txt"), "two, edited\n").unwrap();

    let action = head_moved(&c2, &c1, HeadMoveMode::Mixed, None);
    repo.undo(&action).unwrap();
    assert_eq!(repo.head_commit_id().unwrap(), c2);
    assert_eq!(read(&fx, "a.txt").as_deref(), Some("two, edited\n"));
    assert_eq!(porcelain(&fx), " M a.txt");

    repo.redo(&action).unwrap();
    assert_eq!(repo.head_commit_id().unwrap(), c1);
    assert_eq!(read(&fx, "a.txt").as_deref(), Some("two, edited\n"));
}

#[test]
fn a_refused_keep_move_names_the_files_in_the_way() {
    let fx = FixtureRepo::init();
    let c1 = fx.commit_file("a.txt", "one\n", "c1").to_string();
    fx.commit_file("b.txt", "one\n", "c2");
    let c3 = fx.commit_file("a.txt", "three\n", "c3").to_string();
    let repo = Repo::open(fx.path()).unwrap();

    // A cherry-pick-like move c1 → c3, then a local edit to a file it changed.
    repo.reset(&c1, ResetMode::Hard).unwrap();
    std::fs::write(fx.path().join("a.txt"), "mine\n").unwrap();
    let action = head_moved(&c3, &c1, HeadMoveMode::Keep, None);

    let err = repo.undo(&action).unwrap_err().to_string();
    assert!(err.contains("Undo would overwrite"), "got {err}");
    assert!(err.contains("a.txt"), "names the file: {err}");
    assert!(!err.contains("b.txt"), "b.txt has no local edit: {err}");
    assert!(err.contains("Commit or stash"), "says what to do: {err}");
    assert!(!err.contains("not uptodate"), "not git's raw output: {err}");
    assert_eq!(repo.head_commit_id().unwrap(), c1, "nothing moved");
    assert_eq!(read(&fx, "a.txt").as_deref(), Some("mine\n"), "edit kept");
}

#[test]
fn hard_reset_undo_restores_the_commits_and_the_exact_uncommitted_work() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let c2 = fx.commit_file("gone.txt", "kept\n", "c2").to_string();
    let c3 = fx.commit_file("a.txt", "three\n", "c3").to_string();
    let repo = Repo::open(fx.path()).unwrap();

    // Uncommitted work of every kind: an edit, a deletion, a new untracked
    // file (in a new folder), and an edit to a file the reset also changes.
    std::fs::write(fx.path().join("a.txt"), "three, edited\n").unwrap();
    std::fs::remove_file(fx.path().join("gone.txt")).unwrap();
    std::fs::create_dir(fx.path().join("sub")).unwrap();
    std::fs::write(fx.path().join("sub/new.txt"), "brand new\n").unwrap();
    let work = porcelain(&fx);
    let index = std::fs::read(fx.path().join(".git/index")).unwrap();

    let backup = repo
        .backup_uncommitted_work()
        .unwrap()
        .expect("work to save");
    assert_eq!(porcelain(&fx), work, "the working tree is untouched");
    assert_eq!(
        std::fs::read(fx.path().join(".git/index")).unwrap(),
        index,
        "the real index is untouched"
    );
    let refs = std::process::Command::new("git")
        .current_dir(fx.path())
        .args([
            "for-each-ref",
            "--format=%(objectname)",
            "refs/gitp/backups/",
        ])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&refs.stdout).trim(),
        backup,
        "kept under a private ref"
    );

    repo.reset(&c2, ResetMode::Hard).unwrap();
    assert_eq!(read(&fx, "a.txt").as_deref(), Some("one\n"));
    let action = head_moved(&c3, &c2, HeadMoveMode::Keep, Some(backup));

    repo.undo(&action).unwrap();
    assert_eq!(repo.head_commit_id().unwrap(), c3, "commits back");
    assert_eq!(read(&fx, "a.txt").as_deref(), Some("three, edited\n"));
    assert_eq!(read(&fx, "gone.txt"), None, "the deletion is back too");
    assert_eq!(read(&fx, "sub/new.txt").as_deref(), Some("brand new\n"));
    assert_eq!(porcelain(&fx), work, "back as the same uncommitted changes");

    // Redo throws the work away again (it is still in the backup)…
    repo.redo(&action).unwrap();
    assert_eq!(repo.head_commit_id().unwrap(), c2);
    assert_eq!(read(&fx, "a.txt").as_deref(), Some("one\n"));
    assert_eq!(read(&fx, "gone.txt").as_deref(), Some("kept\n"));
    // …and a second undo brings it back again.
    repo.undo(&action).unwrap();
    assert_eq!(porcelain(&fx), work);
}

/// `git <args>` output in the fixture repo (test helper).
fn git_out(fx: &FixtureRepo, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .current_dir(fx.path())
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

// The staging area is work too: a file staged at one version and edited to
// another must come back split the same way, and a staged new file that is no
// longer on disk exists only in the index.
#[test]
fn hard_reset_undo_restores_the_staged_and_unstaged_split() {
    let fx = FixtureRepo::init();
    let c1 = fx.commit_file("f.txt", "v1\n", "c1").to_string();
    let c2 = fx.commit_file("g.txt", "g\n", "c2").to_string();
    let repo = Repo::open(fx.path()).unwrap();

    std::fs::write(fx.path().join("f.txt"), "v2\n").unwrap();
    std::fs::write(fx.path().join("s.txt"), "staged, then deleted\n").unwrap();
    std::fs::write(fx.path().join("t.txt"), "staged new\n").unwrap();
    git_out(&fx, &["add", "f.txt", "s.txt", "t.txt"]);
    std::fs::write(fx.path().join("f.txt"), "v3\n").unwrap();
    std::fs::remove_file(fx.path().join("s.txt")).unwrap();
    // Untracked: a hard reset leaves it alone, so it isn't backed up.
    std::fs::write(fx.path().join("u.txt"), "untracked\n").unwrap();
    let work = porcelain(&fx);
    let index = git_out(&fx, &["ls-files", "-s"]);
    assert_eq!(work, "?? u.txt\nA  t.txt\nAD s.txt\nMM f.txt");

    let backup = repo
        .backup_uncommitted_work()
        .unwrap()
        .expect("work to save");
    let saved = git_out(&fx, &["ls-tree", "-r", "--name-only", &backup]);
    assert!(
        !saved.contains("u.txt"),
        "untracked files stay out: {saved}"
    );
    repo.reset(&c1, ResetMode::Hard).unwrap();
    let action = head_moved(&c2, &c1, HeadMoveMode::Keep, Some(backup));

    repo.undo(&action).unwrap();
    assert_eq!(repo.head_commit_id().unwrap(), c2);
    assert_eq!(porcelain(&fx), work);
    assert_eq!(
        git_out(&fx, &["ls-files", "-s"]),
        index,
        "the index exactly"
    );
    assert_eq!(git_out(&fx, &["show", ":f.txt"]), "v2\n");
    assert_eq!(read(&fx, "f.txt").as_deref(), Some("v3\n"));

    repo.redo(&action).unwrap();
    assert_eq!(repo.head_commit_id().unwrap(), c1);
    assert_eq!(porcelain(&fx), "?? u.txt");
    repo.undo(&action).unwrap();
    assert_eq!(porcelain(&fx), work);
    assert_eq!(git_out(&fx, &["ls-files", "-s"]), index);
}

#[test]
fn hard_reset_undo_refuses_to_overwrite_work_done_since() {
    let fx = FixtureRepo::init();
    let c1 = fx.commit_file("a.txt", "one\n", "c1").to_string();
    let c2 = fx.commit_file("b.txt", "two\n", "c2").to_string();
    let repo = Repo::open(fx.path()).unwrap();
    std::fs::write(fx.path().join("a.txt"), "saved work\n").unwrap();
    let backup = repo
        .backup_uncommitted_work()
        .unwrap()
        .expect("work to save");
    repo.reset(&c1, ResetMode::Hard).unwrap();
    let action = head_moved(&c2, &c1, HeadMoveMode::Keep, Some(backup));

    // New work in a file the backup would overwrite.
    std::fs::write(fx.path().join("a.txt"), "newer work\n").unwrap();
    let err = repo.undo(&action).unwrap_err().to_string();
    assert!(
        err.contains("a.txt") && err.contains("Commit or stash"),
        "got {err}"
    );
    assert_eq!(repo.head_commit_id().unwrap(), c1, "nothing moved");
    assert_eq!(read(&fx, "a.txt").as_deref(), Some("newer work\n"));
}

#[test]
fn no_backup_without_uncommitted_work_and_old_backups_are_pruned() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    std::fs::write(fx.path().join(".gitignore"), "ignored.txt\n").unwrap();
    std::fs::write(fx.path().join("ignored.txt"), "x\n").unwrap();
    fx.commit_file(".gitignore", "ignored.txt\n", "ignore");
    assert_eq!(
        repo.backup_uncommitted_work().unwrap(),
        None,
        "ignored files don't count"
    );
    // Nor untracked ones: a hard reset leaves them where they are.
    std::fs::write(fx.path().join("untracked.txt"), "x\n").unwrap();
    assert_eq!(repo.backup_uncommitted_work().unwrap(), None);

    std::fs::write(fx.path().join("a.txt"), "edited\n").unwrap();
    for _ in 0..22 {
        repo.backup_uncommitted_work().unwrap().expect("saved");
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    let refs = std::process::Command::new("git")
        .current_dir(fx.path())
        .args(["for-each-ref", "refs/gitp/backups/"])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&refs.stdout).lines().count(), 20);
}
