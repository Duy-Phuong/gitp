//! The in-app editor's file access: text with its line breaks kept, creating
//! and deleting files, and paths that stay inside the working tree.

mod common;

use std::fs;

use common::FixtureRepo;
use gitp_core::{Repo, TextFile, EDIT_MAX_BYTES};

fn open(fx: &FixtureRepo) -> Repo {
    Repo::open(fx.path()).unwrap()
}

/// Read `raw` back through the editor and save it unchanged.
fn round_trip(raw: &[u8]) -> (TextFile, Vec<u8>) {
    let fx = FixtureRepo::init();
    fs::write(fx.path().join("f.txt"), raw).unwrap();
    let repo = open(&fx);
    let file = repo.read_text_file("f.txt").unwrap().unwrap();
    repo.write_text_file("f.txt", &file.text, file.crlf)
        .unwrap();
    (file, fs::read(fx.path().join("f.txt")).unwrap())
}

#[test]
fn saving_unchanged_text_keeps_the_bytes() {
    for raw in [
        &b"one\ntwo\n"[..],
        b"one\ntwo",
        b"one\r\ntwo\r\n",
        b"one\r\ntwo",
        b"",
        b"\n\n",
        "\u{feff}bom\r\n".as_bytes(),
    ] {
        let (file, saved) = round_trip(raw);
        assert!(!file.mixed, "{raw:?}");
        assert_eq!(saved, raw, "{raw:?}");
    }
}

#[test]
fn crlf_files_are_read_as_lf_and_saved_as_crlf() {
    let fx = FixtureRepo::init();
    fs::write(fx.path().join("w.txt"), "a\r\nb\r\n").unwrap();
    let repo = open(&fx);

    let file = repo.read_text_file("w.txt").unwrap().unwrap();
    assert_eq!(file.text, "a\nb\n");
    assert!(file.crlf);

    // An edit made in the editor (LF) goes back with the file's CRLF.
    repo.write_text_file("w.txt", "a\nnew\nb\n", true).unwrap();
    assert_eq!(
        fs::read(fx.path().join("w.txt")).unwrap(),
        b"a\r\nnew\r\nb\r\n"
    );
}

#[test]
fn mixed_line_breaks_are_flagged_and_take_the_majority() {
    let (file, saved) = round_trip(b"a\r\nb\r\nc\n");
    assert!(file.mixed && file.crlf);
    assert_eq!(saved, b"a\r\nb\r\nc\r\n");

    let (file, saved) = round_trip(b"a\rb\n");
    assert!(file.mixed && !file.crlf);
    assert_eq!(saved, b"a\nb\n");
}

#[test]
fn binary_large_and_non_utf8_files_are_refused() {
    let fx = FixtureRepo::init();
    fs::write(fx.path().join("bin"), b"ab\0cd").unwrap();
    fs::write(fx.path().join("latin1"), b"caf\xe9").unwrap();
    fs::write(
        fx.path().join("big"),
        vec![b'x'; EDIT_MAX_BYTES as usize + 1],
    )
    .unwrap();
    let repo = open(&fx);

    for (path, why) in [("bin", "binary"), ("latin1", "UTF-8"), ("big", "too large")] {
        let err = repo.read_text_file(path).unwrap_err().to_string();
        assert!(err.contains(why), "{path}: {err}");
    }
    assert!(repo.read_text_file("missing.txt").unwrap().is_none());
}

#[test]
fn create_makes_folders_and_refuses_an_existing_file() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a", "c1");
    let repo = open(&fx);

    repo.create_file("docs/notes/new.md").unwrap();
    assert_eq!(fs::read(fx.path().join("docs/notes/new.md")).unwrap(), b"");
    assert!(repo.create_file("docs/notes/new.md").is_err());
    assert!(repo.create_file("a.txt").is_err());
    assert_eq!(fs::read(fx.path().join("a.txt")).unwrap(), b"a");
}

#[test]
fn delete_removes_the_file_only() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a", "c1");
    fs::create_dir(fx.path().join("dir")).unwrap();
    let repo = open(&fx);

    repo.delete_file("a.txt").unwrap();
    assert!(!fx.path().join("a.txt").exists());
    assert!(repo.delete_file("a.txt").is_err());
    assert!(repo.delete_file("dir").is_err(), "a folder isn't a file");
}

#[test]
fn paths_stay_inside_the_working_tree() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a", "c1");
    let repo = open(&fx);

    for bad in [
        "",
        ".",
        "/etc/hosts",
        "../x.txt",
        "dir/../../x.txt",
        ".git/config",
        ".git/hooks/pre-commit",
        "sub/.GIT/x",
    ] {
        assert!(repo.read_text_file(bad).is_err(), "read {bad}");
        assert!(
            repo.write_text_file(bad, "x", false).is_err(),
            "write {bad}"
        );
        assert!(repo.create_file(bad).is_err(), "create {bad}");
        assert!(repo.delete_file(bad).is_err(), "delete {bad}");
    }
}

#[cfg(unix)]
#[test]
fn symlinks_out_of_the_working_tree_are_refused() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a", "c1");
    let outside = tempfile::TempDir::new().unwrap();
    fs::write(outside.path().join("secret.txt"), "s").unwrap();
    std::os::unix::fs::symlink(outside.path(), fx.path().join("out")).unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret.txt"),
        fx.path().join("link.txt"),
    )
    .unwrap();
    let repo = open(&fx);

    // Through a symlinked folder…
    assert!(repo.read_text_file("out/secret.txt").is_err());
    assert!(repo.write_text_file("out/secret.txt", "x", false).is_err());
    assert!(repo.create_file("out/new/x.txt").is_err());
    assert!(repo.delete_file("out/secret.txt").is_err());
    assert!(!outside.path().join("new").exists());
    // …or a symlinked file.
    assert!(repo.read_text_file("link.txt").is_err());
    assert!(repo.write_text_file("link.txt", "x", false).is_err());
    assert_eq!(fs::read(outside.path().join("secret.txt")).unwrap(), b"s");
}

#[test]
fn lists_tracked_and_untracked_but_not_ignored_files() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a", "c1");
    fx.commit_file(".gitignore", "*.log\n", "c2");
    fs::write(fx.path().join("new.txt"), "n").unwrap();
    fs::write(fx.path().join("debug.log"), "l").unwrap();
    let repo = open(&fx);

    assert_eq!(
        repo.list_work_files().unwrap(),
        [".gitignore", "a.txt", "new.txt"]
    );
}
