//! Undo of the actions added after the first round — branch moves and
//! additions, the stash's save / apply / rename, remote changes — plus round
//! trips the first round never checked: a rename, a merge, a cherry-pick.

mod common;

use std::process::Command;

use common::FixtureRepo;
use gitp_core::{HeadMoveMode, MergeMode, Repo, Undoable};

fn git(fx: &FixtureRepo, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(fx.path())
        .args(args)
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn read(fx: &FixtureRepo, name: &str) -> Option<String> {
    std::fs::read_to_string(fx.path().join(name)).ok()
}

fn stash_list(fx: &FixtureRepo) -> Vec<String> {
    git(fx, &["stash", "list", "--format=%gs"])
        .lines()
        .map(str::to_string)
        .collect()
}

/// Write `name` and commit it through the git CLI. The fixture's own
/// `commit_file` goes through a git2 index handle that doesn't notice a
/// checkout made by the CLI in between, so after one it would commit a stale
/// tree.
fn commit_cli(fx: &FixtureRepo, name: &str, contents: &str, message: &str) {
    std::fs::write(fx.path().join(name), contents).unwrap();
    git(fx, &["add", name]);
    git(fx, &["commit", "-q", "-m", message]);
}

/// `main` with two commits, and `side` one commit ahead of the first.
fn with_side_branch() -> (FixtureRepo, Repo, String) {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    let main = repo.refs().unwrap().head.unwrap();
    repo.create_branch_here("side").unwrap();
    repo.checkout_branch("side").unwrap();
    commit_cli(&fx, "b.txt", "b\n", "side1");
    repo.checkout_branch(&main).unwrap();
    commit_cli(&fx, "c.txt", "c\n", "c2");
    (fx, repo, main)
}

// --- the first round's untested round trips ----------------------------------

#[test]
fn a_branch_rename_is_undone_and_redone() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    repo.create_branch_here("old").unwrap();
    repo.rename_branch("old", "new").unwrap();
    let action = Undoable::BranchRenamed {
        label: "Rename".into(),
        old: "old".into(),
        new: "new".into(),
    };
    repo.can_undo(&action).unwrap();
    repo.undo(&action).unwrap();
    assert!(repo.branch_commit_id("old").is_ok() && repo.branch_commit_id("new").is_err());
    repo.can_redo(&action).unwrap();
    repo.redo(&action).unwrap();
    assert!(repo.branch_commit_id("new").is_ok() && repo.branch_commit_id("old").is_err());
    // A third branch under the old name since: the rename can't be redone
    // over it.
    repo.undo(&action).unwrap();
    repo.create_branch_here("new").unwrap();
    assert!(repo.can_redo(&action).is_err());
}

#[test]
fn a_merge_commit_is_undone_with_a_keep_reset_and_redone() {
    let (fx, repo, _main) = with_side_branch();
    let before = repo.head_commit_id().unwrap();
    repo.merge_branch("side", MergeMode::NoFastForward).unwrap();
    let after = repo.head_commit_id().unwrap();
    assert_ne!(before, after);
    assert!(read(&fx, "b.txt").is_some());

    let action = Undoable::HeadMoved {
        label: "Merge side".into(),
        before: before.clone(),
        after: after.clone(),
        mode: HeadMoveMode::Keep,
        backup: None,
    };
    repo.undo(&action).unwrap();
    assert_eq!(repo.head_commit_id().unwrap(), before);
    assert!(
        read(&fx, "b.txt").is_none(),
        "the merged file leaves with the merge"
    );
    assert_eq!(git(&fx, &["status", "--porcelain"]), "");
    repo.redo(&action).unwrap();
    assert_eq!(repo.head_commit_id().unwrap(), after);
    assert!(read(&fx, "b.txt").is_some());
}

