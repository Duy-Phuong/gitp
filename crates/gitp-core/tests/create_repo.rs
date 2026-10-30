//! Making new repositories: `init_repo` into a folder, `clone_repo` from a
//! bare remote over `file://` (the smart transport, so git reports meters as
//! it would from a hosted remote).

use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use gitp_core::{clone_repo, init_repo, CloneOptions, Error, NetworkHooks, Progress, Repo};
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

/// A bare remote on `main` holding one commit of `files` distinct files, and
/// its `file://` URL.
fn remote_with(files: usize) -> (TempDir, String) {
    let seed = TempDir::new().unwrap();
    git(seed.path(), &["init", "-q", "-b", "main"]);
    git(seed.path(), &["config", "user.name", "Tester"]);
    git(seed.path(), &["config", "user.email", "t@t.io"]);
    for i in 0..files {
        let body: String = (0..40).map(|l| format!("{i} line {l}\n")).collect();
        std::fs::write(seed.path().join(format!("f{i}.txt")), body).unwrap();
    }
    git(seed.path(), &["add", "."]);
    git(seed.path(), &["commit", "-q", "-m", "base"]);

    let remote = TempDir::new().unwrap();
    let bare = remote.path().display().to_string();
    git(seed.path(), &["clone", "-q", "--bare", ".", &bare]);
    let url = format!("file://{bare}");
    (remote, url)
}

#[test]
fn init_creates_the_folder_and_writes_the_chosen_files() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("nested").join("proj");

    init_repo(&path, Some("target/\n"), true).expect("init");

    assert!(Repo::open(&path).is_ok(), "a repository now opens there");
    assert_eq!(
        std::fs::read_to_string(path.join(".gitignore")).unwrap(),
        "target/\n"
    );
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "# proj\n"
    );
}

#[test]
fn init_writes_nothing_it_was_not_asked_for() {
    let tmp = TempDir::new().unwrap();
    init_repo(tmp.path(), None, false).expect("init");
    assert!(tmp.path().join(".git").is_dir());
    assert!(!tmp.path().join(".gitignore").exists());
    assert!(!tmp.path().join("README.md").exists());
}

#[test]
fn init_never_overwrites_an_existing_readme() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("README.md"), "mine\n").unwrap();

    let err = init_repo(tmp.path(), None, true).unwrap_err();

    assert!(
        err.to_string().contains("README.md already exists"),
        "{err}"
    );
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("README.md")).unwrap(),
        "mine\n"
    );
    assert!(
        !tmp.path().join(".git").exists(),
        "refused before git init ran"
    );
}

#[test]
fn init_refuses_a_relative_path() {
    assert!(init_repo(std::path::Path::new("relative/dir"), None, false).is_err());
}

#[test]
fn clone_reports_progress_and_makes_an_openable_repo() {
    let (_remote, url) = remote_with(30);
    let parent = TempDir::new().unwrap();
    let dest = parent.path().join("copy");
    let seen: Arc<Mutex<Vec<Progress>>> = Arc::default();
    let sink = Arc::clone(&seen);
    let hooks = NetworkHooks {
        on_progress: Some(Box::new(move |p: &Progress| {
            sink.lock().unwrap().push(p.clone())
        })),
        ..Default::default()
    };

    clone_repo(&url, &dest, &CloneOptions::default(), &hooks).expect("clone");

    assert!(dest.join("f0.txt").is_file());
    assert_eq!(git(&dest, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    assert!(Repo::open(&dest).is_ok());
    assert!(
        seen.lock()
            .unwrap()
            .iter()
            .any(|p| p.phase == "Receiving objects"),
        "git's meters reached the hook"
    );
}

#[test]
fn clone_refuses_a_url_git_would_read_as_an_option() {
    let parent = TempDir::new().unwrap();
    let dest = parent.path().join("x");
    let err = clone_repo(
        "--upload-pack=touch /tmp/pwned",
        &dest,
        &CloneOptions::default(),
        &NetworkHooks::default(),
    )
    .unwrap_err();
    assert!(err.to_string().contains("read as an option"), "{err}");
    assert!(!dest.exists());
}

#[test]
fn clone_into_a_folder_that_does_not_exist_is_refused() {
    let (_remote, url) = remote_with(1);
    let err = clone_repo(
        &url,
        Path::new("/no/such/parent/copy"),
        &CloneOptions::default(),
        &NetworkHooks::default(),
    )
    .unwrap_err();
    assert!(err.to_string().contains("not an existing folder"), "{err}");
}

#[test]
fn a_cancelled_clone_leaves_no_folder_behind() {
    let (_remote, url) = remote_with(30);
    let parent = TempDir::new().unwrap();
    let dest = parent.path().join("copy");
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&cancel);
    // Cancel on the very first meter: git is certainly running by then.
    let hooks = NetworkHooks {
        on_progress: Some(Box::new(move |_: &Progress| {
            flag.store(true, Ordering::SeqCst)
        })),
        cancel: Some(cancel),
        ..Default::default()
    };

    let result = clone_repo(&url, &dest, &CloneOptions::default(), &hooks);

    assert!(matches!(result, Err(Error::Cancelled)), "{result:?}");
    assert!(!dest.exists(), "git removed its half-made clone");
}

#[test]
fn clone_options_pick_one_shallow_branch() {
    let (_remote, url) = remote_with(1);
    // A second branch two commits ahead of main, pushed to the remote from a
    // scratch clone.
    let scratch = TempDir::new().unwrap();
    git(scratch.path(), &["clone", "-q", &url, "."]);
    git(scratch.path(), &["config", "user.name", "Tester"]);
    git(scratch.path(), &["config", "user.email", "t@t.io"]);
    git(scratch.path(), &["checkout", "-q", "-b", "feat"]);
    for msg in ["f1", "f2"] {
        std::fs::write(scratch.path().join("feat.txt"), msg).unwrap();
        git(scratch.path(), &["add", "feat.txt"]);
        git(scratch.path(), &["commit", "-q", "-m", msg]);
    }
    git(scratch.path(), &["push", "-q", "origin", "feat"]);

    let parent = TempDir::new().unwrap();
    let dest = parent.path().join("copy");
    let options = CloneOptions {
        branch: Some("feat".into()),
        single_branch: true,
        depth: Some(1),
        ..Default::default()
    };
    clone_repo(&url, &dest, &options, &NetworkHooks::default()).expect("clone");

    assert_eq!(git(&dest, &["rev-parse", "--abbrev-ref", "HEAD"]), "feat");
    assert_eq!(git(&dest, &["rev-list", "--count", "HEAD"]), "1", "shallow");
    assert_eq!(
        git(&dest, &["branch", "-r"]),
        "origin/feat",
        "single branch"
    );
}

#[test]
fn a_branch_option_git_would_read_as_an_option_is_refused() {
    let parent = TempDir::new().unwrap();
    let options = CloneOptions {
        branch: Some("--upload-pack=x".into()),
        ..Default::default()
    };
    let err = clone_repo(
        "file:///nowhere",
        &parent.path().join("x"),
        &options,
        &NetworkHooks::default(),
    )
    .unwrap_err();
    assert!(err.to_string().contains("read as an option"), "{err}");
}
