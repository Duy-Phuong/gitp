//! Git LFS: telling an LFS repository from another one (which needs no
//! git-lfs), and the track / untrack / install commands (which do — those
//! tests are skipped, with a note, on a machine without it).

mod common;

use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

use common::FixtureRepo;
use gitp_core::{NetworkHooks, Repo};

fn lfs_installed() -> bool {
    let found = Command::new("git")
        .args(["lfs", "version"])
        .output()
        .is_ok_and(|o| o.status.success());
    if !found {
        eprintln!("note: git-lfs is not installed; skipping the test that needs it");
    }
    found
}

#[test]
fn a_repository_without_lfs_patterns_is_not_an_lfs_repository() {
    let fx = FixtureRepo::init();
    std::fs::write(fx.path().join(".gitattributes"), "*.sh text eol=lf\n").unwrap();
    let status = Repo::open(fx.path()).unwrap().lfs_status().unwrap();
    assert!(!status.used);
    assert!(status.patterns.is_empty());
}

#[test]
fn lfs_patterns_are_read_from_gitattributes() {
    let fx = FixtureRepo::init();
    std::fs::write(
        fx.path().join(".gitattributes"),
        "# assets\n*.psd filter=lfs diff=lfs merge=lfs -text\n*.sh text\n\
         assets/** filter=lfs diff=lfs merge=lfs -text\n#*.zip filter=lfs\n",
    )
    .unwrap();
    let status = Repo::open(fx.path()).unwrap().lfs_status().unwrap();
    assert!(status.used);
    assert_eq!(status.patterns, ["*.psd", "assets/**"]);
}

#[test]
fn track_and_untrack_edit_gitattributes() {
    if !lfs_installed() {
        return;
    }
    let fx = FixtureRepo::init();
    let repo = Repo::open(fx.path()).unwrap();
    assert!(repo.lfs_status().unwrap().installed);

    repo.lfs_track("*.psd").expect("track");
    let status = repo.lfs_status().unwrap();
    assert!(status.used);
    assert_eq!(status.patterns, ["*.psd"]);

    repo.lfs_untrack("*.psd").expect("untrack");
    assert!(!repo.lfs_status().unwrap().used);

    assert!(repo.lfs_track("  ").is_err(), "a pattern is needed");
}

#[test]
fn a_pattern_that_looks_like_an_option_is_tracked_as_a_pattern() {
    if !lfs_installed() {
        return;
    }
    let fx = FixtureRepo::init();
    let repo = Repo::open(fx.path()).unwrap();
    repo.lfs_track("--help").expect("track");
    assert_eq!(repo.lfs_status().unwrap().patterns, ["--help"]);
}

#[test]
fn install_local_configures_the_filters_for_the_repository() {
    if !lfs_installed() {
        return;
    }
    let fx = FixtureRepo::init();
    let repo = Repo::open(fx.path()).unwrap();
    repo.lfs_install().expect("install");
    let local = Command::new("git")
        .current_dir(fx.path())
        .args(["config", "--local", "filter.lfs.process"])
        .output()
        .unwrap();
    assert!(local.status.success(), "the filter is set in .git/config");
    assert!(repo.lfs_status().unwrap().initialized);
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        // A clone that leaves the LFS files as pointers, for the pull to fill.
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn pull_replaces_pointer_files_with_their_content_and_reports_progress() {
    if !lfs_installed() {
        return;
    }
    // A repository with one LFS file, pushed to a local remote (git-lfs serves
    // a path remote itself), and a clone of it that kept only the pointer.
    let root = tempfile::tempdir().unwrap();
    let (remote, src, dst) = (
        root.path().join("remote.git"),
        root.path().join("src"),
        root.path().join("dst"),
    );
    git(root.path(), &["init", "-q", "--bare", "remote.git"]);
    git(root.path(), &["init", "-q", "src"]);
    git(&src, &["lfs", "install", "--local"]);
    git(&src, &["lfs", "track", "*.bin"]);
    let content = vec![7u8; 50_000];
    std::fs::write(src.join("a.bin"), &content).unwrap();
    git(&src, &["add", "."]);
    git(
        &src,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@t.io",
            "commit",
            "-qm",
            "init",
        ],
    );
    // A file:// URL: git-lfs can't use a bare path.
    let url = format!("file://{}", remote.display());
    git(&src, &["remote", "add", "origin", &url]);
    git(&src, &["push", "-q", "origin", "HEAD:main"]);
    git(root.path(), &["clone", "-q", "-b", "main", &url, "dst"]);
    assert_ne!(
        std::fs::read(dst.join("a.bin")).unwrap(),
        content,
        "a pointer"
    );

    let mut repo = Repo::open(&dst).unwrap();
    let phases = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&phases);
    repo.set_network_hooks(NetworkHooks {
        on_progress: Some(Box::new(move |p| {
            seen.lock().unwrap().push(p.phase.clone())
        })),
        ..NetworkHooks::default()
    });
    repo.lfs_pull().expect("pull");

    assert_eq!(std::fs::read(dst.join("a.bin")).unwrap(), content);
    assert!(
        phases
            .lock()
            .unwrap()
            .iter()
            .any(|p| p == "Downloading LFS objects"),
        "git-lfs's meter reaches the progress hook: {:?}",
        phases.lock().unwrap()
    );
}
