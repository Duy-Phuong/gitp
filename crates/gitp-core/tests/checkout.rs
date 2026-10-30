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
    let out = std::process::Command::new("git")
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
    assert!(
        err.to_string().contains(&format!("{op} is in progress")),
        "{err}"
    );
    assert_eq!(
        read(fx, "f.txt"),
        "a\nMY RESOLUTION\nc\n",
        "the resolution must stay"
    );
}

#[test]
fn a_switch_mid_merge_is_refused_even_when_no_file_clashes() {
    let (fx, repo) = paused_op_repo();
    assert!(repo
        .merge_branch("theirs", gitp_core::MergeMode::Default)
        .is_err());
    repo.resolve_conflict("f.txt", "a\nMY RESOLUTION\nc\n")
        .unwrap();

    let err = repo.checkout_branch("side").expect_err("must refuse");

    assert_refused(&fx, err, "a merge");
    assert_eq!(head_branch(&repo), "dev");
    // The merge is still there to finish, on the branch it was started on.
    repo.finish_conflict("merge theirs").unwrap();
    assert_eq!(head_branch(&repo), "dev");
    let side = fx
        .repo
        .find_branch("side", git2::BranchType::Local)
        .unwrap();
    assert_eq!(
        side.get().peel_to_commit().unwrap().parent_count(),
        1,
        "side untouched"
    );
}

#[test]
fn a_switch_mid_rebase_is_refused_even_when_no_file_clashes() {
    let (fx, repo) = paused_op_repo();
    let side2_before = fx.repo.revparse_single("side2").unwrap().id();
    assert!(repo.rebase_onto("theirs").is_err());
    repo.resolve_conflict("f.txt", "a\nMY RESOLUTION\nc\n")
        .unwrap();

    let err = repo.checkout_branch("side2").expect_err("must refuse");

    assert_refused(&fx, err, "a rebase");
    repo.finish_conflict("").unwrap();
    assert_eq!(head_branch(&repo), "dev");
    assert_eq!(
        fx.repo.revparse_single("side2").unwrap().id(),
        side2_before,
        "side2 untouched"
    );
}

#[test]
fn a_switch_mid_cherry_pick_is_refused() {
    let (fx, repo) = paused_op_repo();
    assert!(repo.cherry_pick("theirs").is_err());
    repo.resolve_conflict("f.txt", "a\nMY RESOLUTION\nc\n")
        .unwrap();

    let err = repo.checkout_branch("side").expect_err("must refuse");

    assert_refused(&fx, err, "a cherry-pick");
}

#[test]
fn detaching_or_branching_mid_merge_is_refused_and_creates_no_branch() {
    let (fx, repo) = paused_op_repo();
    assert!(repo
        .merge_branch("theirs", gitp_core::MergeMode::Default)
        .is_err());
    repo.resolve_conflict("f.txt", "a\nMY RESOLUTION\nc\n")
        .unwrap();

    assert!(repo.checkout_commit("side").is_err(), "detach must refuse");
    assert!(
        repo.create_branch("fresh").is_err(),
        "create-and-switch must refuse"
    );
    assert!(repo.create_branch_at("fresh2", "side").is_err());
    assert!(repo.checkout_remote("origin/side").is_err());

    assert!(
        fx.repo
            .find_branch("fresh", git2::BranchType::Local)
            .is_err(),
        "no stray branch"
    );
    assert!(fx
        .repo
        .find_branch("fresh2", git2::BranchType::Local)
        .is_err());
    assert_eq!(head_branch(&repo), "dev");
    assert!(
        fx.path().join(".git/MERGE_HEAD").exists(),
        "the merge is still paused"
    );
    assert_eq!(read(&fx, "f.txt"), "a\nMY RESOLUTION\nc\n");
}

// A squash writes no MERGE_HEAD, only SQUASH_MSG and a staged result — which a
// switch would carry over to be committed on the other branch.
#[test]
fn a_switch_with_a_squash_merge_pending_is_refused() {
    let (fx, repo) = paused_op_repo();
    repo.merge_branch("side", gitp_core::MergeMode::Squash)
        .unwrap();

    let err = repo.checkout_branch("side2").expect_err("must refuse");
    assert!(
        err.to_string().contains("a squash merge is in progress"),
        "{err}"
    );
    let err = repo
        .stash_and_switch("side2", |r| {
            r.checkout_branch("side2").map(|()| String::new())
        })
        .expect_err("must refuse");
    assert!(
        err.to_string().contains("a squash merge is in progress"),
        "{err}"
    );

    assert_eq!(head_branch(&repo), "dev");
    assert!(
        fx.path().join(".git/SQUASH_MSG").exists(),
        "the squash is still pending"
    );
    assert_eq!(read(&fx, "h.txt"), "h\n");
}

