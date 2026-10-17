//! Guided `git bisect`: start, mark good / bad / skip, read the session back
//! from `.git`, and reset.

mod common;

use std::path::Path;
use std::process::Command;

use common::FixtureRepo;
use gitp_core::{BisectMark, Repo};

/// The commit (1-based) that introduces the "bug".
const FIRST_BAD: usize = 11;

/// A linear history of 16 commits, `c1`..`c16`. Each rewrites `n.txt`, and from
/// `c11` on `state.txt` reads "bug". Returns the ids oldest first.
fn buggy_history(fx: &FixtureRepo) -> Vec<String> {
    (1..=16)
        .map(|i| {
            let state = if i >= FIRST_BAD { "bug\n" } else { "ok\n" };
            std::fs::write(fx.path().join("state.txt"), state).unwrap();
            let mut index = fx.repo.index().unwrap();
            index.add_path(Path::new("state.txt")).unwrap();
            index.write().unwrap();
            fx.commit_file("n.txt", &format!("{i}\n"), &format!("c{i}"))
                .to_string()
        })
        .collect()
}

/// What a test run at the checked-out commit would say.
fn is_buggy(fx: &FixtureRepo) -> bool {
    std::fs::read_to_string(fx.path().join("state.txt")).unwrap() == "bug\n"
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(out.status.success(), "git {args:?} failed");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn status_is_none_when_no_bisect_is_running() {
    let fx = FixtureRepo::init();
    buggy_history(&fx);
    let repo = Repo::open(fx.path()).unwrap();
    assert!(repo.bisect_status().unwrap().is_none());
    assert!(!repo.operation_in_progress());
}

#[test]
fn marking_through_the_session_finds_the_first_bad_commit() {
    let fx = FixtureRepo::init();
    let ids = buggy_history(&fx);
    let repo = Repo::open(fx.path()).unwrap();
    let branch = repo.head_ref_name().unwrap();

    repo.bisect_start(Some("HEAD"), &[ids[0].clone()]).unwrap();
    let st = repo.bisect_status().unwrap().expect("bisecting");
    assert_eq!(st.bad.as_deref(), Some(ids[15].as_str()));
    assert_eq!(st.good, vec![ids[0].clone()]);
    assert_eq!(st.original_ref, branch);
    assert_eq!(st.current, repo.head_commit_id().unwrap());
    // The same numbers git printed: 7 revisions left after this, ~3 steps.
    assert_eq!(st.remaining_estimate, Some((7, 3)));
    assert!(st.first_bad.is_none());
    // Undo must leave a bisect session alone, like a merge or rebase.
    assert!(repo.operation_in_progress());

    let mut steps = 0;
    while repo.bisect_status().unwrap().unwrap().first_bad.is_none() {
        let mark = if is_buggy(&fx) {
            BisectMark::Bad
        } else {
            BisectMark::Good
        };
        repo.bisect_mark(mark, None).unwrap();
        steps += 1;
        assert!(steps <= 5, "a 16-commit bisect takes at most 4 steps");
    }

    let st = repo.bisect_status().unwrap().unwrap();
    assert_eq!(st.first_bad.as_deref(), Some(ids[FIRST_BAD - 1].as_str()));
    assert_eq!(st.first_bad_summary.as_deref(), Some("c11"));
    assert!(st.remaining_estimate.is_none(), "nothing left to test");
}

#[test]
fn skip_records_the_commit_and_moves_on() {
    let fx = FixtureRepo::init();
    let ids = buggy_history(&fx);
    let repo = Repo::open(fx.path()).unwrap();

    repo.bisect_start(Some(&ids[15]), &[ids[0].clone()])
        .unwrap();
    let skipped = repo.bisect_status().unwrap().unwrap().current;
    repo.bisect_mark(BisectMark::Skip, None).unwrap();

    let st = repo.bisect_status().unwrap().unwrap();
    assert_eq!(st.skipped, vec![skipped.clone()]);
    assert_ne!(st.current, skipped, "git checked out another candidate");
    assert!(st.remaining_estimate.is_some());
}

#[test]
fn marking_a_named_revision_marks_that_commit() {
    let fx = FixtureRepo::init();
    let ids = buggy_history(&fx);
    let repo = Repo::open(fx.path()).unwrap();

    // Started with only the bad end: waiting for a good commit.
    repo.bisect_start(Some("HEAD"), &[]).unwrap();
    let st = repo.bisect_status().unwrap().expect("bisecting");
    assert!(st.good.is_empty());
    assert!(st.remaining_estimate.is_none(), "no range to bisect yet");

    repo.bisect_mark(BisectMark::Good, Some(&ids[4])).unwrap();
    let st = repo.bisect_status().unwrap().unwrap();
    assert_eq!(st.good, vec![ids[4].clone()]);
    assert!(st.remaining_estimate.is_some());
}

#[test]
fn reset_restores_the_original_branch() {
    let fx = FixtureRepo::init();
    let ids = buggy_history(&fx);
    let repo = Repo::open(fx.path()).unwrap();
    let branch = repo.head_ref_name().unwrap();

    repo.bisect_start(Some("HEAD"), &[ids[0].clone()]).unwrap();
    repo.bisect_mark(BisectMark::Good, None).unwrap();
    assert_eq!(
        repo.head_ref_name().unwrap(),
        repo.head_commit_id().unwrap(),
        "HEAD is detached mid-bisect"
    );

    repo.bisect_reset().unwrap();
    assert!(repo.bisect_status().unwrap().is_none());
    assert_eq!(repo.head_ref_name().unwrap(), branch);
    assert_eq!(repo.head_commit_id().unwrap(), ids[15]);
    assert!(!repo.operation_in_progress());
}

#[test]
fn a_bisect_started_from_the_terminal_is_read_back_from_dot_git() {
    let fx = FixtureRepo::init();
    let ids = buggy_history(&fx);
    git(fx.path(), &["bisect", "start", "HEAD", &ids[0]]);
    git(fx.path(), &["bisect", "skip"]);
    git(fx.path(), &["bisect", "good"]);

    // A fresh handle, as after an app restart: nothing was parsed from stdout.
    let repo = Repo::open(fx.path()).unwrap();
    let st = repo.bisect_status().unwrap().expect("bisecting");
    assert_eq!(st.bad.as_deref(), Some(ids[15].as_str()));
    assert_eq!(st.good.len(), 2);
    assert!(st.good.contains(&ids[0]));
    assert_eq!(st.skipped.len(), 1);
    assert_eq!(st.current, git(fx.path(), &["rev-parse", "HEAD"]));
    assert_eq!(
        st.current_summary,
        git(fx.path(), &["log", "-1", "--format=%s"])
    );
}

#[test]
fn starting_with_conflicting_local_changes_fails_like_git() {
    let fx = FixtureRepo::init();
    let ids = buggy_history(&fx);
    // state.txt differs between HEAD and the midpoint git would check out.
    std::fs::write(fx.path().join("state.txt"), "edited\n").unwrap();
    let repo = Repo::open(fx.path()).unwrap();

    let err = repo
        .bisect_start(Some("HEAD"), &[ids[0].clone()])
        .unwrap_err()
        .to_string();
    assert!(err.contains("would be overwritten"), "git's reason: {err}");
    assert!(
        repo.bisect_status().unwrap().is_none(),
        "git cleans up a bisect that couldn't start"
    );
    assert_eq!(
        std::fs::read_to_string(fx.path().join("state.txt")).unwrap(),
        "edited\n",
        "the local change is kept"
    );
}
