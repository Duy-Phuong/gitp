//! Branch checkout and uncommitted work.
//!
//! `checkout_branch` uses git2's *safe* strategy, so a switch that would
//! overwrite local modifications must abort and change nothing. These pin that,
//! because the failure mode is silent data loss rather than a wrong number on
//! screen — the one class of bug a comment claiming "nothing was changed" isn't
//! good enough for.

mod common;

use common::FixtureRepo;
use gitp_core::Repo;

fn read(fx: &FixtureRepo, name: &str) -> String {
    std::fs::read_to_string(fx.path().join(name)).expect("file exists")
}

fn head_branch(repo: &Repo) -> String {
    repo.refs().unwrap().head.expect("on a branch")
}

/// master has `a.txt` = "master", `feature` has "feature", and HEAD is master.
fn two_branches_differing_in_a_txt() -> (FixtureRepo, Repo) {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "master\n", "c1");
    // Scoped so the borrow of fx.repo ends before fx is returned.
    {
        let c1 = fx.repo.head().unwrap().peel_to_commit().unwrap();
        fx.repo.branch("feature", &c1, false).unwrap();
    }

    let repo = Repo::open(fx.path()).unwrap();
    repo.checkout_branch("feature").unwrap();
    fx.commit_file("a.txt", "feature\n", "c2");
    repo.checkout_branch("master").unwrap();
    assert_eq!(read(&fx, "a.txt"), "master\n");
    (fx, repo)
}

#[test]
fn a_conflicting_switch_is_refused_and_keeps_the_uncommitted_work() {
    let (fx, repo) = two_branches_differing_in_a_txt();

    // Uncommitted work on the very file the two branches disagree about.
    std::fs::write(fx.path().join("a.txt"), "my precious work\n").unwrap();

    let err = repo.checkout_branch("feature").expect_err("must refuse");

    // The edit survives, byte for byte.
    assert_eq!(
        read(&fx, "a.txt"),
        "my precious work\n",
        "uncommitted changes must not be overwritten"
    );
    // And we're still on the branch we started on, not half-switched.
    assert_eq!(head_branch(&repo), "master", "HEAD must not move");
    // The message has to say what to do about it.
    let msg = err.to_string();
    assert!(
        msg.contains("uncommitted changes"),
        "unhelpful message: {msg}"
    );
    assert!(
        msg.contains("nothing was changed"),
        "unhelpful message: {msg}"
    );
}

#[test]
fn a_non_conflicting_change_carries_over_to_the_new_branch() {
    let (fx, repo) = two_branches_differing_in_a_txt();

    // Work on a file neither branch touches — git carries this across.
    std::fs::write(fx.path().join("scratch.txt"), "work in progress\n").unwrap();

    repo.checkout_branch("feature").expect("switch is allowed");

    assert_eq!(head_branch(&repo), "feature");
    assert_eq!(read(&fx, "a.txt"), "feature\n", "branch content switched");
    assert_eq!(
        read(&fx, "scratch.txt"),
        "work in progress\n",
        "unrelated work must come along, not be discarded"
    );
}

#[test]
fn an_untracked_file_the_target_branch_would_overwrite_blocks_the_switch() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    let c1 = fx.repo.head().unwrap().peel_to_commit().unwrap();
    fx.repo.branch("feature", &c1, false).unwrap();
    let repo = Repo::open(fx.path()).unwrap();

    // `feature` gains new.txt; master doesn't have it.
    repo.checkout_branch("feature").unwrap();
    fx.commit_file("new.txt", "from the branch\n", "c2");
    repo.checkout_branch("master").unwrap();
    assert!(!fx.path().join("new.txt").exists());

    // An untracked file of the same name, with different content, is still the
    // user's data — switching must not silently replace it.
    std::fs::write(fx.path().join("new.txt"), "mine, untracked\n").unwrap();

    let result = repo.checkout_branch("feature");

    assert!(result.is_err(), "must not clobber an untracked file");
    assert_eq!(
        read(&fx, "new.txt"),
        "mine, untracked\n",
        "untracked file preserved"
    );
    assert_eq!(head_branch(&repo), "master", "HEAD must not move");
}

