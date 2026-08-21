//! Branch-scoped operations from the sidebar menu: rename, delete, merge.

mod common;

use common::FixtureRepo;
use gitp_core::Repo;

#[test]
fn rename_branch_changes_its_name() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let c1 = fx.repo.head().unwrap().peel_to_commit().unwrap();
    fx.repo.branch("old-name", &c1, false).unwrap();

    let repo = Repo::open(fx.path()).unwrap();
    repo.rename_branch("old-name", "new-name").unwrap();

    let names: Vec<String> = repo.refs().unwrap().branches.into_iter().map(|b| b.name).collect();
    assert!(names.contains(&"new-name".to_string()), "renamed branch present");
    assert!(!names.contains(&"old-name".to_string()), "old name gone");
}

#[test]
fn delete_branch_removes_a_merged_branch_but_refuses_unmerged_without_force() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let c1 = fx.repo.head().unwrap().peel_to_commit().unwrap();
    // `merged` points at HEAD (fully merged); `feature` has an extra commit.
    fx.repo.branch("merged", &c1, false).unwrap();
    fx.repo.branch("feature", &c1, false).unwrap();
    let repo = Repo::open(fx.path()).unwrap();
    repo.checkout_branch("feature").unwrap();
    fx.commit_file("a.txt", "two\n", "c2"); // feature is now ahead
    repo.checkout_branch("master").unwrap();

    // Safe delete removes the merged branch.
    repo.delete_branch("merged", false).unwrap();
    assert!(!branch_names(&repo).contains(&"merged".to_string()));

    // Safe delete refuses the unmerged branch…
    assert!(repo.delete_branch("feature", false).is_err(), "unmerged: refused");
    assert!(branch_names(&repo).contains(&"feature".to_string()), "still there");
    // …until forced.
    repo.delete_branch("feature", true).unwrap();
    assert!(!branch_names(&repo).contains(&"feature".to_string()), "force-deleted");
}

#[test]
fn merge_branch_brings_in_another_branchs_commit() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let c1 = fx.repo.head().unwrap().peel_to_commit().unwrap();
    fx.repo.branch("side", &c1, false).unwrap();

    let repo = Repo::open(fx.path()).unwrap();
    repo.checkout_branch("side").unwrap();
    fx.commit_file("side.txt", "hi\n", "add side");
    repo.checkout_branch("master").unwrap();

    repo.merge_branch("side").unwrap();
    assert!(fx.path().join("side.txt").exists(), "side's file merged into master");
}

#[test]
fn delete_remote_branch_removes_it_from_the_remote() {
    use std::process::Command;
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");

    // A bare repo standing in for `origin`.
    let remote_dir = tempfile::tempdir().unwrap();
    let run = |dir: &std::path::Path, args: &[&str]| {
        let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    run(remote_dir.path(), &["init", "--bare", "-q"]);
    let remote_url = remote_dir.path().to_str().unwrap();
    run(fx.path(), &["remote", "add", "origin", remote_url]);
    // Push a feature branch and set it up to track origin.
    run(fx.path(), &["branch", "feature/x"]);
    run(fx.path(), &["push", "-u", "origin", "feature/x"]);

    // Precondition: the remote has the branch.
    let before = run(fx.path(), &["ls-remote", "--heads", "origin", "feature/x"]);
    assert!(before.contains("feature/x"), "remote has the branch to start");

    let repo = Repo::open(fx.path()).unwrap();
    repo.delete_remote_branch("feature/x").unwrap();

    let after = run(fx.path(), &["ls-remote", "--heads", "origin", "feature/x"]);
    assert!(after.is_empty(), "remote branch is gone after delete_remote_branch");
}

fn branch_names(repo: &Repo) -> Vec<String> {
    repo.refs().unwrap().branches.into_iter().map(|b| b.name).collect()
}
