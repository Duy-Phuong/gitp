//! Per-hunk staging: stage / unstage / discard a single block of a file.

mod common;

use common::FixtureRepo;
use gitp_core::{Repo, DEFAULT_CONTEXT_LINES};

/// A file with two well-separated change regions, so its diff has two hunks.
fn two_hunk_repo() -> FixtureRepo {
    let fx = FixtureRepo::init();
    // 12 numbered lines committed…
    let base: String = (1..=12).map(|n| format!("line {n}\n")).collect();
    fx.commit_file("f.txt", &base, "base");
    // …then edit line 2 (top) and line 11 (bottom): two separate hunks.
    let edited = base
        .replace("line 2\n", "LINE 2 CHANGED\n")
        .replace("line 11\n", "LINE 11 CHANGED\n");
    std::fs::write(fx.path().join("f.txt"), edited).unwrap();
    fx
}

#[test]
fn stage_hunk_stages_only_that_block() {
    let fx = two_hunk_repo();
    let repo = Repo::open(fx.path()).unwrap();

    assert_eq!(
        repo.file_diff("f.txt", false, DEFAULT_CONTEXT_LINES, None)
            .unwrap()
            .unwrap()
            .hunks
            .len(),
        2,
        "two unstaged hunks"
    );

    // Stage only the first hunk (the top edit).
    repo.stage_hunk("f.txt", 0, DEFAULT_CONTEXT_LINES).unwrap();

    // One hunk staged, one still unstaged.
    let staged = repo
        .file_diff("f.txt", true, DEFAULT_CONTEXT_LINES, None)
        .unwrap()
        .expect("something staged");
    let unstaged = repo
        .file_diff("f.txt", false, DEFAULT_CONTEXT_LINES, None)
        .unwrap()
        .expect("something still unstaged");
    assert_eq!(staged.hunks.len(), 1, "exactly one hunk staged");
    assert_eq!(unstaged.hunks.len(), 1, "the other hunk stays unstaged");
    // The staged hunk is the top one (line 2), not the bottom.
    let staged_text: String = staged.hunks[0]
        .lines
        .iter()
        .map(|l| l.content.as_str())
        .collect();
    assert!(
        staged_text.contains("LINE 2 CHANGED"),
        "top edit was staged"
    );
    assert!(
        !staged_text.contains("LINE 11 CHANGED"),
        "bottom edit was not staged"
    );
}

#[test]
fn unstage_hunk_moves_one_block_back_to_the_working_tree() {
    let fx = two_hunk_repo();
    let repo = Repo::open(fx.path()).unwrap();
    repo.stage_all().unwrap();
    assert_eq!(
        repo.file_diff("f.txt", true, DEFAULT_CONTEXT_LINES, None)
            .unwrap()
            .unwrap()
            .hunks
            .len(),
        2,
        "both staged"
    );

    repo.unstage_hunk("f.txt", 0, DEFAULT_CONTEXT_LINES)
        .unwrap();

    assert_eq!(
        repo.file_diff("f.txt", true, DEFAULT_CONTEXT_LINES, None)
            .unwrap()
            .unwrap()
            .hunks
            .len(),
        1,
        "one hunk left staged"
    );
    assert_eq!(
        repo.file_diff("f.txt", false, DEFAULT_CONTEXT_LINES, None)
            .unwrap()
            .unwrap()
            .hunks
            .len(),
        1,
        "one hunk back unstaged"
    );
}

#[test]
fn discard_hunk_reverts_only_that_block_in_the_working_tree() {
    let fx = two_hunk_repo();
    let repo = Repo::open(fx.path()).unwrap();

    // Discard the first hunk (top edit); the bottom edit must survive.
    repo.discard_hunk("f.txt", 0, DEFAULT_CONTEXT_LINES)
        .unwrap();

    let content = std::fs::read_to_string(fx.path().join("f.txt")).unwrap();
    assert!(
        content.contains("line 2\n"),
        "top edit reverted to original"
    );
    assert!(content.contains("LINE 11 CHANGED"), "bottom edit preserved");
    // Only the bottom hunk remains as an unstaged change.
    assert_eq!(
        repo.file_diff("f.txt", false, DEFAULT_CONTEXT_LINES, None)
            .unwrap()
            .unwrap()
            .hunks
            .len(),
        1
    );
}

