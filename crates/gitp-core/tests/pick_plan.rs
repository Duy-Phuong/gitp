//! Interactive multi-commit cherry-pick: running an edited plan onto HEAD,
//! and pausing / resuming it around a conflict.

mod common;

use common::FixtureRepo;
use gitp_core::{PickAction, PickStep, Repo};

fn step(sha: git2::Oid, action: PickAction, message: Option<&str>) -> PickStep {
    PickStep {
        sha: sha.to_string(),
        action,
        message: message.map(str::to_string),
    }
}

/// `base` on the default branch, then `side` branching off it; returns the
/// fixture, the default branch name, and leaves `side` checked out.
fn repo_with_side() -> (FixtureRepo, Repo, String) {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "base\n", "base");
    {
        let base = fx.repo.head().unwrap().peel_to_commit().unwrap();
        fx.repo.branch("side", &base, false).unwrap();
    }
    let repo = Repo::open(fx.path()).unwrap();
    let main = repo.refs().unwrap().head.expect("on a branch");
    repo.checkout_branch("side").unwrap();
    (fx, repo, main)
}

/// HEAD's message and those of its ancestors, newest first, trimmed.
fn messages(fx: &FixtureRepo) -> Vec<String> {
    let mut walk = fx.repo.revwalk().unwrap();
    walk.push_head().unwrap();
    walk.map(|oid| {
        let c = fx.repo.find_commit(oid.unwrap()).unwrap();
        c.message().unwrap().trim().to_string()
    })
    .collect()
}

#[test]
fn plan_reorders_picks_rewords_squashes_and_drops() {
    let (fx, repo, main) = repo_with_side();
    let s1 = fx.commit_file("f1.txt", "1\n", "s1");
    let s2 = fx.commit_file("f2.txt", "2\n", "s2");
    let s3 = fx.commit_file("f3.txt", "3\n", "s3");
    let s4 = fx.commit_file("f4.txt", "4\n", "s4");
    repo.checkout_branch(&main).unwrap();
    let start = repo.head_commit_id().unwrap();

    let out = repo
        .cherry_pick_plan(&[
            step(s3, PickAction::Pick, None),
            step(s1, PickAction::Reword, Some("s1 reworded")),
            step(s2, PickAction::Squash, None),
            step(s4, PickAction::Drop, None),
        ])
        .unwrap();

    assert!(!out.paused);
    assert_eq!(out.start_head, start);
    assert_eq!(messages(&fx), vec!["s1 reworded\n\ns2", "s3", "base"]);
    for kept in ["f1.txt", "f2.txt", "f3.txt"] {
        assert!(fx.path().join(kept).exists(), "{kept} applied");
    }
    assert!(!fx.path().join("f4.txt").exists(), "dropped commit not applied");
    assert_eq!(repo.refs().unwrap().head.as_deref(), Some(main.as_str()));
}

#[test]
fn a_conflict_pauses_the_plan_and_continue_finishes_it() {
    let (fx, repo, main) = repo_with_side();
    let c1 = fx.commit_file("f1.txt", "1\n", "c1");
    let c2 = fx.commit_file("a.txt", "side\n", "c2");
    let c3 = fx.commit_file("f3.txt", "3\n", "c3");
    repo.checkout_branch(&main).unwrap();
    // The checkout ran through git; reload the fixture's cached index first.
    fx.repo.index().unwrap().read(true).unwrap();
    fx.commit_file("a.txt", "main\n", "main change");
    let start = repo.head_commit_id().unwrap();

    let out = repo
        .cherry_pick_plan(&[
            step(c1, PickAction::Pick, None),
            step(c2, PickAction::Reword, Some("c2 reworded")),
            step(c3, PickAction::Squash, None),
        ])
        .unwrap();
    assert!(out.paused, "stopped on c2's conflict");
    assert!(fx.repo.path().join("CHERRY_PICK_HEAD").exists());
    assert!(!fx.path().join("f3.txt").exists(), "c3 not applied yet");
    // Continuing before the conflict is committed is refused.
    assert!(repo.continue_cherry_pick_plan().is_err());

    // Resolve and finish the cherry-pick the way the resolver does.
    repo.resolve_conflict("a.txt", "resolved\n").unwrap();
    repo.finish_conflict("").unwrap();

    let out = repo.continue_cherry_pick_plan().unwrap();
    assert!(!out.paused);
    assert_eq!(out.start_head, start, "the whole run undoes to the start");
    assert_eq!(
        messages(&fx),
        vec!["c2 reworded\n\nc3", "c1", "main change", "base"]
    );
    assert!(fx.path().join("f3.txt").exists());
    assert!(
        repo.continue_cherry_pick_plan().is_err(),
        "nothing left to continue"
    );
}

#[test]
fn aborting_the_conflict_cancels_the_rest_of_the_plan() {
    let (fx, repo, main) = repo_with_side();
    let c1 = fx.commit_file("a.txt", "side\n", "c1");
    let c2 = fx.commit_file("f2.txt", "2\n", "c2");
    repo.checkout_branch(&main).unwrap();
    // The checkout ran through git; reload the fixture's cached index first.
    fx.repo.index().unwrap().read(true).unwrap();
    fx.commit_file("a.txt", "main\n", "main change");

    let out = repo
        .cherry_pick_plan(&[step(c1, PickAction::Pick, None), step(c2, PickAction::Pick, None)])
        .unwrap();
    assert!(out.paused);
    repo.abort_conflict().unwrap();

    let err = repo.continue_cherry_pick_plan().unwrap_err().to_string();
    assert!(err.contains("cancelled"), "{err}");
    assert!(!fx.path().join("f2.txt").exists(), "c2 never applied");
    assert_eq!(messages(&fx), vec!["main change", "base"]);
}

#[test]
fn a_plan_starting_with_a_squash_or_with_an_option_is_refused() {
    let (fx, repo, main) = repo_with_side();
    let c1 = fx.commit_file("f1.txt", "1\n", "c1");
    let c2 = fx.commit_file("f2.txt", "2\n", "c2");
    repo.checkout_branch(&main).unwrap();

    assert!(repo
        .cherry_pick_plan(&[step(c1, PickAction::Drop, None), step(c2, PickAction::Squash, None)])
        .is_err());
    let err = repo
        .cherry_pick_plan(&[PickStep {
            sha: "--exec=touch pwned".into(),
            action: PickAction::Pick,
            message: None,
        }])
        .unwrap_err()
        .to_string();
    assert!(err.contains("read as an option"), "{err}");
    assert_eq!(messages(&fx), vec!["base"], "nothing applied");
}
