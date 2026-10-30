//! The activity log: the git commands an operation ran are listed for its
//! repository, newest first, with how they ended — a failing hook's output
//! included — and refresh-style probes marked quiet.

mod common;

use common::FixtureRepo;
use gitp_core::{clone_repo, CloneOptions, NetworkHooks, Repo};
use tempfile::TempDir;

#[test]
fn records_commands_newest_first_with_exit_status_and_duration() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "first");
    let repo = Repo::open(fx.path()).unwrap();

    std::fs::write(fx.path().join("a.txt"), "two\n").unwrap();
    repo.stage("a.txt").unwrap();
    repo.commit("second", "", false, None, false).unwrap();
    assert!(repo.stash_pop().is_err(), "no stash to pop");

    let log = repo.activity_log(None);
    assert!(log.windows(2).all(|w| w[0].id > w[1].id), "newest first");
    // Leave out any config reads the commit made along the way.
    let ops: Vec<_> = log.iter().filter(|e| !e.quiet).collect();
    let commands: Vec<&str> = ops.iter().map(|e| e.command.as_str()).collect();
    assert_eq!(
        commands,
        [
            "git stash pop",
            "git commit -m second",
            "git add -- :(literal)a.txt"
        ]
    );

    let pop = ops[0];
    assert!(!pop.success);
    assert_eq!(pop.exit_code, Some(1));
    assert!(
        pop.stderr.contains("No stash entries found"),
        "{:?}",
        pop.stderr
    );
    let commit = ops[1];
    assert!(commit.success);
    assert_eq!(commit.exit_code, Some(0));
    assert!(commit.stdout.is_empty(), "a success's stdout isn't kept");
    assert!(ops.iter().all(|e| e.started_at > 0));
}

#[test]
fn a_failing_hook_leaves_its_output_in_the_log() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "first");
    let hook = fx.path().join(".git/hooks/pre-commit");
    std::fs::write(
        &hook,
        "#!/bin/sh\nsleep 0.2\necho 'lint: 2 problems' >&2\nexit 1\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let repo = Repo::open(fx.path()).unwrap();
    std::fs::write(fx.path().join("a.txt"), "two\n").unwrap();
    repo.stage("a.txt").unwrap();
    assert!(repo.commit("second", "", false, None, false).is_err());

    let log = repo.activity_log(None);
    let failed = log.iter().find(|e| !e.quiet).unwrap();
    assert_eq!(failed.command, "git commit -m second");
    assert!(!failed.success);
    assert!(
        failed.stderr.contains("lint: 2 problems"),
        "{:?}",
        failed.stderr
    );
    assert!(failed.duration_ms >= 200, "took {}ms", failed.duration_ms);
}

#[test]
fn status_probes_are_quiet() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "first");
    let repo = Repo::open(fx.path()).unwrap();
    repo.status_summary().unwrap();

    let probe = &repo.activity_log(None)[0];
    assert!(
        probe.command.starts_with("git --no-optional-locks status"),
        "{}",
        probe.command
    );
    assert!(probe.quiet);
    assert!(probe.success);
}

#[test]
fn since_returns_only_newer_entries_and_clear_empties_the_log() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "first");
    let repo = Repo::open(fx.path()).unwrap();
    repo.status_summary().unwrap();
    let seen = repo.activity_log(None)[0].id;
    let _ = repo.stash_pop();

    let newer = repo.activity_log(Some(seen));
    assert_eq!(newer.len(), 1);
    assert_eq!(newer[0].command, "git stash pop");

    repo.clear_activity_log();
    assert!(repo.activity_log(None).is_empty());
}

#[test]
fn each_repository_has_its_own_log() {
    let a = FixtureRepo::init();
    let b = FixtureRepo::init();
    let (ra, rb) = (Repo::open(a.path()).unwrap(), Repo::open(b.path()).unwrap());
    let _ = ra.stash_pop();
    assert!(rb.activity_log(None).is_empty());
    assert_eq!(ra.activity_log(None).len(), 1);
}

#[test]
fn a_clone_is_logged_under_the_repository_it_made() {
    let src = FixtureRepo::init();
    src.commit_file("a.txt", "one\n", "first");
    let tmp = TempDir::new().unwrap();
    let dest = tmp.path().join("copy");
    let url = format!("file://{}", src.path().display());
    clone_repo(
        &url,
        &dest,
        &CloneOptions::default(),
        &NetworkHooks::default(),
    )
    .unwrap();

    let log = Repo::open(&dest).unwrap().activity_log(None);
    assert_eq!(log.len(), 1, "{log:?}");
    assert!(
        log[0]
            .command
            .starts_with("git clone --progress -- file://"),
        "{}",
        log[0].command
    );
    assert!(log[0].success);
}
