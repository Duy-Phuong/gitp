//! A repo's text encoding (`gitp.encoding`): diffs and blame are decoded with
//! it, and the editor reads and writes files in it.

mod common;

use std::fs;
use std::path::Path;
use std::process::Command;

use common::FixtureRepo;
use gitp_core::{ConfigScope, Repo, ENCODING_KEY};

// "日本語" in Shift_JIS.
const SJIS: &[u8] = b"\x93\xfa\x96\x7b\x8c\xea";

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .current_dir(dir)
        .args(args)
        .status()
        .unwrap();
    assert!(ok.success(), "git {args:?}");
}

fn commit_bytes(fx: &FixtureRepo, name: &str, bytes: &[u8]) {
    fs::write(fx.path().join(name), bytes).unwrap();
    git(fx.path(), &["add", name]);
    git(fx.path(), &["commit", "-q", "-m", name]);
}

fn with_encoding(fx: &FixtureRepo, label: &str) -> Repo {
    let repo = Repo::open(fx.path()).unwrap();
    repo.set_config(ConfigScope::Local, ENCODING_KEY, label)
        .unwrap();
    repo
}

#[test]
fn diffs_and_blame_are_decoded_in_the_repo_encoding() {
    let fx = FixtureRepo::init();
    commit_bytes(&fx, "a.txt", &[SJIS, b"\n"].concat());

    // Without a setting the bytes are UTF-8 to gitp, and not valid.
    let repo = Repo::open(fx.path()).unwrap();
    let line = &repo.commit_detail("HEAD").unwrap().files[0].hunks[0].lines[0].content;
    assert!(line.contains('\u{fffd}'), "{line:?}");

    let repo = with_encoding(&fx, "shift_jis");
    let detail = repo.commit_detail("HEAD").unwrap();
    assert_eq!(detail.files[0].hunks[0].lines[0].content, "日本語");
    assert_eq!(repo.blame("HEAD", "a.txt").unwrap()[0].content, "日本語");

    // The working-tree diff too.
    fs::write(fx.path().join("a.txt"), [SJIS, b"!\n"].concat()).unwrap();
    let diff = repo.file_diff("a.txt", false, 3, None).unwrap().unwrap();
    let added: Vec<_> = diff.hunks[0]
        .lines
        .iter()
        .filter(|l| l.origin == '+')
        .collect();
    assert_eq!(added[0].content, "日本語!");
}

#[test]
fn the_editor_reads_and_writes_in_the_repo_encoding() {
    let fx = FixtureRepo::init();
    fs::write(fx.path().join("j.txt"), [SJIS, b"\r\n"].concat()).unwrap();

    // As UTF-8 it isn't text at all.
    let err = Repo::open(fx.path())
        .unwrap()
        .read_text_file("j.txt")
        .unwrap_err();
    assert!(err.to_string().contains("isn't UTF-8 text"), "{err}");

    let repo = with_encoding(&fx, "shift_jis");
    let file = repo.read_text_file("j.txt").unwrap().unwrap();
    assert_eq!(file.text, "日本語\n");
    assert!(file.crlf);

    repo.write_text_file("j.txt", "日本語\n語\n", true).unwrap();
    assert_eq!(
        fs::read(fx.path().join("j.txt")).unwrap(),
        [SJIS, b"\r\n\x8c\xea\r\n"].concat()
    );

    // A character Shift_JIS lacks is refused, and the file is left alone.
    let err = repo.write_text_file("j.txt", "🙂\n", false).unwrap_err();
    assert!(
        err.to_string().contains("Shift_JIS can't represent"),
        "{err}"
    );
    assert_eq!(
        fs::read(fx.path().join("j.txt")).unwrap(),
        [SJIS, b"\r\n\x8c\xea\r\n"].concat()
    );
}

// WHATWG Shift_JIS reads NEC's 0xED40 and IBM's 0xFA5C as the same kanji and
// writes it back as the latter, so opening and saving the file unchanged would
// rewrite bytes no one touched. Such a file isn't opened for editing at all.
#[test]
fn a_file_that_would_not_save_back_byte_for_byte_is_refused() {
    let fx = FixtureRepo::init();
    let raw = b"abc \xED\x40 def\n";
    fs::write(fx.path().join("n.txt"), raw).unwrap();
    let repo = with_encoding(&fx, "shift_jis");

    let err = repo.read_text_file("n.txt").unwrap_err();

    assert!(err.to_string().contains("can't be edited here"), "{err}");
    assert_eq!(fs::read(fx.path().join("n.txt")).unwrap(), raw);
}

#[test]
fn utf16_files_are_text_to_the_editor() {
    let fx = FixtureRepo::init();
    let raw = b"\xff\xfeh\0i\0\n\0";
    fs::write(fx.path().join("w.txt"), raw).unwrap();
    // Its NUL bytes make it binary as UTF-8.
    assert!(Repo::open(fx.path())
        .unwrap()
        .read_text_file("w.txt")
        .is_err());

    let repo = with_encoding(&fx, "utf-16le");
    let file = repo.read_text_file("w.txt").unwrap().unwrap();
    assert_eq!(file.text, "\u{feff}hi\n");
    repo.write_text_file("w.txt", &file.text, file.crlf)
        .unwrap();
    assert_eq!(fs::read(fx.path().join("w.txt")).unwrap(), raw);
}

#[test]
fn an_unknown_label_falls_back_to_utf8() {
    let fx = FixtureRepo::init();
    fs::write(fx.path().join("u.txt"), "héllo\n").unwrap();
    let repo = with_encoding(&fx, "klingon");
    assert_eq!(
        repo.read_text_file("u.txt").unwrap().unwrap().text,
        "héllo\n"
    );
}
