//! The text an "Explain with Claude" run reads.

mod common;

use std::path::Path;
use std::process::Command;

use common::FixtureRepo;
use gitp_core::{AskKind, Repo};

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

fn repo() -> FixtureRepo {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "1\n", "first");
    git(fx.path(), &["branch", "-M", "main"]);
    git(fx.path(), &["tag", "v1"]);
    fx.commit_file("b.txt", "2\n", "add b");
    fx.commit_file("c.txt", "3\n", "add c");
    git(fx.path(), &["tag", "v2"]);
    fx
}

#[test]
fn a_commit_is_explained_from_its_message_and_diff() {
    let fx = repo();
    let r = Repo::open(fx.path()).unwrap();
    let (text, what) = r.claude_ask_input(AskKind::Commit, "HEAD").unwrap();
    assert_eq!(what, "HEAD");
    assert!(text.contains("add c") && text.contains("+3"), "{text}");
}

#[test]
fn release_notes_cover_the_commits_since_the_previous_tag() {
    let fx = repo();
    let r = Repo::open(fx.path()).unwrap();
    let (text, what) = r.claude_ask_input(AskKind::Release, "v2").unwrap();
    assert_eq!(what, "v2 since v1");
    assert!(
        text.contains("add b") && text.contains("add c") && !text.contains(" first ("),
        "{text}"
    );
    let (first, what) = r.claude_ask_input(AskKind::Release, "v1").unwrap();
    assert_eq!(what, "v1 since the first commit");
    assert!(first.contains(" first ("));
}

#[test]
fn a_branch_is_summarized_against_the_default_branch() {
    let fx = repo();
    git(fx.path(), &["checkout", "-q", "-b", "feature"]);
    fx.commit_file("d.txt", "4\n", "add d");
    let r = Repo::open(fx.path()).unwrap();
    let (text, what) = r.claude_ask_input(AskKind::Branch, "feature").unwrap();
    assert_eq!(what, "feature vs main");
    assert!(
        text.contains("add d") && !text.contains("add c\n"),
        "{text}"
    );
    assert!(
        r.claude_ask_input(AskKind::Branch, "main").is_err(),
        "main has nothing main doesn't"
    );
}
