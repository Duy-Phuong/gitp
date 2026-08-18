//! Interactive rebase: listing the plan and running an edited one.

mod common;

use common::FixtureRepo;
use gitp_core::{RebaseAction, RebaseStep, Repo};

fn step(sha: &str, action: RebaseAction, message: Option<&str>) -> RebaseStep {
    RebaseStep { sha: sha.to_string(), action, message: message.map(str::to_string) }
}

fn subjects(repo: &Repo) -> Vec<String> {
    // Newest-first log subjects on the current branch.
    repo.log(Default::default()).unwrap().into_iter().map(|c| c.summary).collect()
}

#[test]
fn rebase_todo_lists_commits_ahead_of_the_target_oldest_first() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "1\n", "base");
    let base = fx.repo.head().unwrap().peel_to_commit().unwrap();
    fx.repo.branch("target", &base, false).unwrap();
    fx.commit_file("a.txt", "2\n", "c1");
    fx.commit_file("a.txt", "3\n", "c2");

    let repo = Repo::open(fx.path()).unwrap();
    let todo = repo.rebase_todo("target").unwrap();
    let subs: Vec<&str> = todo.iter().map(|c| c.subject.as_str()).collect();
    assert_eq!(subs, vec!["c1", "c2"], "commits ahead of target, oldest first");
}

#[test]
fn interactive_rebase_reorders_squashes_rewords_and_drops() {
    let fx = FixtureRepo::init();
    fx.commit_file("base.txt", "b\n", "base");
    let base = fx.repo.head().unwrap().peel_to_commit().unwrap();
    fx.repo.branch("target", &base, false).unwrap();
    // Four commits on top of base (each a distinct file so nothing conflicts).
    fx.commit_file("f1.txt", "1\n", "c1");
    fx.commit_file("f2.txt", "2\n", "c2");
    fx.commit_file("f3.txt", "3\n", "c3");
    fx.commit_file("f4.txt", "4\n", "c4");

    let repo = Repo::open(fx.path()).unwrap();
    let todo = repo.rebase_todo("target").unwrap(); // [c1, c2, c3, c4]
    let by = |s: &str| todo.iter().find(|c| c.subject == s).unwrap().sha.clone();

    // Plan: keep c1; reword c2 -> "c2 reworded"; squash c3 into c2; drop c4.
    let steps = vec![
        step(&by("c1"), RebaseAction::Pick, None),
        step(&by("c2"), RebaseAction::Reword, Some("c2 reworded")),
        step(&by("c3"), RebaseAction::Squash, None),
        step(&by("c4"), RebaseAction::Drop, None),
    ];
    repo.interactive_rebase("target", &steps).unwrap();

    let subs = subjects(&repo);
    assert!(subs.contains(&"c1".to_string()), "c1 kept");
    assert!(subs.contains(&"c2 reworded".to_string()), "c2 reworded");
    assert!(!subs.contains(&"c2".to_string()), "old c2 subject gone");
    assert!(!subs.contains(&"c3".to_string()), "c3 squashed away (message dropped)");
    assert!(!subs.contains(&"c4".to_string()), "c4 dropped");
    // c3's change survives (squashed into c2), c4's does not (dropped).
    assert!(fx.path().join("f3.txt").exists(), "squashed change kept");
    assert!(!fx.path().join("f4.txt").exists(), "dropped change removed");
}

#[test]
fn interactive_rebase_rejects_a_leading_squash() {
    let fx = FixtureRepo::init();
    fx.commit_file("base.txt", "b\n", "base");
    let base = fx.repo.head().unwrap().peel_to_commit().unwrap();
    fx.repo.branch("target", &base, false).unwrap();
    fx.commit_file("f1.txt", "1\n", "c1");

    let repo = Repo::open(fx.path()).unwrap();
    let sha = repo.rebase_todo("target").unwrap()[0].sha.clone();
    let err = repo
        .interactive_rebase("target", &[step(&sha, RebaseAction::Squash, None)])
        .unwrap_err()
        .to_string();
    assert!(err.contains("first commit"), "clear guard message: {err}");
}
