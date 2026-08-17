//! Per-hunk staging: stage / unstage / discard a single block of a file.

mod common;

use common::FixtureRepo;
use gitp_core::Repo;

/// A file with two well-separated change regions, so its diff has two hunks.
fn two_hunk_repo() -> FixtureRepo {
    let fx = FixtureRepo::init();
    // 12 numbered lines committed…
    let base: String = (1..=12).map(|n| format!("line {n}\n")).collect();
    fx.commit_file("f.txt", &base, "base");
    // …then edit line 2 (top) and line 11 (bottom): two separate hunks.
    let edited = base.replace("line 2\n", "LINE 2 CHANGED\n").replace("line 11\n", "LINE 11 CHANGED\n");
    std::fs::write(fx.path().join("f.txt"), edited).unwrap();
    fx
}

#[test]
fn stage_hunk_stages_only_that_block() {
    let fx = two_hunk_repo();
    let repo = Repo::open(fx.path()).unwrap();

    assert_eq!(repo.file_diff("f.txt", false).unwrap().unwrap().hunks.len(), 2, "two unstaged hunks");

    // Stage only the first hunk (the top edit).
    repo.stage_hunk("f.txt", 0).unwrap();

    // One hunk staged, one still unstaged.
    let staged = repo.file_diff("f.txt", true).unwrap().expect("something staged");
    let unstaged = repo.file_diff("f.txt", false).unwrap().expect("something still unstaged");
    assert_eq!(staged.hunks.len(), 1, "exactly one hunk staged");
    assert_eq!(unstaged.hunks.len(), 1, "the other hunk stays unstaged");
    // The staged hunk is the top one (line 2), not the bottom.
    let staged_text: String = staged.hunks[0].lines.iter().map(|l| l.content.as_str()).collect();
    assert!(staged_text.contains("LINE 2 CHANGED"), "top edit was staged");
    assert!(!staged_text.contains("LINE 11 CHANGED"), "bottom edit was not staged");
}

#[test]
fn unstage_hunk_moves_one_block_back_to_the_working_tree() {
    let fx = two_hunk_repo();
    let repo = Repo::open(fx.path()).unwrap();
    repo.stage_all().unwrap();
    assert_eq!(repo.file_diff("f.txt", true).unwrap().unwrap().hunks.len(), 2, "both staged");

    repo.unstage_hunk("f.txt", 0).unwrap();

    assert_eq!(repo.file_diff("f.txt", true).unwrap().unwrap().hunks.len(), 1, "one hunk left staged");
    assert_eq!(repo.file_diff("f.txt", false).unwrap().unwrap().hunks.len(), 1, "one hunk back unstaged");
}

#[test]
fn discard_hunk_reverts_only_that_block_in_the_working_tree() {
    let fx = two_hunk_repo();
    let repo = Repo::open(fx.path()).unwrap();

    // Discard the first hunk (top edit); the bottom edit must survive.
    repo.discard_hunk("f.txt", 0).unwrap();

    let content = std::fs::read_to_string(fx.path().join("f.txt")).unwrap();
    assert!(content.contains("line 2\n"), "top edit reverted to original");
    assert!(content.contains("LINE 11 CHANGED"), "bottom edit preserved");
    // Only the bottom hunk remains as an unstaged change.
    assert_eq!(repo.file_diff("f.txt", false).unwrap().unwrap().hunks.len(), 1);
}