#[test]
fn a_cherry_pick_is_undone_without_touching_unrelated_edits() {
    let (fx, repo, _main) = with_side_branch();
    let side_tip = repo.branch_commit_id("side").unwrap();
    // An unrelated local edit must survive the undo (`--keep` leaves it).
    std::fs::write(fx.path().join("a.txt"), "edited\n").unwrap();
    let before = repo.head_commit_id().unwrap();
    repo.cherry_pick(&side_tip).unwrap();
    let after = repo.head_commit_id().unwrap();
    let action = Undoable::HeadMoved {
        label: "Cherry-pick".into(),
        before: before.clone(),
        after,
        mode: HeadMoveMode::Keep,
        backup: None,
    };
    repo.undo(&action).unwrap();
    assert_eq!(repo.head_commit_id().unwrap(), before);
    assert_eq!(read(&fx, "a.txt").as_deref(), Some("edited\n"));
    assert!(read(&fx, "b.txt").is_none());
}

// --- branches that aren't checked out -------------------------------------------

#[test]
fn moving_another_branch_is_undone_by_pointing_it_back() {
    let (fx, repo, _main) = with_side_branch();
    let before = repo.branch_commit_id("side").unwrap();
    let to = repo.head_commit_id().unwrap();
    // Not a fast-forward of HEAD: `side` is moved while `main` stays checked out.
    git(&fx, &["branch", "-f", "side", &to]);
    let action = Undoable::BranchMoved {
        label: "Fast-forward side".into(),
        name: "side".into(),
        before: before.clone(),
        after: to.clone(),
    };
    repo.can_undo(&action).unwrap();
    repo.undo(&action).unwrap();
    assert_eq!(repo.branch_commit_id("side").unwrap(), before);
    repo.redo(&action).unwrap();
    assert_eq!(repo.branch_commit_id("side").unwrap(), to);

    // Once the branch is checked out it is HEAD's to move, not this record's.
    repo.checkout_branch("side").unwrap();
    assert!(repo.can_undo(&action).is_err());
    // And a branch moved by something else since is left alone.
    repo.checkout_branch("main")
        .unwrap_or_else(|_| repo.checkout_branch("master").unwrap());
    git(&fx, &["branch", "-f", "side", &before]);
    git(&fx, &["commit", "--allow-empty", "-m", "x"]);
    git(&fx, &["branch", "-f", "side", "HEAD"]);
    assert!(repo.can_undo(&action).is_err());
}

#[test]
fn a_branch_added_without_checkout_is_removed_by_undo_and_back_on_redo() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    let at = repo.head_commit_id().unwrap();
    repo.create_branch_here("backup").unwrap();
    let action = Undoable::BranchAdded {
        label: "Create branch backup".into(),
        name: "backup".into(),
        at: at.clone(),
    };
    repo.can_undo(&action).unwrap();
    repo.undo(&action).unwrap();
    assert!(repo.branch_commit_id("backup").is_err());
    repo.can_redo(&action).unwrap();
    repo.redo(&action).unwrap();
    assert_eq!(repo.branch_commit_id("backup").unwrap(), at);
    // Checked out, it is no longer "a branch that was merely added".
    repo.checkout_branch("backup").unwrap();
    assert!(repo.can_undo(&action).is_err());
}

// --- the stash ------------------------------------------------------------------

fn dirty_tree(fx: &FixtureRepo) -> Repo {
    fx.commit_file("a.txt", "a\n", "c1");
    fx.commit_file("b.txt", "b\n", "c2");
    let repo = Repo::open(fx.path()).unwrap();
    std::fs::write(fx.path().join("a.txt"), "a staged\n").unwrap();
    repo.stage("a.txt").unwrap();
    std::fs::write(fx.path().join("b.txt"), "b unstaged\n").unwrap();
    std::fs::write(fx.path().join("new.txt"), "new\n").unwrap();
    repo
}

