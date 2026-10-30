//! Managing remotes from the sidebar: list, add, set-url, rename, remove — plus
//! the operations that pick a remote rather than assuming `origin` (push to a
//! chosen remote, the pull-request URL). Remotes are bare repos on disk.

mod common;

use std::path::Path;
use std::process::Command;

use common::FixtureRepo;
use gitp_core::Repo;
use tempfile::TempDir;

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

fn bare() -> TempDir {
    let dir = TempDir::new().unwrap();
    git(dir.path(), &["init", "-q", "--bare"]);
    dir
}

fn names(repo: &Repo) -> Vec<String> {
    repo.list_remotes()
        .unwrap()
        .into_iter()
        .map(|r| r.name)
        .collect()
}

#[test]
fn add_set_url_rename_and_remove_a_remote() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    assert!(repo.list_remotes().unwrap().is_empty());

    repo.add_remote("upstream", "https://example.com/a.git")
        .unwrap();
    repo.add_remote("origin", "git@example.com:me/a.git")
        .unwrap();
    // Listed by name, with URLs, before anything was ever fetched from them.
    let remotes = repo.list_remotes().unwrap();
    assert_eq!(names(&repo), ["origin", "upstream"]);
    assert_eq!(remotes[1].url.as_deref(), Some("https://example.com/a.git"));

    repo.set_remote_url("upstream", "https://example.com/b.git")
        .unwrap();
    assert_eq!(
        repo.list_remotes().unwrap()[1].url.as_deref(),
        Some("https://example.com/b.git")
    );

    repo.rename_remote("upstream", "fork").unwrap();
    assert_eq!(names(&repo), ["fork", "origin"]);

    repo.remove_remote("fork").unwrap();
    assert_eq!(names(&repo), ["origin"]);
}

#[test]
fn remote_names_and_urls_that_read_as_options_are_refused() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    repo.add_remote("origin", "https://example.com/a.git")
        .unwrap();

    for result in [
        repo.add_remote("--mirror=fetch", "https://example.com/x.git"),
        repo.add_remote("x", "--mirror=fetch"),
        repo.set_remote_url("origin", "--push"),
        repo.rename_remote("origin", "--progress"),
        repo.remove_remote("-v"),
        repo.push_branch("master", Some("--all")),
    ] {
        let err = result.unwrap_err().to_string();
        assert!(err.contains("read as an option"), "{err}");
    }
    assert_eq!(names(&repo), ["origin"]);
}

#[test]
fn push_branch_goes_to_the_chosen_remote_or_else_the_tracked_one() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let (origin, fork) = (bare(), bare());
    let repo = Repo::open(fx.path()).unwrap();
    repo.add_remote("origin", origin.path().to_str().unwrap())
        .unwrap();
    repo.add_remote("fork", fork.path().to_str().unwrap())
        .unwrap();
    let has_master = |dir: &TempDir| {
        Command::new("git")
            .current_dir(dir.path())
            .args(["rev-parse", "--verify", "-q", "refs/heads/master"])
            .status()
            .unwrap()
            .success()
    };

    repo.push_branch("master", Some("fork")).unwrap();
    assert!(
        has_master(&fork) && !has_master(&origin),
        "only the chosen remote"
    );

    // No remote given and no upstream: origin, as before.
    repo.push_branch("master", None).unwrap();
    assert!(has_master(&origin));

    // With an upstream on `fork`, that's the default instead — and the refs
    // listing says so.
    git(fx.path(), &["fetch", "-q", "fork"]);
    git(
        fx.path(),
        &["branch", "-q", "--set-upstream-to=fork/master", "master"],
    );
    let master = repo
        .refs()
        .unwrap()
        .branches
        .into_iter()
        .find(|b| b.name == "master")
        .unwrap();
    assert_eq!(master.upstream_remote.as_deref(), Some("fork"));
}

#[test]
fn pull_request_url_uses_the_branchs_upstream_remote() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    repo.add_remote("origin", "git@github.com:me/app.git")
        .unwrap();
    repo.add_remote("company", "git@github.com:acme/app.git")
        .unwrap();

    // No upstream: origin.
    assert_eq!(
        repo.pull_request_url("master", None).unwrap(),
        "https://github.com/me/app/pull/new/master"
    );

    // Tracking company/feature-x: that remote, and the remote-side name.
    git(fx.path(), &["config", "branch.master.remote", "company"]);
    git(
        fx.path(),
        &["config", "branch.master.merge", "refs/heads/feature-x"],
    );
    assert_eq!(
        repo.pull_request_url("master", None).unwrap(),
        "https://github.com/acme/app/pull/new/feature-x"
    );
    // A remote chosen explicitly wins, still with the remote-side name.
    assert_eq!(
        repo.pull_request_url("master", Some("origin")).unwrap(),
        "https://github.com/me/app/pull/new/feature-x"
    );
}
