//! Applying a reviewer's ```suggestion blocks in the pull request branch's
//! worktree, as one commit — GitHub's "Commit suggestion", locally.

use std::path::Path;
use std::process::Command;

use gitp_core::{suggestion_in, Repo, Suggestion};

fn git(dir: &Path, args: &[&str]) -> String {
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
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A repository on branch `feat` with a.txt of five lines, committed.
fn repo() -> (tempfile::TempDir, Repo, String) {
    let dir = tempfile::tempdir().unwrap();
    let d = &dir.path().to_path_buf();
    git(d, &["init", "-q", "-b", "feat"]);
    git(d, &["config", "user.name", "Me"]);
    git(d, &["config", "user.email", "me@example.com"]);
    std::fs::write(d.join("a.txt"), "one\ntwo\nthree\nfour\nfive\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    let head = git(d, &["rev-parse", "HEAD"]);
    (dir, Repo::open(d).unwrap(), head)
}

fn suggestion(id: u64, start: u32, line: u32, text: &str) -> Suggestion {
    Suggestion {
        comment_id: id,
        author: "rev".into(),
        path: "a.txt".into(),
        start_line: start,
        line,
        text: text.into(),
    }
}

#[test]
fn reads_the_first_suggestion_block_of_a_comment() {
    assert_eq!(
        suggestion_in("Use this:\n```suggestion\nTWO\n```\nthanks").as_deref(),
        Some("TWO")
    );
    assert_eq!(
        suggestion_in("```suggestion\n```").as_deref(),
        Some(""),
        "an empty one deletes the lines"
    );
    assert_eq!(
        suggestion_in("```suggestion\r\nA\r\nB\r\n```").as_deref(),
        Some("A\nB")
    );
    assert_eq!(suggestion_in("```rust\nlet x = 1;\n```"), None);
    assert_eq!(suggestion_in("no block"), None);
}

#[test]
fn applies_suggestions_bottom_up_as_one_commit() {
    let (dir, repo, head) = repo();
    let commit = repo
        .apply_suggestions(
            7,
            &head,
            "feat",
            &[suggestion(1, 2, 3, "TWO-THREE"), suggestion(2, 5, 5, "")],
        )
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "one\nTWO-THREE\nfour\n"
    );
    assert_eq!(git(dir.path(), &["rev-parse", "HEAD"]), commit);
    assert_eq!(
        git(dir.path(), &["rev-parse", "HEAD~1"]),
        head,
        "one commit on the head"
    );
    let message = git(dir.path(), &["log", "-1", "--format=%B"]);
    assert!(
        message.starts_with("Apply 2 suggestions from @rev"),
        "{message}"
    );
    assert!(git(dir.path(), &["status", "--porcelain"]).is_empty());
}

#[test]
fn refuses_overlaps_a_moved_head_and_a_dirty_tree_and_changes_nothing() {
    let (dir, repo, head) = repo();
    let err = repo
        .apply_suggestions(
            7,
            &head,
            "feat",
            &[suggestion(1, 2, 3, "x"), suggestion(2, 3, 4, "y")],
        )
        .unwrap_err();
    assert!(err.to_string().contains("overlap"), "{err}");
    let err = repo
        .apply_suggestions(
            7,
            "0000000000000000000000000000000000000000",
            "feat",
            &[suggestion(1, 2, 2, "x")],
        )
        .unwrap_err();
    assert!(
        err.to_string().contains("not at the pull request's head"),
        "{err}"
    );
    let err = repo
        .apply_suggestions(7, &head, "feat", &[suggestion(1, 9, 9, "x")])
        .unwrap_err();
    assert!(err.to_string().contains("has 5 lines"), "{err}");
    std::fs::write(dir.path().join("b.txt"), "mine").unwrap();
    let err = repo
        .apply_suggestions(7, &head, "feat", &[suggestion(1, 2, 2, "x")])
        .unwrap_err();
    assert!(err.to_string().contains("Commit or stash"), "{err}");
    std::fs::remove_file(dir.path().join("b.txt")).unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "one\ntwo\nthree\nfour\nfive\n"
    );
    assert_eq!(git(dir.path(), &["rev-parse", "HEAD"]), head);
}

#[test]
fn needs_the_branch_checked_out_somewhere() {
    let (_dir, repo, head) = repo();
    let err = repo
        .apply_suggestions(7, &head, "other", &[suggestion(1, 2, 2, "x")])
        .unwrap_err();
    assert!(
        err.to_string().contains("Check the pull request out first"),
        "{err}"
    );
}

#[test]
fn keeps_crlf_line_ends() {
    let (dir, repo, _) = repo();
    std::fs::write(dir.path().join("a.txt"), "one\r\ntwo\r\nthree\r\n").unwrap();
    git(dir.path(), &["commit", "-qam", "crlf"]);
    let head = git(dir.path(), &["rev-parse", "HEAD"]);
    repo.apply_suggestions(7, &head, "feat", &[suggestion(1, 2, 2, "TWO\nTWO-B")])
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "one\r\nTWO\r\nTWO-B\r\nthree\r\n"
    );
}
