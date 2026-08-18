//! Stash context-menu operations: apply (keep vs. drop), drop, rename, and
//! save-as-patch. Each builds a hermetic repo, stashes a real change, then
//! exercises one operation and asserts on the working tree / stash stack.

mod common;

use std::path::Path;
use std::process::Command;

use common::FixtureRepo;
use gitp_core::Repo;

/// The stash stack's messages, newest first (`git stash list` order).
fn stash_messages(dir: &Path) -> Vec<String> {
    let out = Command::new("git")
        .current_dir(dir)
        .args(["stash", "list", "--format=%gs"])
        .output()
        .expect("git stash list");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .collect()
}

/// Seed a one-commit repo, dirty a tracked file, and stash it.
fn repo_with_one_stash() -> (FixtureRepo, Repo) {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    std::fs::write(fx.path().join("a.txt"), "two\n").unwrap();
    let repo = Repo::open(fx.path()).unwrap();
    repo.stash().expect("stash the change");
    (fx, repo)
}

#[test]
fn apply_without_drop_restores_the_change_and_keeps_the_entry() {
    let (fx, repo) = repo_with_one_stash();

    repo.stash_apply(0, false).expect("apply stash@{0}");

    assert_eq!(
        std::fs::read_to_string(fx.path().join("a.txt")).unwrap(),
        "two\n",
        "the stashed change is back in the working tree"
    );
    assert_eq!(stash_messages(fx.path()).len(), 1, "apply leaves the entry on the stack");
}

#[test]
fn apply_with_drop_pops_the_entry() {
    let (fx, repo) = repo_with_one_stash();

    repo.stash_apply(0, true).expect("pop stash@{0}");

    assert_eq!(std::fs::read_to_string(fx.path().join("a.txt")).unwrap(), "two\n");
    assert!(stash_messages(fx.path()).is_empty(), "pop removes the entry");
}

#[test]
fn drop_removes_the_entry_without_touching_the_working_tree() {
    let (fx, repo) = repo_with_one_stash();

    repo.stash_drop(0).expect("drop stash@{0}");

    assert_eq!(
        std::fs::read_to_string(fx.path().join("a.txt")).unwrap(),
        "one\n",
        "drop discards the stash, leaving HEAD's content"
    );
    assert!(stash_messages(fx.path()).is_empty());
}

#[test]
fn rename_replaces_the_message_and_preserves_the_content() {
    let (fx, repo) = repo_with_one_stash();
    let before = stash_messages(fx.path());
    assert_eq!(before.len(), 1);

    repo.stash_rename(0, "my saved work").expect("rename stash@{0}");

    let after = stash_messages(fx.path());
    assert_eq!(after, vec!["my saved work".to_string()], "exactly one entry, re-messaged");

    // The renamed stash still applies its original change.
    repo.stash_apply(0, true).expect("pop the renamed stash");
    assert_eq!(std::fs::read_to_string(fx.path().join("a.txt")).unwrap(), "two\n");
}

#[test]
fn rename_targets_the_right_entry_and_moves_it_to_the_top() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "base\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();

    // Two stashes: after both, stash@{0} is the newest ("second change").
    std::fs::write(fx.path().join("a.txt"), "first change\n").unwrap();
    repo.stash().unwrap();
    let newest_before = stash_messages(fx.path())[0].clone();
    std::fs::write(fx.path().join("a.txt"), "second change\n").unwrap();
    repo.stash().unwrap();

    // Rename the older one (index 1). Re-storing lands it at the top, so the
    // renamed entry becomes stash@{0} and the previously-newest shifts down.
    repo.stash_rename(1, "older renamed").expect("rename stash@{1}");

    let msgs = stash_messages(fx.path());
    assert_eq!(msgs.len(), 2, "still two entries after rename");
    assert_eq!(msgs[0], "older renamed", "the renamed entry moves to the top");
    assert_eq!(msgs[1], newest_before, "the other entry keeps its own message");

    // Renaming must not have disturbed the renamed stash's content.
    repo.stash_apply(0, true).expect("pop the renamed stash");
    assert_eq!(std::fs::read_to_string(fx.path().join("a.txt")).unwrap(), "first change\n");
}

#[test]
fn save_stash_patch_writes_the_diff_to_disk() {
    let (fx, repo) = repo_with_one_stash();
    let patch = fx.path().join("out.patch");

    repo.save_stash_patch(0, &patch).expect("write the patch");

    let text = std::fs::read_to_string(&patch).unwrap();
    assert!(text.contains("a.txt"), "patch names the changed file");
    assert!(text.contains("+two"), "patch includes the added line");
    assert!(text.ends_with('\n'), "patch ends with a trailing newline");
}