#[test]
fn staged_but_uncommitted_work_on_a_conflicting_file_is_also_kept() {
    let (fx, repo) = two_branches_differing_in_a_txt();

    std::fs::write(fx.path().join("a.txt"), "staged work\n").unwrap();
    repo.stage("a.txt").unwrap();

    assert!(repo.checkout_branch("feature").is_err(), "must refuse");
    assert_eq!(read(&fx, "a.txt"), "staged work\n");
    assert_eq!(head_branch(&repo), "master");
    // Still staged: the index entry wasn't reset out from under the user.
    let status = repo.status_summary().unwrap();
    assert_eq!(status.staged.len(), 1, "the staged change is still staged");
    assert_eq!(status.staged[0].path, "a.txt");
}

// W2: a tag and a branch may share a name. `revparse_ext` resolves the tag
// first, and attaching HEAD to whatever came back would leave HEAD pointing at
// `refs/tags/<name>` — every later commit would then move the *tag*.
#[test]
fn checkout_prefers_the_branch_when_a_tag_has_the_same_name() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    {
        let c1 = fx.repo.head().unwrap().peel_to_commit().unwrap();
        fx.repo.branch("feature", &c1, false).unwrap();
        fx.repo
            .tag_lightweight("feature", c1.as_object(), false)
            .unwrap();
    }
    let repo = Repo::open(fx.path()).unwrap();

    repo.checkout_branch("feature").unwrap();

    let head = fx.repo.find_reference("HEAD").unwrap();
    assert_eq!(
        head.symbolic_target(),
        Some("refs/heads/feature"),
        "HEAD must attach to the branch, never to the tag"
    );
    assert_eq!(head_branch(&repo), "feature");
}

#[test]
fn checkout_of_a_tag_with_no_branch_detaches_head() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    {
        let c1 = fx.repo.head().unwrap().peel_to_commit().unwrap();
        fx.repo
            .tag_lightweight("v1", c1.as_object(), false)
            .unwrap();
    }
    fx.commit_file("a.txt", "two\n", "c2");
    let repo = Repo::open(fx.path()).unwrap();

    repo.checkout_branch("v1").unwrap();

    assert!(fx.repo.head_detached().unwrap(), "a tag checkout detaches");
    assert_eq!(read(&fx, "a.txt"), "one\n");
}

// --- Switching while a merge / rebase / cherry-pick is paused ----------------
//
// A safe checkout only refuses when files clash. When they don't, git2 would
// switch anyway and leave the operation's state behind: the pending merge then
// commits onto the branch switched to, and a continued rebase rewrites it.

