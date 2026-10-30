//! Merge/rebase conflict resolution: detect an in-progress conflict, read the
//! three sides of a conflicted file, mark files resolved, and finish or abort.

mod common;

use std::path::Path;
use std::process::Command;

use common::FixtureRepo;
use gitp_core::{MergeMode, Repo};

/// Run `git <args>` in `dir`, asserting success (test setup helper).
fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// Build a repo whose `dev` and `theirs` branches both changed the middle line
/// of `f.txt`, then start merging `theirs` into `dev` so a conflict is live.
fn conflicted_repo() -> FixtureRepo {
    let fx = FixtureRepo::init();
    fx.commit_file("f.txt", "a\nbase\nc\n", "c1");
    let dir = fx.path();
    // Name the current branch deterministically regardless of init.defaultBranch.
    git(dir, &["branch", "-M", "dev"]);
    git(dir, &["checkout", "-b", "theirs"]);
    std::fs::write(dir.join("f.txt"), "a\ntheirs\nc\n").unwrap();
    git(dir, &["commit", "-am", "theirs change"]);
    git(dir, &["checkout", "dev"]);
    std::fs::write(dir.join("f.txt"), "a\nours\nc\n").unwrap();
    git(dir, &["commit", "-am", "ours change"]);
    // Start the merge — it conflicts and leaves the merge in progress.
    let repo = Repo::open(dir).unwrap();
    assert!(
        repo.merge_branch("theirs", MergeMode::Default).is_err(),
        "merge should conflict"
    );
    fx
}

#[test]
fn conflict_status_reports_a_merge_in_progress_with_the_conflicted_file() {
    let fx = conflicted_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let status = repo.conflict_status().unwrap();
    assert_eq!(status.kind, "merge");
    assert_eq!(status.conflicted, vec!["f.txt"]);
    assert!(
        !status.message.is_empty(),
        "a default merge message is available"
    );
}

#[test]
fn conflict_sides_reads_ours_theirs_and_working_versions() {
    let fx = conflicted_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let sides = repo.conflict_sides("f.txt").unwrap();
    assert!(
        sides.ours.as_deref().unwrap().contains("ours"),
        "ours side is HEAD's version"
    );
    assert!(
        sides.theirs.as_deref().unwrap().contains("theirs"),
        "theirs side is the incoming version"
    );
    assert!(
        sides.working.contains("<<<<<<<") && sides.working.contains(">>>>>>>"),
        "working file has markers"
    );
    assert!(!sides.binary);
}

#[test]
fn resolve_conflict_clears_the_file_and_finish_commits_the_merge() {
    let fx = conflicted_repo();
    let repo = Repo::open(fx.path()).unwrap();

    repo.resolve_conflict("f.txt", "a\nresolved\nc\n").unwrap();
    assert!(
        repo.conflict_status().unwrap().conflicted.is_empty(),
        "no conflicts left after resolve"
    );

    repo.finish_conflict("Merge theirs into dev").unwrap();

    // Merge is done: no conflict session, and the merge commit is HEAD.
    assert_eq!(repo.conflict_status().unwrap().kind, "none");
    assert_eq!(
        std::fs::read_to_string(fx.path().join("f.txt")).unwrap(),
        "a\nresolved\nc\n"
    );
    let head = repo.commit_detail("HEAD").unwrap();
    assert_eq!(
        head.parents.len(),
        2,
        "a two-parent merge commit was created"
    );
}

#[test]
fn abort_conflict_restores_the_pre_merge_state() {
    let fx = conflicted_repo();
    let repo = Repo::open(fx.path()).unwrap();

    repo.abort_conflict().unwrap();

    assert_eq!(repo.conflict_status().unwrap().kind, "none");
    assert_eq!(
        std::fs::read_to_string(fx.path().join("f.txt")).unwrap(),
        "a\nours\nc\n",
        "back to ours"
    );
}