#[test]
fn undoing_a_stash_pops_it_back_with_the_staged_split_and_redo_stashes_anew() {
    let fx = FixtureRepo::init();
    let repo = dirty_tree(&fx);
    let status_before = repo.status_fingerprint().unwrap();
    assert!(!status_before.is_empty());

    repo.stash_push(Some("wip"), false, true).unwrap();
    assert_eq!(git(&fx, &["status", "--porcelain"]), "");
    let oid = repo.stash_commit_id(0).unwrap();
    let action = Undoable::StashSaved {
        label: "Stash".into(),
        oid: oid.clone(),
        message: Some("wip".into()),
        staged: false,
        include_untracked: true,
        paths: vec![],
        status_before: status_before.clone(),
        status_after: repo.status_fingerprint().unwrap(),
    };

    repo.can_undo(&action).unwrap();
    repo.undo(&action).unwrap();
    assert_eq!(
        repo.status_fingerprint().unwrap(),
        status_before,
        "same split as before"
    );
    assert_eq!(read(&fx, "new.txt").as_deref(), Some("new\n"));
    assert!(stash_list(&fx).is_empty(), "the entry was popped");

    // Redo stashes again: a new entry, which `after_redo` records.
    repo.can_redo(&action).unwrap();
    repo.redo(&action).unwrap();
    assert_eq!(git(&fx, &["status", "--porcelain"]), "");
    // Stashing the same tree twice within a second makes the same commit
    // again, so the id may or may not change — the record follows it either way.
    let renewed = repo.after_redo(&action).expect("the entry on top");
    let Undoable::StashSaved { oid: new_oid, .. } = &renewed else {
        panic!()
    };
    assert_eq!(new_oid, &repo.stash_commit_id(0).unwrap());
    repo.can_undo(&renewed).unwrap();
    assert_eq!(stash_list(&fx), vec!["On master: wip".to_string()]);
}

#[test]
fn a_stash_is_not_popped_back_over_edits_made_since() {
    let fx = FixtureRepo::init();
    let repo = dirty_tree(&fx);
    let status_before = repo.status_fingerprint().unwrap();
    repo.stash_push(None, false, true).unwrap();
    let action = Undoable::StashSaved {
        label: "Stash".into(),
        oid: repo.stash_commit_id(0).unwrap(),
        message: None,
        staged: false,
        include_untracked: true,
        paths: vec![],
        status_before,
        status_after: repo.status_fingerprint().unwrap(),
    };
    std::fs::write(fx.path().join("a.txt"), "typed after stashing\n").unwrap();
    assert!(repo.can_undo(&action).is_err());
}

#[test]
fn undoing_a_pop_stashes_the_changes_again_and_redo_pops_them() {
    let fx = FixtureRepo::init();
    let repo = dirty_tree(&fx);
    repo.stash_push(Some("wip"), false, true).unwrap();
    let oid = repo.stash_commit_id(0).unwrap();
    assert_eq!(repo.status_fingerprint().unwrap(), "");

    repo.stash_apply(0, true).unwrap();
    let action = Undoable::StashApplied {
        label: "Pop stash".into(),
        oid: oid.clone(),
        message: Some("wip".into()),
        dropped: true,
        status_after: repo.status_fingerprint().unwrap(),
    };
    repo.can_undo(&action).unwrap();
    repo.undo(&action).unwrap();
    assert_eq!(git(&fx, &["status", "--porcelain"]), "", "clean again");
    assert_eq!(stash_list(&fx), vec!["On master: wip".to_string()]);
    let renewed = repo.after_undo(&action).expect("re-created entry");
    repo.can_redo(&renewed).unwrap();
    repo.redo(&renewed).unwrap();
    assert_eq!(read(&fx, "new.txt").as_deref(), Some("new\n"));
    assert!(stash_list(&fx).is_empty());
}

#[test]
fn undoing_an_apply_leaves_the_entry_on_the_stack() {
    let fx = FixtureRepo::init();
    let repo = dirty_tree(&fx);
    repo.stash_push(Some("keep me"), false, true).unwrap();
    let oid = repo.stash_commit_id(0).unwrap();
    repo.stash_apply(0, false).unwrap();
    let action = Undoable::StashApplied {
        label: "Apply stash".into(),
        oid: oid.clone(),
        message: Some("keep me".into()),
        dropped: false,
        status_after: repo.status_fingerprint().unwrap(),
    };
    repo.undo(&action).unwrap();
    assert_eq!(git(&fx, &["status", "--porcelain"]), "");
    assert_eq!(stash_list(&fx).len(), 1, "no duplicate left behind");
    assert_eq!(repo.stash_commit_id(0).unwrap(), oid);
    assert!(repo.after_undo(&action).is_none());
    // An edit on the clean tree blocks the redo: applying would land on it.
    std::fs::write(fx.path().join("a.txt"), "x\n").unwrap();
    assert!(repo.can_redo(&action).is_err());
}

