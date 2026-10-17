//! The reflog view: commits, checkouts, resets and amends each leave an entry,
//! newest first, for HEAD and for a single branch.

mod common;

use std::process::Command;

use common::FixtureRepo;
use gitp_core::{Repo, ResetMode};

fn git(fx: &FixtureRepo, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(fx.path())
        .args(args)
        .status()
        .expect("run git");
    assert!(status.success(), "git {args:?} failed");
}

/// Write `name` and commit it through the git CLI (so the reflog messages are
/// git's own), returning the new HEAD id.
fn commit(fx: &FixtureRepo, repo: &Repo, name: &str, message: &str) -> String {
    std::fs::write(fx.path().join(name), message).unwrap();
    git(fx, &["add", name]);
    repo.commit(message, "", false).unwrap();
    repo.resolve_commit("HEAD").unwrap()
}

#[test]
fn head_reflog_lists_commit_checkout_reset_and_amend_newest_first() {
    let fx = FixtureRepo::init();
    let repo = Repo::open(fx.path()).unwrap();
    let c1 = commit(&fx, &repo, "a.txt", "first");
    let c2 = commit(&fx, &repo, "b.txt", "second");
    let branch = repo.head_ref_name().unwrap();
    repo.checkout_commit(&c1).unwrap();
    git(&fx, &["checkout", "-q", &branch]);
    repo.reset(&c1, ResetMode::Hard).unwrap();
    repo.commit("first, amended", "", true).unwrap();
    let amended = repo.resolve_commit("HEAD").unwrap();

    let entries = repo.reflog("HEAD", 100).unwrap();
    let messages: Vec<&str> = entries.iter().map(|e| e.message.as_str()).collect();
    assert_eq!(messages.len(), 6, "{messages:?}");
    assert!(messages[0].starts_with("commit (amend): first, amended"));
    assert!(messages[1].starts_with("reset: moving to "));
    assert_eq!(
        messages[2],
        format!("checkout: moving from {c1} to {branch}")
    );
    assert_eq!(
        messages[3],
        format!("checkout: moving from {branch} to {c1}")
    );
    assert!(messages[4].starts_with("commit: second"));
    assert!(messages[5].starts_with("commit (initial): first"));

    let newest = &entries[0];
    assert_eq!(newest.index, 0);
    assert_eq!(newest.selector, "HEAD@{0}");
    assert_eq!(newest.new_id, amended);
    assert_eq!(newest.old_id, c1);
    assert_eq!(newest.short_id, amended[..7]);
    assert_eq!(newest.summary.as_deref(), Some("first, amended"));
    assert_eq!(newest.committer, "Fixture Author");
    assert!(newest.time > 0);

    assert_eq!(entries[4].new_id, c2);
    assert_eq!(entries[4].selector, "HEAD@{4}");
    assert_eq!(
        entries[5].old_id,
        "0".repeat(40),
        "the first entry has no old id"
    );
}

#[test]
fn limit_caps_the_entry_count_keeping_the_newest() {
    let fx = FixtureRepo::init();
    let repo = Repo::open(fx.path()).unwrap();
    commit(&fx, &repo, "a.txt", "one");
    commit(&fx, &repo, "b.txt", "two");
    let c3 = commit(&fx, &repo, "c.txt", "three");

    let entries = repo.reflog("HEAD", 2).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].new_id, c3);
}

#[test]
fn branch_reflog_only_has_that_branchs_moves() {
    let fx = FixtureRepo::init();
    let repo = Repo::open(fx.path()).unwrap();
    commit(&fx, &repo, "a.txt", "one");
    let main = repo.head_ref_name().unwrap();
    git(&fx, &["checkout", "-q", "-b", "topic"]);
    let t1 = commit(&fx, &repo, "b.txt", "on topic");
    repo.checkout_branch(&main).unwrap();

    let entries = repo.reflog("refs/heads/topic", 100).unwrap();
    assert_eq!(entries.len(), 2, "branch creation and one commit");
    assert_eq!(entries[0].new_id, t1);
    assert_eq!(entries[0].selector, "topic@{0}");
    assert!(entries[0].message.starts_with("commit: on topic"));
    assert!(
        entries.iter().all(|e| !e.message.starts_with("checkout:")),
        "HEAD's checkouts aren't in a branch's reflog"
    );
}

#[test]
fn a_ref_without_a_reflog_yields_no_entries() {
    let fx = FixtureRepo::init();
    let repo = Repo::open(fx.path()).unwrap();
    // A fresh repo: HEAD is unborn and has no log yet.
    assert!(repo.reflog("HEAD", 100).unwrap().is_empty());

    commit(&fx, &repo, "a.txt", "one");
    assert!(repo.reflog("refs/heads/nope", 100).unwrap().is_empty());
}

#[test]
fn an_entry_whose_commit_was_pruned_has_no_summary() {
    let fx = FixtureRepo::init();
    let repo = Repo::open(fx.path()).unwrap();
    commit(&fx, &repo, "a.txt", "one");
    let doomed = commit(&fx, &repo, "b.txt", "two");
    repo.reset("HEAD~1", ResetMode::Hard).unwrap();
    // Expire every reflog entry and prune, so the commit object is really gone,
    // then write back a reflog line that still names it.
    git(&fx, &["reflog", "expire", "--expire=now", "--all"]);
    git(&fx, &["gc", "-q", "--prune=now"]);
    let head = repo.resolve_commit("HEAD").unwrap();
    let log = fx.path().join(".git/logs/HEAD");
    let line = format!(
        "{head} {doomed} Fixture Author <author@example.com> 1700000000 +0000\treset: moving to {doomed}\n"
    );
    std::fs::write(&log, line).unwrap();
    assert!(
        fx.repo
            .find_commit(git2::Oid::from_str(&doomed).unwrap())
            .is_err(),
        "the commit really is gone"
    );

    let repo = Repo::open(fx.path()).unwrap();
    let entries = repo.reflog("HEAD", 100).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].new_id, doomed);
    assert_eq!(entries[0].summary, None);
    assert_eq!(entries[0].time, 1_700_000_000);
}
