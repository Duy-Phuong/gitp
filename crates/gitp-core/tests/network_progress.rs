//! Live progress and cancel for the network commands. Real repos wired to a
//! bare remote over `file://` — the smart transport, so the server side reports
//! its own meters just as a hosted remote would — with no network involved.

use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gitp_core::{Error, NetworkHooks, Progress, Repo};
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(out.status.success(), "git {args:?} failed in {dir:?}");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn init_repo(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Tester"]);
    git(dir, &["config", "user.email", "t@t.io"]);
}

/// Commit `count` files of distinct content, enough objects that git bothers
/// to print meters for them.
fn commit_many(dir: &Path, count: usize, tag: &str) {
    for i in 0..count {
        let body: String = (0..40).map(|l| format!("{tag} {i} line {l}\n")).collect();
        std::fs::write(dir.join(format!("f{i}.txt")), body).unwrap();
    }
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", tag]);
}

/// A bare remote, a seed clone that has pushed `main` to it, and a second
/// clone (`work`) that is one big commit behind.
struct Setup {
    _remote: TempDir,
    seed: TempDir,
    work: TempDir,
}

fn setup() -> Setup {
    let remote = TempDir::new().unwrap();
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
    let url = format!("file://{}", remote.path().display());

    let seed = TempDir::new().unwrap();
    init_repo(seed.path());
    git(seed.path(), &["remote", "add", "origin", &url]);
    commit_many(seed.path(), 5, "base");
    git(seed.path(), &["push", "-q", "-u", "origin", "main"]);

    let work = TempDir::new().unwrap();
    init_repo(work.path());
    git(work.path(), &["remote", "add", "origin", &url]);
    git(work.path(), &["fetch", "-q", "origin"]);
    git(
        work.path(),
        &["checkout", "-q", "-B", "main", "origin/main"],
    );

    commit_many(seed.path(), 30, "big");
    git(seed.path(), &["push", "-q"]);
    Setup {
        _remote: remote,
        seed,
        work,
    }
}

/// Open `dir` with hooks that record every progress update.
fn open_recording(dir: &Path, cancel: Arc<AtomicBool>) -> (Repo, Arc<Mutex<Vec<Progress>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    let mut repo = Repo::open(dir).unwrap();
    repo.set_network_hooks(NetworkHooks {
        on_progress: Some(Box::new(move |p: &Progress| {
            sink.lock().unwrap().push(p.clone())
        })),
        cancel: Some(cancel),
    });
    (repo, seen)
}

#[test]
fn fetch_reports_progress_and_returns_the_usual_output() {
    let s = setup();
    let (repo, seen) = open_recording(s.work.path(), Arc::default());

    let out = repo.fetch_all().expect("fetch succeeds");

    let seen = seen.lock().unwrap();
    assert!(!seen.is_empty(), "at least one progress update");
    assert!(
        seen.iter().any(|p| p.percent.is_some()),
        "some update carries a percentage: {seen:?}"
    );
    // The meters went to the hooks, not into the text shown to the user.
    assert!(
        out.contains("origin/main"),
        "the ref update is reported: {out}"
    );
    assert!(!out.contains('%'), "no meters in the output: {out}");
    assert!(
        !out.contains("Total "),
        "no pack statistics in the output: {out}"
    );
    assert_eq!(
        git(s.work.path(), &["rev-parse", "origin/main"]),
        git(s.seed.path(), &["rev-parse", "main"]),
        "the fetch really happened"
    );
}

#[test]
fn push_reports_writing_progress() {
    let s = setup();
    let (repo, seen) = open_recording(s.seed.path(), Arc::default());
    commit_many(s.seed.path(), 30, "more");

    let out = repo.push().expect("push succeeds");

    assert!(
        seen.lock()
            .unwrap()
            .iter()
            .any(|p| p.phase == "Writing objects"),
        "push reports its upload"
    );
    assert!(out.contains("main -> main"), "{out}");
    assert!(!out.contains('%'), "no meters in the output: {out}");
}

#[test]
fn a_failure_still_returns_gits_error_text() {
    let s = setup();
    let (repo, _) = open_recording(s.work.path(), Arc::default());
    let err = repo.fetch_remote("nope").expect_err("unknown remote");
    assert!(
        err.to_string().contains("nope"),
        "git's own message comes through: {err}"
    );
}

#[test]
fn a_cancel_raised_before_the_start_never_runs_git() {
    let s = setup();
    let before = git(s.work.path(), &["rev-parse", "origin/main"]);
    let (repo, seen) = open_recording(s.work.path(), Arc::new(AtomicBool::new(true)));

    assert!(matches!(repo.fetch_all(), Err(Error::Cancelled)));
    assert!(seen.lock().unwrap().is_empty());
    assert_eq!(git(s.work.path(), &["rev-parse", "origin/main"]), before);
}

#[test]
fn cancelling_mid_transfer_kills_git_and_says_cancelled() {
    let s = setup();
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&cancel);
    let mut repo = Repo::open(s.work.path()).unwrap();
    // Cancel on the very first meter: git is certainly running by then.
    repo.set_network_hooks(NetworkHooks {
        on_progress: Some(Box::new(move |_: &Progress| {
            flag.store(true, Ordering::SeqCst)
        })),
        cancel: Some(cancel),
    });

    let err = repo.pull(gitp_core::PullMode::FastForwardOnly);
    assert!(matches!(err, Err(Error::Cancelled)), "{err:?}");
}

#[test]
fn cancel_gets_out_of_a_remote_that_never_answers() {
    let s = setup();
    // An upload-pack that sits silent before doing anything — a stalled
    // server. Git prints nothing at all while it waits.
    git(
        s.work.path(),
        &[
            "config",
            "remote.origin.uploadpack",
            "sleep 10; git-upload-pack",
        ],
    );
    let cancel = Arc::new(AtomicBool::new(false));
    let (repo, _) = open_recording(s.work.path(), Arc::clone(&cancel));
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        cancel.store(true, Ordering::SeqCst);
    });

    let started = Instant::now();
    let result = repo.fetch_remote("origin");
    canceller.join().unwrap();

    assert!(matches!(result, Err(Error::Cancelled)), "{result:?}");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "returned promptly, not after the remote woke: {:?}",
        started.elapsed()
    );
}
