//! Per-line blame and single-file history.

mod common;

use std::path::Path;
use std::process::Command;

use common::FixtureRepo;
use gitp_core::Repo;

#[test]
fn blame_attributes_each_line_to_its_last_commit() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\ntwo\n", "c1");
    fx.commit_file("a.txt", "one\nCHANGED\n", "c2"); // only line 2 changes

    let repo = Repo::open(fx.path()).unwrap();
    let lines = repo.blame("HEAD", "a.txt").unwrap();

    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].content, "one");
    assert_eq!(lines[1].content, "CHANGED");
    assert_ne!(
        lines[0].commit, lines[1].commit,
        "the two lines were last touched by different commits"
    );
    assert_eq!(lines[0].author, "Fixture Author");
}

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git").current_dir(dir).args(args).status().unwrap();
    assert!(ok.success(), "git {args:?}");
}

#[test]
fn file_history_lists_only_commits_that_touched_the_path() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "1\n", "c1 a");
    fx.commit_file("b.txt", "1\n", "c2 b"); // does not touch a.txt
    fx.commit_file("a.txt", "2\n", "c3 a");

    // Blame/history read via the `git` CLI, which needs a committer identity in
    // this repo's config — FixtureRepo already sets user.name/email.
    let repo = Repo::open(fx.path()).unwrap();
    let hist = repo.file_history("HEAD", "a.txt").unwrap();

    let summaries: Vec<&str> = hist.iter().map(|c| c.summary.as_str()).collect();
    assert_eq!(hist.len(), 2, "only the two commits that changed a.txt");
    assert_eq!(summaries, vec!["c3 a", "c1 a"], "newest first");

    // Sanity: the CLI sees the same repo the fixture built.
    git(fx.path(), &["rev-parse", "HEAD"]);
}
