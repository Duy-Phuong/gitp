//! Helpers shared by the command-layer tests in each module.

use std::path::Path;
use std::process::Command;

pub(crate) fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(dir)
        .args(args)
        .status()
        .expect("run git");
    assert!(status.success(), "git {args:?} failed");
}

/// Build a temp repo whose commits each rewrite `f.txt`.
pub(crate) fn make_repo(dir: &Path, messages: &[&str]) {
    git(dir, &["init", "-q"]);
    git(dir, &["config", "user.email", "t@t.io"]);
    git(dir, &["config", "user.name", "Tester"]);
    for (i, msg) in messages.iter().enumerate() {
        std::fs::write(dir.join("f.txt"), format!("line {i}\n")).unwrap();
        git(dir, &["add", "f.txt"]);
        git(dir, &["commit", "-q", "-m", msg]);
    }
}

/// The checked-out branch. `git init`'s default name depends on the host's
/// `init.defaultBranch`, so tests must ask rather than assume "master".
pub(crate) fn head_branch(dir: &Path) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .expect("rev-parse");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

pub(crate) fn branch_names(dir: &Path) -> Vec<String> {
    let out = Command::new("git")
        .current_dir(dir)
        .args(["for-each-ref", "--format=%(refname:short)", "refs/heads"])
        .output()
        .expect("for-each-ref");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .collect()
}