fn git(dir: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git").current_dir(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// `dev` and `theirs` both change f.txt's middle line. `side` is dev's tip plus
/// an unrelated file and `side2` is theirs' tip plus one, so f.txt never
/// clashes with the branch switched to — only the paused operation can stop it.
fn paused_op_repo() -> (FixtureRepo, Repo) {
    let fx = FixtureRepo::init();
    fx.commit_file("f.txt", "a\nbase\nc\n", "c1");
    let d = fx.path();
    git(d, &["branch", "-M", "dev"]);
    git(d, &["checkout", "-q", "-b", "theirs"]);
    std::fs::write(d.join("f.txt"), "a\ntheirs\nc\n").unwrap();
    git(d, &["commit", "-qam", "theirs"]);
    git(d, &["checkout", "-q", "-b", "side2"]);
    std::fs::write(d.join("h.txt"), "h\n").unwrap();
    git(d, &["add", "h.txt"]);
    git(d, &["commit", "-qm", "side2"]);
    git(d, &["checkout", "-q", "dev"]);
    std::fs::write(d.join("f.txt"), "a\nours\nc\n").unwrap();
    git(d, &["commit", "-qam", "ours"]);
    git(d, &["checkout", "-q", "-b", "side"]);
    std::fs::write(d.join("h.txt"), "h\n").unwrap();
    git(d, &["add", "h.txt"]);
    git(d, &["commit", "-qm", "side"]);
    git(d, &["checkout", "-q", "dev"]);
    let repo = Repo::open(d).unwrap();
    (fx, repo)
}

fn assert_refused(fx: &FixtureRepo, err: gitp_core::Error, op: &str) {
    assert!(err.to_string().contains(&format!("{op} is in progress")), "{err}");
    assert_eq!(read(fx, "f.txt"), "a\nMY RESOLUTION\nc\n", "the resolution must stay");
}

#[test]
fn a_switch_mid_merge_is_refused_even_when_no_file_clashes() {
    let (fx, repo) = paused_op_repo();
    assert!(repo.merge_branch("theirs", gitp_core::MergeMode::Default).is_err());
    repo.resolve_conflict("f.txt", "a\nMY RESOLUTION\nc\n").unwrap();

    let err = repo.checkout_branch("side").expect_err("must refuse");

    assert_refused(&fx, err, "a merge");
    assert_eq!(head_branch(&repo), "dev");
    // The merge is still there to finish, on the branch it was started on.
    repo.finish_conflict("merge theirs").unwrap();
    assert_eq!(head_branch(&repo), "dev");
    let side = fx.repo.find_branch("side", git2::BranchType::Local).unwrap();
    assert_eq!(side.get().peel_to_commit().unwrap().parent_count(), 1, "side untouched");
}

#[test]
fn a_switch_mid_rebase_is_refused_even_when_no_file_clashes() {
    let (fx, repo) = paused_op_repo();
    let side2_before = fx.repo.revparse_single("side2").unwrap().id();
    assert!(repo.rebase_onto("theirs").is_err());
    repo.resolve_conflict("f.txt", "a\nMY RESOLUTION\nc\n").unwrap();

    let err = repo.checkout_branch("side2").expect_err("must refuse");

    assert_refused(&fx, err, "a rebase");
    repo.finish_conflict("").unwrap();
    assert_eq!(head_branch(&repo), "dev");
    assert_eq!(fx.repo.revparse_single("side2").unwrap().id(), side2_before, "side2 untouched");
}

#[test]
fn a_switch_mid_cherry_pick_is_refused() {
    let (fx, repo) = paused_op_repo();
    assert!(repo.cherry_pick("theirs").is_err());
    repo.resolve_conflict("f.txt", "a\nMY RESOLUTION\nc\n").unwrap();

    let err = repo.checkout_branch("side").expect_err("must refuse");

    assert_refused(&fx, err, "a cherry-pick");
}

#[test]
fn detaching_or_branching_mid_merge_is_refused_and_creates_no_branch() {
    let (fx, repo) = paused_op_repo();
    assert!(repo.merge_branch("theirs", gitp_core::MergeMode::Default).is_err());
    repo.resolve_conflict("f.txt", "a\nMY RESOLUTION\nc\n").unwrap();

    assert!(repo.checkout_commit("side").is_err(), "detach must refuse");
    assert!(repo.create_branch("fresh").is_err(), "create-and-switch must refuse");
    assert!(repo.create_branch_at("fresh2", "side").is_err());
    assert!(repo.checkout_remote("origin/side").is_err());

    assert!(fx.repo.find_branch("fresh", git2::BranchType::Local).is_err(), "no stray branch");
    assert!(fx.repo.find_branch("fresh2", git2::BranchType::Local).is_err());
    assert_eq!(head_branch(&repo), "dev");
    assert!(fx.path().join(".git/MERGE_HEAD").exists(), "the merge is still paused");
    assert_eq!(read(&fx, "f.txt"), "a\nMY RESOLUTION\nc\n");
}
