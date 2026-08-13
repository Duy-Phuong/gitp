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
