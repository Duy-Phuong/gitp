//! File-level local-changes operations driven by the changes-view right-click
//! menu: discard whole files, stash selected files, save selected files as a
//! patch, and add files to `.gitignore`.

mod common;

use common::FixtureRepo;
use gitp_core::Repo;

#[test]
fn discard_files_reverts_modified_and_deletes_untracked() {
    let fx = FixtureRepo::init();
    fx.commit_file("tracked.txt", "original\n", "c1");
    // Modify a tracked file (staged) and add an untracked one.
    std::fs::write(fx.path().join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(fx.path().join("new.txt"), "brand new\n").unwrap();

    let repo = Repo::open(fx.path()).unwrap();
    repo.stage("tracked.txt").unwrap(); // discard must undo staged changes too

    repo.discard_files(&["tracked.txt".into(), "new.txt".into()]).unwrap();

    // Tracked file is back to its committed content, and nothing is left staged
    // or unstaged; the untracked file is gone.
    assert_eq!(std::fs::read_to_string(fx.path().join("tracked.txt")).unwrap(), "original\n");
    assert!(!fx.path().join("new.txt").exists(), "untracked file deleted");
    let s = repo.status_lists().unwrap();
    assert!(s.staged.is_empty() && s.unstaged.is_empty(), "working tree clean after discard");
}

#[test]
fn discard_files_restores_a_deleted_tracked_file() {
    let fx = FixtureRepo::init();
    fx.commit_file("keep.txt", "hello\n", "c1");
    std::fs::remove_file(fx.path().join("keep.txt")).unwrap();

    let repo = Repo::open(fx.path()).unwrap();
    repo.discard_files(&["keep.txt".into()]).unwrap();

    assert_eq!(std::fs::read_to_string(fx.path().join("keep.txt")).unwrap(), "hello\n");
}

#[test]
fn stash_files_stashes_only_the_named_paths() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a\n", "c1");
    fx.commit_file("b.txt", "b\n", "c2");
    std::fs::write(fx.path().join("a.txt"), "a changed\n").unwrap();
    std::fs::write(fx.path().join("b.txt"), "b changed\n").unwrap();

    let repo = Repo::open(fx.path()).unwrap();
    repo.stash_files(&["a.txt".into()]).unwrap();

    // a.txt reverted (stashed away), b.txt still dirty.
    assert_eq!(std::fs::read_to_string(fx.path().join("a.txt")).unwrap(), "a\n");
    assert_eq!(std::fs::read_to_string(fx.path().join("b.txt")).unwrap(), "b changed\n");
    assert_eq!(repo.refs().unwrap().stashes.len(), 1, "one stash entry created");
}

#[test]
fn stash_files_includes_untracked_selected_files() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a\n", "c1");
    std::fs::write(fx.path().join("fresh.txt"), "fresh\n").unwrap(); // untracked

    let repo = Repo::open(fx.path()).unwrap();
    repo.stash_files(&["fresh.txt".into()]).unwrap();

    assert!(!fx.path().join("fresh.txt").exists(), "untracked file stashed away");
    assert_eq!(repo.refs().unwrap().stashes.len(), 1);
}

#[test]
fn save_files_patch_writes_a_unified_diff_of_the_named_paths() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a\n", "c1");
    fx.commit_file("b.txt", "b\n", "c2");
    std::fs::write(fx.path().join("a.txt"), "a changed\n").unwrap();
    std::fs::write(fx.path().join("b.txt"), "b changed\n").unwrap();

    let repo = Repo::open(fx.path()).unwrap();
    let dest = fx.path().join("out.patch");
    repo.save_files_patch(&["a.txt".into()], false, &dest).unwrap();

    let patch = std::fs::read_to_string(&dest).unwrap();
    assert!(patch.contains("a/a.txt") && patch.contains("+a changed"), "a.txt diff present");
    assert!(!patch.contains("b.txt"), "unselected file excluded from patch");
    assert!(patch.ends_with('\n'), "patch ends with a newline");
}

#[test]
fn save_files_patch_includes_untracked_file_content() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a\n", "c1");
    std::fs::write(fx.path().join("fresh.txt"), "brand new line\n").unwrap(); // untracked

    let repo = Repo::open(fx.path()).unwrap();
    let dest = fx.path().join("new.patch");
    repo.save_files_patch(&["fresh.txt".into()], false, &dest).unwrap();

    let patch = std::fs::read_to_string(&dest).unwrap();
    assert!(patch.contains("fresh.txt") && patch.contains("+brand new line"), "untracked content captured");
    // The intent-to-add mark is undone: the file is untracked again, not staged.
    let s = repo.status_lists().unwrap();
    assert!(s.staged.is_empty(), "no lingering staged/intent-to-add entry");
    assert!(s.unstaged.iter().any(|f| f.path == "fresh.txt"), "still shows as a local change");
}

#[test]
fn save_files_patch_staged_direction_reflects_the_index() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a\n", "c1");
    std::fs::write(fx.path().join("a.txt"), "a staged\n").unwrap();

    let repo = Repo::open(fx.path()).unwrap();
    repo.stage("a.txt").unwrap();
    let dest = fx.path().join("staged.patch");
    repo.save_files_patch(&["a.txt".into()], true, &dest).unwrap();

    let patch = std::fs::read_to_string(&dest).unwrap();
    assert!(patch.contains("+a staged"), "staged diff captured");
}

#[test]
fn add_to_gitignore_appends_new_paths_without_duplicating() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a\n", "c1");
    std::fs::write(fx.path().join(".gitignore"), "existing\n").unwrap();

    let repo = Repo::open(fx.path()).unwrap();
    let added = repo.add_to_gitignore(&["build/".into(), "existing".into(), "secret.env".into()]).unwrap();

    assert_eq!(added, 2, "only the two not-already-present entries are added");
    let contents = std::fs::read_to_string(fx.path().join(".gitignore")).unwrap();
    assert!(contents.contains("build/") && contents.contains("secret.env"));
    assert_eq!(contents.matches("existing").count(), 1, "existing entry not duplicated");
}

#[test]
fn add_to_gitignore_creates_the_file_when_absent() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a\n", "c1");

    let repo = Repo::open(fx.path()).unwrap();
    let added = repo.add_to_gitignore(&["*.log".into()]).unwrap();

    assert_eq!(added, 1);
    assert_eq!(std::fs::read_to_string(fx.path().join(".gitignore")).unwrap(), "*.log\n");
}