// One whose staged result was thrown away is only a leftover message: it must
// neither block the switch nor follow it to the other branch.
#[test]
fn a_stale_squash_msg_does_not_block_a_switch_and_is_dropped() {
    let (fx, repo) = paused_op_repo();
    repo.merge_branch("side", gitp_core::MergeMode::Squash)
        .unwrap();
    git(fx.path(), &["rm", "-q", "-f", "h.txt"]);

    repo.checkout_branch("side2").unwrap();

    assert_eq!(head_branch(&repo), "side2");
    assert!(!fx.path().join(".git/SQUASH_MSG").exists());
}

// --- Stash & Switch ----------------------------------------------------------

fn stash_count(fx: &FixtureRepo) -> usize {
    let mut repo = git2::Repository::open(fx.path()).unwrap();
    let mut n = 0;
    repo.stash_foreach(|_, _, _| {
        n += 1;
        true
    })
    .unwrap();
    n
}

#[test]
fn stash_and_switch_carries_clashing_work_over_and_drops_the_stash() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "1\n2\n3\n4\n5\n", "c1");
    {
        let c1 = fx.repo.head().unwrap().peel_to_commit().unwrap();
        fx.repo.branch("feature", &c1, false).unwrap();
    }
    let repo = Repo::open(fx.path()).unwrap();
    repo.checkout_branch("feature").unwrap();
    fx.commit_file("a.txt", "ONE\n2\n3\n4\n5\n", "c2");
    repo.checkout_branch("master").unwrap();

    // An edit to a file the branches disagree about blocks a plain switch…
    std::fs::write(fx.path().join("a.txt"), "1\n2\n3\n4\nFIVE\n").unwrap();
    std::fs::write(fx.path().join("new.txt"), "untracked\n").unwrap();
    assert!(repo.checkout_branch("feature").is_err());

    // …but stashed, switched and popped, it merges into feature's version.
    let out = repo
        .stash_and_switch("feature", |r| {
            r.checkout_branch("feature").map(|()| String::new())
        })
        .unwrap();

    assert!(!out.stash_kept);
    assert_eq!(head_branch(&repo), "feature");
    assert_eq!(read(&fx, "a.txt"), "ONE\n2\n3\n4\nFIVE\n");
    assert_eq!(
        read(&fx, "new.txt"),
        "untracked\n",
        "untracked files come along"
    );
    assert_eq!(
        stash_count(&fx),
        0,
        "the auto-stash is dropped once re-applied"
    );
}

#[test]
fn stash_and_switch_keeps_the_stash_when_re_applying_conflicts() {
    let (fx, repo) = two_branches_differing_in_a_txt();
    std::fs::write(fx.path().join("a.txt"), "my precious work\n").unwrap();

    let out = repo
        .stash_and_switch("feature", |r| {
            r.checkout_branch("feature").map(|()| String::new())
        })
        .unwrap();

    assert!(out.stash_kept, "a conflicting pop must be reported");
    assert_eq!(head_branch(&repo), "feature", "the switch itself happened");
    assert!(
        read(&fx, "a.txt").contains("<<<<<<<"),
        "conflict markers left to resolve"
    );
    // git keeps the entry when the pop conflicts — the work is still there.
    assert_eq!(stash_count(&fx), 1);
    let message = repo.stash_message(0).unwrap();
    assert!(
        message.contains("Auto-stash before switching to feature"),
        "{message}"
    );
}

#[test]
fn stash_and_switch_puts_the_work_back_when_the_switch_fails() {
    let (fx, repo) = two_branches_differing_in_a_txt();
    std::fs::write(fx.path().join("a.txt"), "my precious work\n").unwrap();
    std::fs::write(fx.path().join("new.txt"), "untracked\n").unwrap();
    std::fs::write(fx.path().join("staged.txt"), "staged\n").unwrap();
    {
        let mut index = fx.repo.index().unwrap();
        index.add_path(std::path::Path::new("staged.txt")).unwrap();
        index.write().unwrap();
    }

    let err = repo
        .stash_and_switch("nope", |r| {
            r.checkout_branch("nope").map(|()| String::new())
        })
        .expect_err("no such branch");

    assert!(err.to_string().contains("put back"), "{err}");
    assert_eq!(head_branch(&repo), "master");
    assert_eq!(read(&fx, "a.txt"), "my precious work\n");
    assert_eq!(read(&fx, "new.txt"), "untracked\n");
    assert_eq!(stash_count(&fx), 0, "nothing left behind in the stash");
    let staged = git2::Repository::open(fx.path())
        .unwrap()
        .status_file(std::path::Path::new("staged.txt"))
        .unwrap();
    assert!(
        staged.contains(git2::Status::INDEX_NEW),
        "staged work stays staged"
    );
}

