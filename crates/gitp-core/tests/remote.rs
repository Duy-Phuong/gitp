//! Pull, push, and branch creation. Pull/push shell out to `git`, so these
//! tests wire real repos together through a bare "remote" on disk — no network.

mod common;

use std::path::Path;
use std::process::Command;

use common::FixtureRepo;
use gitp_core::{PullMode, Repo};
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
///
/// Every repo in this file — bare remotes included — names its initial branch
/// explicitly. Left to `init.defaultBranch`, the pairing depends on whoever's
/// machine is running the tests: a bare remote defaulting to `master` against a
/// work repo on `main` fails with "no such ref was fetched".
fn init_repo(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Tester"]);
    git(dir, &["config", "user.email", "t@t.io"]);
}

#[test]
fn push_sets_upstream_on_first_push_and_uploads_commits() {
    let remote = TempDir::new().unwrap();
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);

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
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);

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
    repo.pull(PullMode::FastForward).expect("pull fast-forwards the new commit");

    assert!(
        consumer.path().join("b.txt").exists(),
        "pulled commit's file is now in the working tree"
    );
}

#[test]
fn plain_push_is_rejected_when_the_remote_has_commits_this_branch_lacks() {
    let remote = TempDir::new().unwrap();
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);

    let seed = TempDir::new().unwrap();
    init_repo(seed.path());
    git(seed.path(), &["remote", "add", "origin", remote.path().to_str().unwrap()]);
    std::fs::write(seed.path().join("a.txt"), "one\n").unwrap();
    git(seed.path(), &["add", "."]);
    git(seed.path(), &["commit", "-q", "-m", "c1"]);
    git(seed.path(), &["push", "-q", "-u", "origin", "main"]);

    // A second clone pushes a commit the first clone hasn't seen.
    let other = TempDir::new().unwrap();
    git(Path::new("."), &["clone", "-q", remote.path().to_str().unwrap(), other.path().to_str().unwrap()]);
    git(other.path(), &["config", "user.name", "Other"]);
    git(other.path(), &["config", "user.email", "o@o.io"]);
    std::fs::write(other.path().join("b.txt"), "two\n").unwrap();
    git(other.path(), &["add", "."]);
    git(other.path(), &["commit", "-q", "-m", "c2"]);
    git(other.path(), &["push", "-q"]);

    // The first clone, now behind, commits locally and tries a plain push.
    std::fs::write(seed.path().join("c.txt"), "three\n").unwrap();
    git(seed.path(), &["add", "."]);
    git(seed.path(), &["commit", "-q", "-m", "c3"]);

    let repo = Repo::open(seed.path()).unwrap();
    let err = repo.push().expect_err("a diverged remote must reject a plain push");
    let msg = err.to_string();
    assert!(msg.contains("[rejected]"), "expected a [rejected] marker, got: {msg}");
    assert!(
        msg.contains("fetch first") || msg.contains("non-fast-forward"),
        "expected the standard non-fast-forward wording, got: {msg}"
    );
}

#[test]
fn push_force_overwrites_a_diverged_remote_branch() {
    let remote = TempDir::new().unwrap();
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);

    let seed = TempDir::new().unwrap();
    init_repo(seed.path());
    git(seed.path(), &["remote", "add", "origin", remote.path().to_str().unwrap()]);
    std::fs::write(seed.path().join("a.txt"), "one\n").unwrap();
    git(seed.path(), &["add", "."]);
    git(seed.path(), &["commit", "-q", "-m", "c1"]);
    git(seed.path(), &["push", "-q", "-u", "origin", "main"]);

    // Another clone pushes a commit the first clone never fetches — so its
    // remote-tracking ref (origin/main) is stale, the exact condition that
    // makes a naive --force-with-lease refuse with "(stale info)".
    let other = TempDir::new().unwrap();
    git(Path::new("."), &["clone", "-q", remote.path().to_str().unwrap(), other.path().to_str().unwrap()]);
    git(other.path(), &["config", "user.name", "Other"]);
    git(other.path(), &["config", "user.email", "o@o.io"]);
    std::fs::write(other.path().join("b.txt"), "two\n").unwrap();
    git(other.path(), &["add", "."]);
    git(other.path(), &["commit", "-q", "-m", "c2"]);
    git(other.path(), &["push", "-q"]);

    std::fs::write(seed.path().join("c.txt"), "three\n").unwrap();
    git(seed.path(), &["add", "."]);
    git(seed.path(), &["commit", "-q", "-m", "c3"]);

    let repo = Repo::open(seed.path()).unwrap();
    repo.push_force().expect("push_force fetches first, so the lease is fresh");

    let log = Command::new("git")
        .current_dir(remote.path())
        .args(["log", "--oneline", "main"])
        .output()
        .unwrap();
    let log = String::from_utf8_lossy(&log.stdout);
    assert!(log.contains("c3"), "the forced commit landed on the remote");
    assert!(!log.contains("c2"), "the other clone's commit was overwritten, not merged");
}

