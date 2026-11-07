//! What the Clean Up Storage dialog lists.

mod common;

use std::path::Path;
use std::process::Command;

use common::FixtureRepo;
use gitp_core::{disk_usage, Repo};

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

#[test]
fn branches_the_default_branch_contains_are_merged_and_others_are_not() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "1\n", "one");
    git(fx.path(), &["branch", "-M", "main"]);
    git(fx.path(), &["branch", "old"]); // at main's tip
    git(fx.path(), &["checkout", "-q", "-b", "feature"]);
    fx.commit_file("b.txt", "2\n", "two");
    git(fx.path(), &["checkout", "-q", "main"]);
    git(fx.path(), &["merge", "-q", "--ff-only", "feature"]);
    git(fx.path(), &["checkout", "-q", "-b", "open-work"]);
    fx.commit_file("c.txt", "3\n", "three");
    git(fx.path(), &["checkout", "-q", "main"]);

    let merged = Repo::open(fx.path()).unwrap().merged_branches().unwrap();
    assert_eq!(merged.base, "main");
    assert_eq!(merged.branches, vec!["feature", "old"]);
}

#[test]
fn build_folders_are_found_a_few_levels_down_but_not_inside_each_other() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "1\n", "one");
    for d in [
        "target/debug",
        "crates/app/webui/node_modules/x/node_modules",
        "deep/a/b/c/d/target",
    ] {
        std::fs::create_dir_all(fx.path().join(d)).unwrap();
    }
    let found = Repo::open(fx.path()).unwrap().build_folders().unwrap();
    let rel: Vec<String> = found
        .iter()
        .map(|p| {
            p.strip_prefix(fx.path().canonicalize().unwrap())
                .unwrap_or(p)
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert_eq!(rel, vec!["crates/app/webui/node_modules", "target"]);
}

#[test]
fn disk_usage_counts_a_folders_files() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("f"), vec![7u8; 64 * 1024]).unwrap();
    assert!(disk_usage(dir.path()).unwrap() >= 64 * 1024);
}
