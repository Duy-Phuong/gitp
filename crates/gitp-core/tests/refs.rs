//! Ref listing and working-tree status.

mod common;

use common::FixtureRepo;
use gitp_core::Repo;

#[test]
fn refs_lists_local_branches_head_and_tags() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "hello\n", "first");
    let head = fx.repo.head().unwrap().peel_to_commit().unwrap();
    fx.repo.branch("feature/widget", &head, false).unwrap();
    fx.repo
        .tag_lightweight("v1.0", head.as_object(), false)
        .unwrap();

    let repo = Repo::open(fx.path()).unwrap();
    let refs = repo.refs().unwrap();

    let names: Vec<&str> = refs.branches.iter().map(|b| b.name.as_str()).collect();
    assert!(names.contains(&"feature/widget"), "grouped branch listed");
    assert!(refs.head.is_some(), "HEAD is on a branch");
    assert!(
        refs.branches.iter().any(|b| b.is_head),
        "exactly the checked-out branch is flagged"
    );
    assert!(refs.tags.iter().any(|t| t.name == "v1.0"), "tag listed");
    assert!(
        refs.tags.iter().find(|t| t.name == "v1.0").is_some_and(|t| !t.target.is_empty()),
        "tag resolves to a commit oid"
    );
}

#[test]
fn recent_lists_branches_by_last_switch_newest_first_excluding_head() {
    use std::process::Command;
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "1\n", "base");
    let run = |args: &[&str]| {
        let out = Command::new("git").current_dir(fx.path()).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    // Create three branches and switch between them; the reflog records each.
    run(&["branch", "one"]);
    run(&["branch", "two"]);
    run(&["branch", "three"]);
    run(&["checkout", "one"]);
    run(&["checkout", "two"]);
    run(&["checkout", "three"]);
    run(&["checkout", "one"]); // now on "one"

    let recent = Repo::open(fx.path()).unwrap().refs().unwrap().recent;
    // Newest switches first; current branch ("one") excluded; deduped.
    assert_eq!(recent, vec!["three".to_string(), "two".to_string()]);
}

#[test]
fn checkout_branch_updates_recent_like_the_cli() {
    // Switching via Repo::checkout_branch (what the GUI calls) must record the
    // HEAD reflog the same way `git checkout` does, so Recent reflects it.
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "1\n", "base");
    let base = fx.repo.head().unwrap().peel_to_commit().unwrap();
    fx.repo.branch("feature", &base, false).unwrap();

    let repo = Repo::open(fx.path()).unwrap();
    let start = repo.refs().unwrap().head.unwrap(); // the base branch
    repo.checkout_branch("feature").unwrap();
    repo.checkout_branch(&start).unwrap(); // back to base; "feature" is now recent

    let recent = repo.refs().unwrap().recent;
    assert_eq!(recent, vec!["feature".to_string()], "GUI checkout feeds Recent: {recent:?}");
}

#[test]
fn checkout_remote_creates_a_local_tracking_branch() {
    use std::process::Command;
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "1\n", "base");
    let run = |args: &[&str]| {
        let out = Command::new("git").current_dir(fx.path()).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };

    // A bare remote holding an extra branch that has no local counterpart.
    let remote = tempfile::TempDir::new().unwrap();
    Command::new("git").args(["init", "-q", "--bare", remote.path().to_str().unwrap()]).status().unwrap();
    run(&["remote", "add", "origin", remote.path().to_str().unwrap()]);
    run(&["branch", "feature/x"]);
    run(&["push", "-q", "origin", "--all"]);
    run(&["branch", "-D", "feature/x"]); // drop the local; only origin/feature/x remains
    run(&["fetch", "-q", "origin"]);

    let repo = Repo::open(fx.path()).unwrap();
    assert!(
        !repo.refs().unwrap().branches.iter().any(|b| b.name == "feature/x"),
        "no local branch yet"
    );

    repo.checkout_remote("origin/feature/x").unwrap();

    let refs = repo.refs().unwrap();
    assert_eq!(refs.head.as_deref(), Some("feature/x"), "now on the new local branch");
    let b = refs.branches.iter().find(|b| b.name == "feature/x").expect("local branch created");
    assert!(b.has_upstream, "local branch tracks the remote");
}

#[test]
fn recent_drops_branches_that_no_longer_exist() {
    use std::process::Command;
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "1\n", "base");
    let run = |args: &[&str]| {
        Command::new("git").current_dir(fx.path()).args(args).output().unwrap();
    };
    run(&["branch", "temp"]);
    run(&["checkout", "temp"]);
    run(&["checkout", "-"]); // back to the base branch
    run(&["branch", "-D", "temp"]); // delete the branch we visited

    let recent = Repo::open(fx.path()).unwrap().refs().unwrap().recent;
    assert!(!recent.contains(&"temp".to_string()), "deleted branch is filtered out");
}

#[test]
fn working_changes_reports_modified_and_untracked_files() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "hello\n", "first");
    // Edit a tracked file and add an untracked one — both are "local changes".
    std::fs::write(fx.path().join("a.txt"), "hello world\n").unwrap();
    std::fs::write(fx.path().join("b.txt"), "brand new\n").unwrap();

    let repo = Repo::open(fx.path()).unwrap();
    assert_eq!(
        repo.local_change_count().unwrap(),
        2,
        "one modified + one untracked"
    );

    let files = repo.working_changes().unwrap();
    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    assert!(paths.contains(&"a.txt"), "modified file present");
    assert!(paths.contains(&"b.txt"), "untracked file present");

    // The new file reports as Untracked (not the catch-all Other).
    let b = files.iter().find(|f| f.path == "b.txt").unwrap();
    assert_eq!(b.status, gitp_core::ChangeKind::Untracked);
}

#[test]
fn checkout_is_blocked_when_local_changes_would_be_overwritten() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let c1 = fx.repo.head().unwrap().peel_to_commit().unwrap();
    fx.repo.branch("other", &c1, false).unwrap();
    fx.commit_file("a.txt", "two\n", "c2"); // master diverges from `other`

    // An uncommitted edit that conflicts with switching to `other`.
    std::fs::write(fx.path().join("a.txt"), "precious edits\n").unwrap();

    let repo = Repo::open(fx.path()).unwrap();
    let err = repo.checkout_branch("other").unwrap_err().to_string();
    assert!(err.contains("Can't switch"), "actionable message, got: {err}");

    // Blocked cleanly: HEAD didn't move and the edit is intact (no data loss).
    assert_eq!(repo.refs().unwrap().head.as_deref(), Some("master"), "still on master");
    assert_eq!(
        std::fs::read_to_string(fx.path().join("a.txt")).unwrap(),
        "precious edits\n",
        "local changes preserved"
    );
}

#[test]
fn checkout_branch_moves_head_and_updates_the_worktree() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let c1 = fx.repo.head().unwrap().peel_to_commit().unwrap();
    fx.repo.branch("other", &c1, false).unwrap();
    fx.commit_file("a.txt", "two\n", "c2"); // current branch advances past `other`

    let repo = Repo::open(fx.path()).unwrap();
    repo.checkout_branch("other").unwrap();

    assert_eq!(repo.refs().unwrap().head.as_deref(), Some("other"), "HEAD on other");
    assert_eq!(
        std::fs::read_to_string(fx.path().join("a.txt")).unwrap(),
        "one\n",
        "working tree reflects the checked-out branch"
    );
}