#[test]
fn conflict_status_is_none_on_a_clean_repo() {
    let fx = FixtureRepo::init();
    fx.commit_file("f.txt", "hi\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    assert_eq!(repo.conflict_status().unwrap().kind, "none");
}

/// A repo where cherry-picking `feature`'s tip commit onto `dev` conflicts on
/// `f.txt`, leaving CHERRY_PICK_HEAD (not MERGE_HEAD or a rebase directory).
fn conflicted_cherry_pick_repo() -> (FixtureRepo, String) {
    let fx = FixtureRepo::init();
    fx.commit_file("f.txt", "a\nbase\nc\n", "c1");
    let dir = fx.path();
    git(dir, &["branch", "-M", "dev"]);
    git(dir, &["checkout", "-b", "feature"]);
    std::fs::write(dir.join("f.txt"), "a\nfeature\nc\n").unwrap();
    git(dir, &["commit", "-am", "feature change"]);
    let pick = String::from_utf8(
        Command::new("git")
            .current_dir(dir)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string();
    git(dir, &["checkout", "dev"]);
    std::fs::write(dir.join("f.txt"), "a\ndev\nc\n").unwrap();
    git(dir, &["commit", "-am", "dev change"]);

    let repo = Repo::open(dir).unwrap();
    assert!(
        repo.cherry_pick(&pick).is_err(),
        "cherry-pick should conflict"
    );
    (fx, pick)
}

#[test]
fn conflict_status_reports_a_cherry_pick_in_progress_with_the_conflicted_file() {
    let (fx, _) = conflicted_cherry_pick_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let status = repo.conflict_status().unwrap();
    assert_eq!(status.kind, "cherry-pick");
    assert_eq!(status.conflicted, vec!["f.txt"]);
}

#[test]
fn resolve_conflict_clears_the_file_and_finish_continues_the_cherry_pick() {
    let (fx, pick) = conflicted_cherry_pick_repo();
    let repo = Repo::open(fx.path()).unwrap();

    repo.resolve_conflict("f.txt", "a\nresolved\nc\n").unwrap();
    assert!(repo.conflict_status().unwrap().conflicted.is_empty());

    // GIT_EDITOR=true must auto-accept the reused commit message — there's no
    // TTY here, so a real prompt would fail this call.
    repo.finish_conflict("").unwrap();

    assert_eq!(repo.conflict_status().unwrap().kind, "none");
    assert_eq!(
        std::fs::read_to_string(fx.path().join("f.txt")).unwrap(),
        "a\nresolved\nc\n"
    );
    let head = repo.commit_detail("HEAD").unwrap();
    assert_eq!(
        head.parents.len(),
        1,
        "cherry-pick creates a single-parent commit, not a merge"
    );
    assert_ne!(
        head.id, pick,
        "a new commit was created on dev, not the original"
    );
}

#[test]
fn abort_conflict_restores_the_pre_cherry_pick_state() {
    let (fx, _) = conflicted_cherry_pick_repo();
    let repo = Repo::open(fx.path()).unwrap();

    repo.abort_conflict().unwrap();

    assert_eq!(repo.conflict_status().unwrap().kind, "none");
    assert_eq!(
        std::fs::read_to_string(fx.path().join("f.txt")).unwrap(),
        "a\ndev\nc\n",
        "back to dev's version"
    );
}

/// `dev` deleted `f.txt`, `theirs` modified it; merging `theirs` into `dev`
/// leaves a delete/modify (`DU`) conflict.
fn delete_modify_conflicted_repo() -> FixtureRepo {
    let fx = FixtureRepo::init();
    fx.commit_file("f.txt", "a\nbase\nc\n", "c1");
    fx.commit_file("keep.txt", "k\n", "c1b");
    let dir = fx.path();
    git(dir, &["branch", "-M", "dev"]);
    git(dir, &["checkout", "-b", "theirs"]);
    std::fs::write(dir.join("f.txt"), "a\ntheirs\nc\n").unwrap();
    git(dir, &["commit", "-am", "theirs change"]);
    git(dir, &["checkout", "dev"]);
    git(dir, &["rm", "-q", "f.txt"]);
    git(dir, &["commit", "-m", "ours delete"]);
    let repo = Repo::open(dir).unwrap();
    assert!(
        repo.merge_branch("theirs", MergeMode::Default).is_err(),
        "merge should conflict"
    );
    fx
}

// C2: taking the side that deleted the file has no stage to `checkout`; it
// must resolve as a deletion rather than fail (or write an empty file).
#[test]
fn resolve_conflict_side_with_the_deleting_side_removes_the_file() {
    let fx = delete_modify_conflicted_repo();
    let repo = Repo::open(fx.path()).unwrap();
    assert_eq!(repo.conflict_status().unwrap().conflicted, vec!["f.txt"]);
    assert!(repo.conflict_sides("f.txt").unwrap().ours.is_none());

    repo.resolve_conflict_side("f.txt", true)
        .expect("take ours (the deletion)");

    assert!(!fx.path().join("f.txt").exists(), "file is gone");
    assert!(
        repo.conflict_status().unwrap().conflicted.is_empty(),
        "no unmerged paths left"
    );
    repo.finish_conflict("merge").unwrap();
    assert_eq!(repo.conflict_status().unwrap().kind, "none");
}

#[test]
fn resolve_conflict_side_with_the_modifying_side_keeps_their_version() {
    let fx = delete_modify_conflicted_repo();
    let repo = Repo::open(fx.path()).unwrap();

    repo.resolve_conflict_side("f.txt", false)
        .expect("take theirs");

    assert_eq!(
        std::fs::read_to_string(fx.path().join("f.txt")).unwrap(),
        "a\ntheirs\nc\n"
    );
    assert!(repo.conflict_status().unwrap().conflicted.is_empty());
}

// C8: HEAD is detached during a rebase, so the branch being rebased has to be
// read from git's rebase state, not from HEAD.
#[test]
fn conflict_status_names_the_rebased_branch_during_a_rebase() {
    let fx = FixtureRepo::init();
    fx.commit_file("f.txt", "base\n", "c1");
    let dir = fx.path();
    git(dir, &["branch", "-M", "side"]);
    git(dir, &["checkout", "-b", "target"]);
    std::fs::write(dir.join("f.txt"), "target\n").unwrap();
    git(dir, &["commit", "-am", "target change"]);
    git(dir, &["checkout", "side"]);
    std::fs::write(dir.join("f.txt"), "side\n").unwrap();
    git(dir, &["commit", "-am", "side change"]);

    let repo = Repo::open(dir).unwrap();
    assert!(
        repo.rebase_onto("target").is_err(),
        "rebase should conflict"
    );

    let status = repo.conflict_status().unwrap();
    assert_eq!(status.kind, "rebase");
    assert_eq!(status.summary, "Rebasing side");
    assert_eq!(status.conflicted, vec!["f.txt"]);
}

// C10: an unmerged file is one conflict, not a "Modified" entry in both lists.
#[test]
fn status_summary_lists_an_unmerged_file_once_as_conflicted() {
    let fx = conflicted_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let s = repo.status_summary().unwrap();
    assert!(
        s.staged.is_empty(),
        "no staged entry for the conflict: {:?}",
        s.staged
    );
    assert_eq!(s.unstaged.len(), 1);
    assert_eq!(s.unstaged[0].path, "f.txt");
    assert_eq!(s.unstaged[0].status, gitp_core::ChangeKind::Conflicted);
    assert_eq!(repo.local_change_count().unwrap(), 1);
}

// --- Squash merge ------------------------------------------------------------

/// Like `conflicted_repo`, but squash-merging `theirs`: git writes SQUASH_MSG
/// and the conflicted file, and no MERGE_HEAD.
fn squash_conflicted_repo() -> FixtureRepo {
    let fx = FixtureRepo::init();
    fx.commit_file("f.txt", "a\nbase\nc\n", "c1");
    let dir = fx.path();
    git(dir, &["branch", "-M", "dev"]);
    git(dir, &["checkout", "-b", "theirs"]);
    std::fs::write(dir.join("f.txt"), "a\ntheirs\nc\n").unwrap();
    git(dir, &["commit", "-am", "theirs change"]);
    git(dir, &["checkout", "dev"]);
    std::fs::write(dir.join("f.txt"), "a\nours\nc\n").unwrap();
    git(dir, &["commit", "-am", "ours change"]);
    let repo = Repo::open(dir).unwrap();
    assert!(
        repo.merge_branch("theirs", MergeMode::Squash).is_err(),
        "squash should conflict"
    );
    assert!(!dir.join(".git/MERGE_HEAD").exists());
    assert!(dir.join(".git/SQUASH_MSG").exists());
    fx
}

#[test]
fn a_conflicted_squash_merge_is_reported_as_a_merge_session() {
    let fx = squash_conflicted_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let status = repo.conflict_status().unwrap();
    assert_eq!(status.kind, "merge");
    assert_eq!(status.conflicted, vec!["f.txt"]);
    assert!(status.summary.contains("Squash"), "{}", status.summary);
    assert!(
        status.message.contains("theirs change"),
        "the squash message lists the squashed commits: {}",
        status.message
    );
}

#[test]
fn finishing_a_squash_merge_commits_one_parent_with_the_message() {
    let fx = squash_conflicted_repo();
    let repo = Repo::open(fx.path()).unwrap();

    repo.resolve_conflict("f.txt", "a\nresolved\nc\n").unwrap();
    // Still a session once every file is resolved, so Finish stays reachable.
    assert_eq!(repo.conflict_status().unwrap().kind, "merge");
    repo.finish_conflict("Squash theirs").unwrap();

    assert_eq!(repo.conflict_status().unwrap().kind, "none");
    assert!(!fx.path().join(".git/SQUASH_MSG").exists());
    let head = repo.commit_detail("HEAD").unwrap();
    assert_eq!(head.parents.len(), 1, "a squash is an ordinary commit");
    assert_eq!(head.message.trim(), "Squash theirs");
    assert_eq!(
        std::fs::read_to_string(fx.path().join("f.txt")).unwrap(),
        "a\nresolved\nc\n"
    );
}

#[test]
fn aborting_a_squash_merge_restores_the_branch() {
    let fx = squash_conflicted_repo();
    let repo = Repo::open(fx.path()).unwrap();

    repo.abort_conflict().unwrap();

    assert_eq!(repo.conflict_status().unwrap().kind, "none");
    assert!(!fx.path().join(".git/SQUASH_MSG").exists());
    assert_eq!(
        std::fs::read_to_string(fx.path().join("f.txt")).unwrap(),
        "a\nours\nc\n"
    );
    assert_eq!(repo.local_change_count().unwrap(), 0, "nothing left behind");
}

#[test]
fn conflict_sides_flags_a_working_file_edited_since_the_conflict() {
    let fx = conflicted_repo();
    let repo = Repo::open(fx.path()).unwrap();
    assert!(
        !repo.conflict_sides("f.txt").unwrap().edited,
        "git's marked-up merge"
    );

    // One side's version as is, the way git leaves binary files: not an edit.
    git(fx.path(), &["checkout", "--ours", "--", "f.txt"]);
    assert!(!repo.conflict_sides("f.txt").unwrap().edited);

    // Hand-resolved in an editor: taking a side would overwrite this.
    std::fs::write(fx.path().join("f.txt"), "a\nhand-made\nc\n").unwrap();
    assert!(repo.conflict_sides("f.txt").unwrap().edited);
}
