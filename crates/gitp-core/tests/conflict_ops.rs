//! Merge/rebase conflict resolution: detect an in-progress conflict, read the
//! three sides of a conflicted file, mark files resolved, and finish or abort.

mod common;

use std::path::Path;
use std::process::Command;

use common::FixtureRepo;
use gitp_core::Repo;

/// Run `git <args>` in `dir`, asserting success (test setup helper).
fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
}

/// Build a repo whose `dev` and `theirs` branches both changed the middle line
/// of `f.txt`, then start merging `theirs` into `dev` so a conflict is live.
fn conflicted_repo() -> FixtureRepo {
    let fx = FixtureRepo::init();
    fx.commit_file("f.txt", "a\nbase\nc\n", "c1");
    let dir = fx.path();
    // Name the current branch deterministically regardless of init.defaultBranch.
    git(dir, &["branch", "-M", "dev"]);
    git(dir, &["checkout", "-b", "theirs"]);
    std::fs::write(dir.join("f.txt"), "a\ntheirs\nc\n").unwrap();
    git(dir, &["commit", "-am", "theirs change"]);
    git(dir, &["checkout", "dev"]);
    std::fs::write(dir.join("f.txt"), "a\nours\nc\n").unwrap();
    git(dir, &["commit", "-am", "ours change"]);
    // Start the merge — it conflicts and leaves the merge in progress.
    let repo = Repo::open(dir).unwrap();
    assert!(repo.merge_branch("theirs").is_err(), "merge should conflict");
    fx
}

#[test]
fn conflict_status_reports_a_merge_in_progress_with_the_conflicted_file() {
    let fx = conflicted_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let status = repo.conflict_status().unwrap();
    assert_eq!(status.kind, "merge");
    assert_eq!(status.conflicted, vec!["f.txt"]);
    assert!(!status.message.is_empty(), "a default merge message is available");
}

#[test]
fn conflict_sides_reads_ours_theirs_and_working_versions() {
    let fx = conflicted_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let sides = repo.conflict_sides("f.txt").unwrap();
    assert!(sides.ours.as_deref().unwrap().contains("ours"), "ours side is HEAD's version");
    assert!(sides.theirs.as_deref().unwrap().contains("theirs"), "theirs side is the incoming version");
    assert!(sides.working.contains("<<<<<<<") && sides.working.contains(">>>>>>>"), "working file has markers");
    assert!(!sides.binary);
}

#[test]
fn resolve_conflict_clears_the_file_and_finish_commits_the_merge() {
    let fx = conflicted_repo();
    let repo = Repo::open(fx.path()).unwrap();

    repo.resolve_conflict("f.txt", "a\nresolved\nc\n").unwrap();
    assert!(repo.conflict_status().unwrap().conflicted.is_empty(), "no conflicts left after resolve");

    repo.finish_conflict("Merge theirs into dev").unwrap();

    // Merge is done: no conflict session, and the merge commit is HEAD.
    assert_eq!(repo.conflict_status().unwrap().kind, "none");
    assert_eq!(std::fs::read_to_string(fx.path().join("f.txt")).unwrap(), "a\nresolved\nc\n");
    let head = repo.commit_detail("HEAD").unwrap();
    assert_eq!(head.parents.len(), 2, "a two-parent merge commit was created");
}

#[test]
fn abort_conflict_restores_the_pre_merge_state() {
    let fx = conflicted_repo();
    let repo = Repo::open(fx.path()).unwrap();

    repo.abort_conflict().unwrap();

    assert_eq!(repo.conflict_status().unwrap().kind, "none");
    assert_eq!(std::fs::read_to_string(fx.path().join("f.txt")).unwrap(), "a\nours\nc\n", "back to ours");
}

#[test]
fn conflict_status_is_none_on_a_clean_repo() {
    let fx = FixtureRepo::init();
    fx.commit_file("f.txt", "hi\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    assert_eq!(repo.conflict_status().unwrap().kind, "none");
}