#[test]
fn a_stash_rename_is_undone_to_its_exact_old_text() {
    let fx = FixtureRepo::init();
    let repo = dirty_tree(&fx);
    repo.stash_push(None, false, true).unwrap();
    let oid = repo.stash_commit_id(0).unwrap();
    let before = repo.stash_reflog_message(&oid).unwrap();
    assert!(before.starts_with("WIP on "));
    repo.stash_rename(0, "better name").unwrap();
    let action = Undoable::StashRenamed {
        label: "Rename stash".into(),
        oid: oid.clone(),
        before: before.clone(),
        after: "better name".into(),
    };
    repo.can_undo(&action).unwrap();
    repo.undo(&action).unwrap();
    assert_eq!(repo.stash_reflog_message(&oid).unwrap(), before);
    repo.redo(&action).unwrap();
    assert_eq!(stash_list(&fx), vec!["better name".to_string()]);
}

#[test]
fn stash_user_message_strips_gits_prefix() {
    assert_eq!(
        Repo::stash_user_message("On main: fix the thing"),
        Some("fix the thing".into())
    );
    assert_eq!(
        Repo::stash_user_message("On feature/x: a: b"),
        Some("a: b".into())
    );
    assert_eq!(Repo::stash_user_message("WIP on main: 1234 subject"), None);
}

// --- remotes --------------------------------------------------------------------

#[test]
fn remote_add_url_change_and_rename_all_round_trip() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();

    repo.add_remote("up", "https://example.com/a.git").unwrap();
    let added = Undoable::RemoteAdded {
        label: "Add remote up".into(),
        name: "up".into(),
        url: "https://example.com/a.git".into(),
    };
    repo.can_undo(&added).unwrap();
    repo.undo(&added).unwrap();
    assert!(repo.remote_url("up").is_none());
    repo.redo(&added).unwrap();
    assert_eq!(
        repo.remote_url("up").as_deref(),
        Some("https://example.com/a.git")
    );

    repo.set_remote_url("up", "https://example.com/b.git")
        .unwrap();
    let changed = Undoable::RemoteUrlChanged {
        label: "Change URL".into(),
        name: "up".into(),
        before: "https://example.com/a.git".into(),
        after: "https://example.com/b.git".into(),
    };
    repo.undo(&changed).unwrap();
    assert_eq!(
        repo.remote_url("up").as_deref(),
        Some("https://example.com/a.git")
    );
    repo.redo(&changed).unwrap();

    repo.rename_remote("up", "origin").unwrap();
    let renamed = Undoable::RemoteRenamed {
        label: "Rename remote".into(),
        old: "up".into(),
        new: "origin".into(),
    };
    repo.can_undo(&renamed).unwrap();
    repo.undo(&renamed).unwrap();
    assert!(repo.remote_url("up").is_some() && repo.remote_url("origin").is_none());
    repo.redo(&renamed).unwrap();
    assert!(repo.remote_url("origin").is_some());
}

#[test]
fn an_added_remote_is_not_removed_once_something_was_fetched_from_it() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    repo.add_remote("self", fx.path().to_str().unwrap())
        .unwrap();
    let added = Undoable::RemoteAdded {
        label: "Add remote self".into(),
        name: "self".into(),
        url: fx.path().to_str().unwrap().into(),
    };
    repo.can_undo(&added).unwrap();
    git(&fx, &["fetch", "self"]);
    assert!(
        repo.can_undo(&added).is_err(),
        "removing it now would take its tracking refs"
    );
}

// --- patches --------------------------------------------------------------------

#[test]
fn patch_paths_lists_every_file_including_both_names_of_a_rename() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a\n", "c1");
    fx.commit_file("dir/old name.txt", "same content for a rename\n", "c2");
    let repo = Repo::open(fx.path()).unwrap();
    git(&fx, &["mv", "dir/old name.txt", "dir/new name.txt"]);
    std::fs::write(fx.path().join("a.txt"), "a2\n").unwrap();
    git(&fx, &["add", "a.txt"]);
    let patch = fx.path().join("change.patch");
    std::fs::write(&patch, git(&fx, &["diff", "--cached", "-M"]) + "\n").unwrap();

    let mut paths = repo.patch_paths(&patch).unwrap();
    paths.sort();
    assert_eq!(paths, vec!["a.txt", "dir/new name.txt", "dir/old name.txt"]);
}
