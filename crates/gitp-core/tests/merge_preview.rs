//! The merge dry-run: which files a merge would conflict on, without merging.

mod common;

use common::FixtureRepo;
use gitp_core::Repo;

/// `base` and `other` both change `shared.txt` from the same start; `other`
/// alone adds `only-other.txt`.
fn diverged() -> (FixtureRepo, String) {
    let fx = FixtureRepo::init();
    fx.commit_file("shared.txt", "start\n", "c1");
    fx.commit_file("keep.txt", "k\n", "c2");
    let repo = Repo::open(fx.path()).unwrap();
    let base = repo.refs().unwrap().head.unwrap();

    repo.create_branch_here("other").unwrap();
    repo.checkout_branch("other").unwrap();
    fx.commit_file("shared.txt", "theirs\n", "c3");
    fx.commit_file("only-other.txt", "o\n", "c4");

    repo.checkout_branch(&base).unwrap();
    fx.commit_file("shared.txt", "ours\n", "c5");
    (fx, base)
}

#[test]
fn names_the_files_that_would_conflict_and_changes_nothing() {
    let (fx, base) = diverged();
    let repo = Repo::open(fx.path()).unwrap();
    let head_before = fx.repo.head().unwrap().target().unwrap();
    let status = || {
        let out = std::process::Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(fx.path())
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    };
    let status_before = status();

    let preview = repo.merge_preview(&base, "other").unwrap();
    assert!(!preview.clean);
    assert_eq!(preview.conflicts, vec!["shared.txt"]);

    // Nothing moved, nothing staged or changed, no merge in progress.
    assert_eq!(fx.repo.head().unwrap().target().unwrap(), head_before);
    assert!(!fx.path().join(".git/MERGE_HEAD").exists());
    assert_eq!(status(), status_before);
    assert_eq!(
        std::fs::read_to_string(fx.path().join("shared.txt")).unwrap(),
        "ours\n"
    );
}

#[test]
fn a_branch_that_touches_other_files_merges_cleanly() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    let base = repo.refs().unwrap().head.unwrap();
    repo.create_branch_here("side").unwrap();
    repo.checkout_branch("side").unwrap();
    fx.commit_file("b.txt", "b\n", "c2");
    repo.checkout_branch(&base).unwrap();
    fx.commit_file("a.txt", "a2\n", "c3");

    let preview = repo.merge_preview(&base, "side").unwrap();
    assert_eq!(
        preview,
        gitp_core::MergePreview {
            clean: true,
            conflicts: vec![]
        }
    );
}

#[test]
fn an_unknown_revision_is_an_error_not_a_verdict() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    assert!(repo.merge_preview("HEAD", "no-such-branch").is_err());
    assert!(repo.merge_preview("HEAD", "--exec=true").is_err());
}