// The diff pane can show more or fewer lines of context around each change; the
// block buttons must act on the blocks as shown, so the hunk ops take the same
// context the diff was rendered with.

#[test]
fn wider_context_merges_nearby_hunks_and_stages_them_together() {
    let fx = two_hunk_repo();
    let repo = Repo::open(fx.path()).unwrap();

    // Lines 2 and 11 are 8 unchanged lines apart: 3 lines of context keeps them
    // apart, 6 lines on each side closes the gap into one block.
    assert_eq!(
        repo.file_diff("f.txt", false, 6, None)
            .unwrap()
            .unwrap()
            .hunks
            .len(),
        1
    );

    repo.stage_hunk("f.txt", 0, 6).unwrap();

    assert!(
        repo.file_diff("f.txt", false, DEFAULT_CONTEXT_LINES, None)
            .unwrap()
            .is_none(),
        "both edits staged"
    );
}

#[test]
fn zero_context_shows_bare_changes_and_still_stages_one_block() {
    let fx = two_hunk_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let diff = repo.file_diff("f.txt", false, 0, None).unwrap().unwrap();
    assert_eq!(diff.hunks.len(), 2);
    assert!(
        diff.hunks
            .iter()
            .flat_map(|h| &h.lines)
            .all(|l| l.origin != ' '),
        "no context lines"
    );

    repo.stage_hunk("f.txt", 0, 0).unwrap();

    let staged = repo
        .file_diff("f.txt", true, DEFAULT_CONTEXT_LINES, None)
        .unwrap()
        .unwrap();
    let staged_text: String = staged.hunks[0]
        .lines
        .iter()
        .map(|l| l.content.as_str())
        .collect();
    assert_eq!(staged.hunks.len(), 1);
    assert!(staged_text.contains("LINE 2 CHANGED"));
    assert!(!staged_text.contains("LINE 11 CHANGED"));
}

#[test]
fn full_file_context_is_one_block_with_every_line() {
    let fx = two_hunk_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let diff = repo
        .file_diff("f.txt", false, u32::MAX, None)
        .unwrap()
        .unwrap();
    assert_eq!(diff.hunks.len(), 1);
    // 10 unchanged lines + 2 removed + 2 added.
    assert_eq!(diff.hunks[0].lines.len(), 14);
}

// O2: paths are passed to git as pathspecs, where `[1]` is a glob character
// class. `a[1].txt` must address that file only, never `a1.txt`.
#[test]
fn stage_hunk_on_a_glob_like_path_leaves_the_lookalike_file_alone() {
    let fx = FixtureRepo::init();
    fx.commit_file("a1.txt", "plain\n", "c1");
    fx.commit_file("a[1].txt", "bracket\n", "c2");
    std::fs::write(fx.path().join("a1.txt"), "plain edited\n").unwrap();
    std::fs::write(fx.path().join("a[1].txt"), "bracket edited\n").unwrap();
    let repo = Repo::open(fx.path()).unwrap();

    let diff = repo
        .file_diff("a[1].txt", false, DEFAULT_CONTEXT_LINES, None)
        .unwrap()
        .expect("a[1].txt has a diff");
    assert_eq!(diff.path, "a[1].txt");
    assert_eq!(diff.hunks.len(), 1);

    repo.stage_hunk("a[1].txt", 0, DEFAULT_CONTEXT_LINES)
        .unwrap();

    let s = repo.status_summary().unwrap();
    let staged: Vec<&str> = s.staged.iter().map(|f| f.path.as_str()).collect();
    let unstaged: Vec<&str> = s.unstaged.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(staged, vec!["a[1].txt"], "only the bracket file is staged");
    assert_eq!(unstaged, vec!["a1.txt"], "a1.txt is untouched");
}