/// What the index and the working tree hold for `name`: (staged, on disk).
fn staged_and_worktree(fx: &FixtureRepo, name: &str) -> (String, String) {
    let index = git2::Repository::open(fx.path()).unwrap().index().unwrap();
    let entry = index
        .get_path(std::path::Path::new(name), 0)
        .expect("in the index");
    let blob = fx.repo.find_blob(entry.id).unwrap();
    (
        String::from_utf8(blob.content().to_vec()).unwrap(),
        read(fx, name),
    )
}

fn stage(fx: &FixtureRepo, name: &str, contents: &str) {
    std::fs::write(fx.path().join(name), contents).unwrap();
    let mut index = fx.repo.index().unwrap();
    // fx.repo's index is cached from before the checkouts `Repo` made.
    index.read(true).unwrap();
    index.add_path(std::path::Path::new(name)).unwrap();
    index.write().unwrap();
}

#[test]
fn stash_and_switch_keeps_what_was_staged_apart_from_what_was_not() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "c1");
    {
        let c1 = fx.repo.head().unwrap().peel_to_commit().unwrap();
        fx.repo.branch("feature", &c1, false).unwrap();
    }
    let repo = Repo::open(fx.path()).unwrap();
    repo.checkout_branch("feature").unwrap();
    fx.commit_file("other.txt", "feature\n", "c2");
    repo.checkout_branch("master").unwrap();
    // One file, half of its edits staged.
    stage(&fx, "a.txt", "1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\n");
    std::fs::write(
        fx.path().join("a.txt"),
        "1\nTWO\n3\n4\n5\n6\n7\n8\nNINE\n10\n",
    )
    .unwrap();

    let out = repo
        .stash_and_switch("feature", |r| {
            r.checkout_branch("feature").map(|()| String::new())
        })
        .unwrap();

    assert!(!out.stash_kept && !out.staging_lost, "{out:?}");
    assert_eq!(head_branch(&repo), "feature");
    assert_eq!(
        staged_and_worktree(&fx, "a.txt"),
        (
            "1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\n".to_string(),
            "1\nTWO\n3\n4\n5\n6\n7\n8\nNINE\n10\n".to_string()
        ),
        "the staged half stays staged, the rest stays unstaged"
    );
    assert_eq!(stash_count(&fx), 0);
}

#[test]
fn stash_and_switch_re_applies_unstaged_when_the_staging_cannot_be_restored() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "c1");
    {
        let c1 = fx.repo.head().unwrap().peel_to_commit().unwrap();
        fx.repo.branch("feature", &c1, false).unwrap();
    }
    let repo = Repo::open(fx.path()).unwrap();
    repo.checkout_branch("feature").unwrap();
    // Close enough to the staged edit to break its patch's context, far
    // enough for a three-way merge of the working tree to succeed.
    fx.commit_file("a.txt", "ONE\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "c2");
    repo.checkout_branch("master").unwrap();
    stage(&fx, "a.txt", "1\n2\n3\nFOUR\n5\n6\n7\n8\n9\n10\n");

    let out = repo
        .stash_and_switch("feature", |r| {
            r.checkout_branch("feature").map(|()| String::new())
        })
        .unwrap();

    assert!(!out.stash_kept, "{out:?}");
    assert!(out.staging_lost, "{out:?}");
    assert_eq!(head_branch(&repo), "feature");
    assert_eq!(
        staged_and_worktree(&fx, "a.txt"),
        (
            "ONE\n2\n3\n4\n5\n6\n7\n8\n9\n10\n".to_string(),
            "ONE\n2\n3\nFOUR\n5\n6\n7\n8\n9\n10\n".to_string()
        ),
        "the work comes back, unstaged"
    );
    assert_eq!(stash_count(&fx), 0);
}