#[test]
fn stash_saves_changes_including_untracked_and_pop_restores_them() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    std::fs::write(fx.path().join("a.txt"), "two\n").unwrap(); // modify tracked
    std::fs::write(fx.path().join("new.txt"), "brand new\n").unwrap(); // untracked

    let repo = Repo::open(fx.path()).unwrap();
    assert_eq!(repo.local_change_count().unwrap(), 2, "one modified + one untracked");

    repo.stash().expect("stash saves tracked and untracked changes");
    assert_eq!(
        std::fs::read_to_string(fx.path().join("a.txt")).unwrap(),
        "one\n",
        "tracked file reverted to HEAD after stash"
    );
    assert!(
        !fx.path().join("new.txt").exists(),
        "untracked file is swept away by stash --include-untracked"
    );
    assert_eq!(repo.local_change_count().unwrap(), 0, "clean tree after stash");

    repo.stash_pop().expect("pop restores everything");
    assert_eq!(std::fs::read_to_string(fx.path().join("a.txt")).unwrap(), "two\n");
    assert!(fx.path().join("new.txt").exists(), "untracked file restored after pop");
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

/// Clean up (Quick Launch) deletes local branches whose remote counterpart is
/// gone. It must find exactly those: not branches that were never pushed, not
/// ones still present upstream, and never the branch you're standing on.
#[test]
fn gone_branches_lists_only_branches_whose_upstream_disappeared() {
    let remote = TempDir::new().unwrap();
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);

    let work = TempDir::new().unwrap();
    init_repo(work.path());
    git(work.path(), &["remote", "add", "origin", remote.path().to_str().unwrap()]);
    std::fs::write(work.path().join("a.txt"), "hi\n").unwrap();
    git(work.path(), &["add", "."]);
    git(work.path(), &["commit", "-q", "-m", "c1"]);
    git(work.path(), &["push", "-q", "-u", "origin", "main"]);

    // `merged`: pushed, then deleted upstream — exactly what Clean up targets.
    git(work.path(), &["checkout", "-q", "-b", "merged"]);
    git(work.path(), &["push", "-q", "-u", "origin", "merged"]);
    git(work.path(), &["push", "-q", "origin", "--delete", "merged"]);
    // `local-only`: never pushed, so it has no upstream to be gone.
    git(work.path(), &["checkout", "-q", "-b", "local-only", "main"]);
    // `in-sync`: still present upstream.
    git(work.path(), &["checkout", "-q", "-b", "in-sync", "main"]);
    git(work.path(), &["push", "-q", "-u", "origin", "in-sync"]);

    let repo = Repo::open(work.path()).unwrap();
    repo.fetch_all().unwrap(); // prunes the deleted remote-tracking ref

    assert_eq!(
        repo.gone_branches().unwrap(),
        vec!["merged".to_string()],
        "only the branch whose upstream was deleted"
    );

    // Standing on the gone branch must not offer to delete it out from under us.
    git(work.path(), &["checkout", "-q", "merged"]);
    assert_eq!(
        repo.gone_branches().unwrap(),
        Vec::<String>::new(),
        "the checked-out branch is excluded"
    );
}
