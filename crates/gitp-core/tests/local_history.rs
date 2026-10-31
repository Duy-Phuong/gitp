//! Local history: snapshots of the working tree, the versions of a file in
//! them, and putting one back.

mod common;

use common::FixtureRepo;
use gitp_core::Repo;

fn write(fx: &FixtureRepo, name: &str, text: &str) {
    let full = fx.path().join(name);
    std::fs::create_dir_all(full.parent().unwrap()).unwrap();
    std::fs::write(full, text).unwrap();
}

#[test]
fn a_snapshot_holds_the_uncommitted_edits_and_new_files_but_not_ignored_ones() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    fx.commit_file(".gitignore", "*.log\n", "ignore");
    let repo = Repo::open(fx.path()).unwrap();
    assert_eq!(
        repo.snapshot_working_tree().unwrap(),
        None,
        "a clean tree needs none"
    );

    write(&fx, "a.txt", "two\n");
    write(&fx, "notes/new.md", "draft\n");
    write(&fx, "build.log", "noise\n");
    let id = repo.snapshot_working_tree().unwrap().expect("a snapshot");

    let history = repo.local_history().unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].id, id);
    assert_eq!(history[0].head, repo.head_commit_id().unwrap());
    let mut files: Vec<(String, String)> = history[0]
        .files
        .iter()
        .map(|f| (f.status.clone(), f.path.clone()))
        .collect();
    files.sort();
    assert_eq!(
        files,
        vec![
            ("A".into(), "notes/new.md".into()),
            ("M".into(), "a.txt".into())
        ]
    );

    // Nothing moved in the repository itself.
    assert_eq!(
        repo.working_changes().unwrap().len(),
        2,
        "the edits are still local (and the ignored file stays ignored)"
    );
    assert!(repo
        .refs()
        .unwrap()
        .branches
        .iter()
        .all(|b| b.name != "gitp"));

    // The same tree again is not stored twice.
    assert_eq!(repo.snapshot_working_tree().unwrap(), None);
}

#[test]
fn file_versions_follow_a_file_through_the_snapshots_and_restore_puts_one_back() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();

    write(&fx, "a.txt", "two\n");
    let s1 = repo.snapshot_working_tree().unwrap().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    write(&fx, "other.txt", "x\n");
    let s2 = repo.snapshot_working_tree().unwrap().unwrap(); // a.txt unchanged: same version
    std::thread::sleep(std::time::Duration::from_millis(5));
    write(&fx, "a.txt", "three\n");
    let s3 = repo.snapshot_working_tree().unwrap().unwrap();
    assert_ne!(s1, s2);
    assert_ne!(s2, s3);

    let versions = repo.file_versions("a.txt").unwrap();
    assert_eq!(
        versions.len(),
        2,
        "two distinct contents, the repeat folded: {versions:?}"
    );
    assert_eq!(versions[0].snapshot, s3);
    assert_eq!(
        repo.snapshot_file(&versions[0].snapshot, "a.txt").unwrap(),
        b"three\n"
    );
    assert_eq!(
        repo.snapshot_file(&versions[1].snapshot, "a.txt").unwrap(),
        b"two\n"
    );
    assert_eq!(versions[0].size, 6);

    // The file is "lost": deleted from disk. Its versions are still there.
    std::fs::remove_file(fx.path().join("a.txt")).unwrap();
    repo.restore_from_snapshot(&versions[1].snapshot, "a.txt")
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(fx.path().join("a.txt")).unwrap(),
        "two\n"
    );

    // A new file that was never committed comes back too, folders and all.
    std::fs::remove_file(fx.path().join("other.txt")).unwrap();
    repo.restore_from_snapshot(&s2, "other.txt").unwrap();
    assert_eq!(
        std::fs::read_to_string(fx.path().join("other.txt")).unwrap(),
        "x\n"
    );

    assert!(repo.restore_from_snapshot(&s2, "../escape").is_err());
    assert!(repo.snapshot_file("--exec=true", "a.txt").is_err());

    repo.clear_local_history().unwrap();
    assert!(repo.local_history().unwrap().is_empty());
}

#[test]
fn a_big_new_file_is_left_out_and_a_conflict_in_progress_takes_no_snapshot() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    write(&fx, "small.bin", "ok\n");
    std::fs::write(
        fx.path().join("huge.bin"),
        vec![0u8; (gitp_core::HISTORY_MAX_NEW_FILE + 1) as usize],
    )
    .unwrap();
    repo.snapshot_working_tree().unwrap().unwrap();
    let paths: Vec<String> = repo.local_history().unwrap()[0]
        .files
        .iter()
        .map(|f| f.path.clone())
        .collect();
    assert_eq!(paths, vec!["small.bin"]);

    // Unmerged entries in the index: no snapshot of conflict markers.
    let base = repo.refs().unwrap().head.unwrap();
    repo.create_branch_here("other").unwrap();
    repo.checkout_branch("other").unwrap();
    std::fs::remove_file(fx.path().join("huge.bin")).unwrap();
    std::fs::remove_file(fx.path().join("small.bin")).unwrap();
    std::fs::write(fx.path().join("a.txt"), "theirs\n").unwrap();
    std::process::Command::new("git")
        .current_dir(fx.path())
        .args(["commit", "-qam", "theirs"])
        .status()
        .unwrap();
    repo.checkout_branch(&base).unwrap();
    std::fs::write(fx.path().join("a.txt"), "ours\n").unwrap();
    std::process::Command::new("git")
        .current_dir(fx.path())
        .args(["commit", "-qam", "ours"])
        .status()
        .unwrap();
    assert!(repo
        .merge_branch("other", gitp_core::MergeMode::Default)
        .is_err());
    assert_eq!(repo.snapshot_working_tree().unwrap(), None);
}
