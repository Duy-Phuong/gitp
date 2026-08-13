//! Pull, push, and branch creation. Pull/push shell out to `git`, so these
//! tests wire real repos together through a bare "remote" on disk — no network.

mod common;

use std::path::Path;
use std::process::Command;

use common::FixtureRepo;
use gitp_core::Repo;
use tempfile::TempDir;

/// Run `git <args>` in `dir`, asserting success.
fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(dir)
        .args(args)
        .status()
        .expect("run git");
    assert!(status.success(), "git {args:?} failed in {dir:?}");
}

/// `git init -b main` with a deterministic identity, ready to commit.
fn init_repo(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Tester"]);
    git(dir, &["config", "user.email", "t@t.io"]);
}

#[test]
fn push_sets_upstream_on_first_push_and_uploads_commits() {
    let remote = TempDir::new().unwrap();
    git(remote.path(), &["init", "-q", "--bare"]);

    let work = TempDir::new().unwrap();
    init_repo(work.path());
    git(work.path(), &["remote", "add", "origin", remote.path().to_str().unwrap()]);
    std::fs::write(work.path().join("a.txt"), "hi\n").unwrap();
    git(work.path(), &["add", "."]);
    git(work.path(), &["commit", "-q", "-m", "c1"]);

    // The branch has no upstream yet; push() must set it and still succeed.
    let repo = Repo::open(work.path()).unwrap();
    repo.push().expect("first push sets upstream and uploads");

    let log = Command::new("git")
        .current_dir(remote.path())
        .args(["log", "--oneline", "--all"])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&log.stdout).contains("c1"),
        "the remote received the pushed commit"
    );
}

#[test]
fn pull_brings_new_commits_from_the_remote() {
    let remote = TempDir::new().unwrap();
    git(remote.path(), &["init", "-q", "--bare"]);

    // Seed the remote with an initial commit.
    let seed = TempDir::new().unwrap();
    init_repo(seed.path());
    git(seed.path(), &["remote", "add", "origin", remote.path().to_str().unwrap()]);
    std::fs::write(seed.path().join("a.txt"), "one\n").unwrap();
    git(seed.path(), &["add", "."]);
    git(seed.path(), &["commit", "-q", "-m", "c1"]);
    git(seed.path(), &["push", "-q", "-u", "origin", "main"]);

    // A second clone that will pull the seed's next commit.
    let consumer = TempDir::new().unwrap();
    git(
        Path::new("."),
        &["clone", "-q", remote.path().to_str().unwrap(), consumer.path().to_str().unwrap()],
    );

    // The seed adds a new commit and pushes it.
    std::fs::write(seed.path().join("b.txt"), "two\n").unwrap();
    git(seed.path(), &["add", "."]);
    git(seed.path(), &["commit", "-q", "-m", "c2"]);
    git(seed.path(), &["push", "-q"]);

    // The consumer pulls it down.
    let repo = Repo::open(consumer.path()).unwrap();
    repo.pull().expect("pull fast-forwards the new commit");

    assert!(
        consumer.path().join("b.txt").exists(),
        "pulled commit's file is now in the working tree"
    );
}

#[test]
fn create_branch_makes_a_branch_at_head_and_checks_it_out() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "x\n", "c1");

    let repo = Repo::open(fx.path()).unwrap();
    repo.create_branch("feature/new").unwrap();

    assert_eq!(
        repo.refs().unwrap().head.as_deref(),
        Some("feature/new"),
        "HEAD is on the newly created branch"
    );
}
