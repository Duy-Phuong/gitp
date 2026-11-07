//! The default branch's commits that its upstream doesn't have yet.

mod common;

use std::path::Path;
use std::process::Command;

use common::FixtureRepo;
use gitp_core::{Repo, Unpushed};

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// `main` pushed to a bare `origin` and tracking it.
fn pushed_main() -> (FixtureRepo, tempfile::TempDir) {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "1\n", "one");
    git(fx.path(), &["branch", "-M", "main"]);
    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "-q", "--bare"]);
    git(
        fx.path(),
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    );
    git(fx.path(), &["push", "-q", "-u", "origin", "main"]);
    (fx, remote)
}

#[test]
fn a_default_branch_level_with_its_upstream_has_nothing_unpushed() {
    let (fx, _remote) = pushed_main();
    let repo = Repo::open(fx.path()).unwrap();
    assert_eq!(repo.default_branch_name().as_deref(), Some("main"));
    assert_eq!(repo.unpushed_default().unwrap(), None);
}

#[test]
fn commits_made_on_the_default_branch_and_not_pushed_are_counted() {
    let (fx, _remote) = pushed_main();
    fx.commit_file("b.txt", "2\n", "two");
    fx.commit_file("c.txt", "3\n", "three");
    let repo = Repo::open(fx.path()).unwrap();
    assert_eq!(
        repo.unpushed_default().unwrap(),
        Some(Unpushed {
            branch: "main".into(),
            ahead: 2
        })
    );
}

#[test]
fn a_default_branch_without_an_upstream_is_not_reported() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "1\n", "one");
    git(fx.path(), &["branch", "-M", "main"]);
    let repo = Repo::open(fx.path()).unwrap();
    assert_eq!(repo.unpushed_default().unwrap(), None);
}
