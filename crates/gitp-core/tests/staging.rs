//! Staging area: status split into staged/unstaged, stage/unstage, and commit.

mod common;

use common::FixtureRepo;
use gitp_core::{Repo, DEFAULT_CONTEXT_LINES};

#[test]
fn stage_hunk_stages_only_the_chosen_block_of_a_multi_hunk_file() {
    let fx = FixtureRepo::init();
    // A file with two regions far enough apart to diff as two separate hunks.
    let base: String = (1..=20).map(|n| format!("line {n}\n")).collect();
    fx.commit_file("a.txt", &base, "c1");
    // Change line 2 (first hunk) and line 19 (second hunk).
    let edited = base
        .replace("line 2\n", "LINE TWO\n")
        .replace("line 19\n", "LINE NINETEEN\n");
    std::fs::write(fx.path().join("a.txt"), &edited).unwrap();

    let repo = Repo::open(fx.path()).unwrap();
    let hunks = repo
        .file_diff("a.txt", false, DEFAULT_CONTEXT_LINES)
        .unwrap()
        .unwrap()
        .hunks
        .len();
    assert_eq!(hunks, 2, "the two edits form two separate hunks");

    // Stage only the first block.
    repo.stage_hunk("a.txt", 0, DEFAULT_CONTEXT_LINES).unwrap();

    // The staged (index) diff has just the first edit; the working tree still
    // has the second edit unstaged.
    let staged = repo
        .file_diff("a.txt", true, DEFAULT_CONTEXT_LINES)
        .unwrap()
        .unwrap();
    let staged_text: String = staged
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .map(|l| l.content.as_str())
        .collect();
    assert!(staged_text.contains("LINE TWO"), "first block is staged");
    assert!(
        !staged_text.contains("LINE NINETEEN"),
        "second block is NOT staged"
    );

    let unstaged = repo
        .file_diff("a.txt", false, DEFAULT_CONTEXT_LINES)
        .unwrap()
        .unwrap();
    let unstaged_text: String = unstaged
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .map(|l| l.content.as_str())
        .collect();
    assert!(
        unstaged_text.contains("LINE NINETEEN"),
        "second block remains unstaged"
    );
}

#[test]
fn status_splits_staged_from_unstaged_and_stage_moves_between_them() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    std::fs::write(fx.path().join("a.txt"), "two\n").unwrap(); // modify tracked
    std::fs::write(fx.path().join("new.txt"), "new\n").unwrap(); // untracked

    let repo = Repo::open(fx.path()).unwrap();

    let s = repo.status_lists().unwrap();
    assert!(s.staged.is_empty(), "nothing staged yet");
    let unstaged: Vec<&str> = s.unstaged.iter().map(|f| f.path.as_str()).collect();
    assert!(unstaged.contains(&"a.txt") && unstaged.contains(&"new.txt"));

    repo.stage("a.txt").unwrap();
    let s = repo.status_lists().unwrap();
    let staged: Vec<&str> = s.staged.iter().map(|f| f.path.as_str()).collect();
    let unstaged: Vec<&str> = s.unstaged.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(staged, vec!["a.txt"], "a.txt is now staged");
    assert!(unstaged.contains(&"new.txt") && !unstaged.contains(&"a.txt"));

    repo.unstage("a.txt").unwrap();
    assert!(
        repo.status_lists().unwrap().staged.is_empty(),
        "a.txt unstaged again"
    );
}

#[test]
fn status_summary_lists_files_without_hunks_and_file_diff_fills_them_in() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    std::fs::write(fx.path().join("a.txt"), "two\n").unwrap(); // modify tracked
    std::fs::write(fx.path().join("new.txt"), "new\n").unwrap(); // untracked

    let repo = Repo::open(fx.path()).unwrap();
    repo.stage("a.txt").unwrap();

    // Summary carries the same paths/statuses as status_lists, but no hunks.
    let sum = repo.status_summary().unwrap();
    let staged: Vec<&str> = sum.staged.iter().map(|f| f.path.as_str()).collect();
    let unstaged: Vec<&str> = sum.unstaged.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(staged, vec!["a.txt"]);
    assert!(unstaged.contains(&"new.txt"));
    assert!(
        sum.staged
            .iter()
            .chain(&sum.unstaged)
            .all(|f| f.hunks.is_empty()),
        "summary omits hunks"
    );

    // file_diff fills in the hunks for a modified file, in the staged direction.
    let staged_diff = repo
        .file_diff("a.txt", true, DEFAULT_CONTEXT_LINES)
        .unwrap()
        .expect("a.txt staged diff");
    assert!(!staged_diff.hunks.is_empty(), "staged diff has hunks");
    // An untracked file's content is viewable too (show_untracked_content), so it
    // has a hunk with its added lines — not a blank diff.
    let untracked = repo
        .file_diff("new.txt", false, DEFAULT_CONTEXT_LINES)
        .unwrap()
        .expect("new.txt diff");
    assert_eq!(untracked.status, gitp_core::ChangeKind::Untracked);
    assert!(
        !untracked.hunks.is_empty(),
        "untracked file shows its content"
    );

    // No change in a direction → None (a.txt has nothing left unstaged).
    assert!(
        repo.file_diff("a.txt", false, DEFAULT_CONTEXT_LINES)
            .unwrap()
            .is_none(),
        "a.txt fully staged"
    );
}

#[test]
fn file_diff_shows_content_of_untracked_and_deleted_files() {
    let fx = FixtureRepo::init();
    fx.commit_file("keep.txt", "a\nb\nc\n", "base");
    std::fs::write(fx.path().join("new.txt"), "hello\nworld\n").unwrap(); // untracked
    std::fs::remove_file(fx.path().join("keep.txt")).unwrap(); // deleted

    let repo = Repo::open(fx.path()).unwrap();

    let new = repo
        .file_diff("new.txt", false, DEFAULT_CONTEXT_LINES)
        .unwrap()
        .expect("untracked diff");
    assert_eq!(new.status, gitp_core::ChangeKind::Untracked);
    let added: String = new
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .map(|l| l.content.as_str())
        .collect();
    assert!(
        added.contains("hello") && added.contains("world"),
        "new file content shown"
    );

    let del = repo
        .file_diff("keep.txt", false, DEFAULT_CONTEXT_LINES)
        .unwrap()
        .expect("deleted diff");
    assert_eq!(del.status, gitp_core::ChangeKind::Deleted);
    assert!(
        !del.hunks.is_empty(),
        "deleted file shows its removed content"
    );
}

#[test]
fn commit_records_staged_changes_and_clears_the_staging_area() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    std::fs::write(fx.path().join("a.txt"), "two\n").unwrap();

    let repo = Repo::open(fx.path()).unwrap();
    repo.stage_all().unwrap();
    repo.commit("change a", "the body", false, None).unwrap();

    // Nothing left staged, and the new commit is HEAD.
    assert!(
        repo.status_lists().unwrap().staged.is_empty(),
        "staging cleared after commit"
    );
    let head = repo.commit_detail("HEAD").unwrap();
    assert_eq!(head.summary, "change a");
    assert!(
        head.message.contains("the body"),
        "body recorded in the message"
    );
}

// O6: `git reset HEAD` has no HEAD to resolve on an unborn branch; unstaging
// must still work before the first commit.
#[test]
fn unstage_and_unstage_all_work_on_an_unborn_branch() {
    let fx = FixtureRepo::init();
    std::fs::write(fx.path().join("a.txt"), "a\n").unwrap();
    std::fs::write(fx.path().join("b.txt"), "b\n").unwrap();
    let repo = Repo::open(fx.path()).unwrap();
    repo.stage_all().unwrap();
    assert_eq!(repo.status_summary().unwrap().staged.len(), 2);

    repo.unstage("a.txt").expect("unstage one on unborn branch");
    let s = repo.status_summary().unwrap();
    let staged: Vec<&str> = s.staged.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(staged, vec!["b.txt"]);

    repo.unstage_all().expect("unstage all on unborn branch");
    let s = repo.status_summary().unwrap();
    assert!(s.staged.is_empty(), "nothing staged");
    assert_eq!(s.unstaged.len(), 2, "both files are untracked again");
}

// O2: `stage` and `file_diff` take a path, not a pattern.
#[test]
fn stage_of_a_glob_like_path_is_literal() {
    let fx = FixtureRepo::init();
    fx.commit_file("a1.txt", "plain\n", "c1");
    fx.commit_file("a[1].txt", "bracket\n", "c2");
    std::fs::write(fx.path().join("a1.txt"), "plain edited\n").unwrap();
    std::fs::write(fx.path().join("a[1].txt"), "bracket edited\n").unwrap();
    let repo = Repo::open(fx.path()).unwrap();

    repo.stage("a[1].txt").unwrap();

    let s = repo.status_summary().unwrap();
    let staged: Vec<&str> = s.staged.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(staged, vec!["a[1].txt"]);
    // And the per-file diff of the lookalike is its own, not the bracket file's.
    let d = repo
        .file_diff("a1.txt", false, DEFAULT_CONTEXT_LINES)
        .unwrap()
        .unwrap();
    assert_eq!(d.path, "a1.txt");
}

#[test]
fn status_summary_never_rewrites_the_index() {
    // `git status` normally refreshes stale stat data and writes `.git/index`
    // back. gitp runs it in the background after every filesystem event, so
    // that write would be an event of its own — a refresh loop.
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "c1");
    // Same content, different mtime: the index's stat data is now stale.
    let file = std::fs::File::options()
        .write(true)
        .open(fx.path().join("a.txt"))
        .unwrap();
    file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3600))
        .unwrap();
    drop(file);

    let repo = Repo::open(fx.path()).unwrap();
    let before = repo.index_stamp();
    let sum = repo.status_summary().unwrap();
    assert!(
        sum.staged.is_empty() && sum.unstaged.is_empty(),
        "content is unchanged"
    );
    assert_eq!(
        repo.index_stamp(),
        before,
        "status must not write the index"
    );
}

#[test]
fn file_diff_can_ignore_whitespace_while_hunk_ops_use_the_real_diff() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\ntwo\n", "c1");
    std::fs::write(fx.path().join("a.txt"), "one  \ntwo\n").unwrap();
    let repo = Repo::open(fx.path()).unwrap();

    let real = repo
        .file_diff_with("a.txt", false, DEFAULT_CONTEXT_LINES, false)
        .unwrap()
        .unwrap();
    assert_eq!(real.hunks.len(), 1);
    let no_ws = repo
        .file_diff_with("a.txt", false, DEFAULT_CONTEXT_LINES, true)
        .unwrap()
        .unwrap();
    assert!(
        no_ws.hunks.is_empty(),
        "a whitespace-only change has no blocks"
    );

    // Staging block 0 still stages the real (whitespace) change.
    repo.stage_hunk("a.txt", 0, DEFAULT_CONTEXT_LINES).unwrap();
    assert!(repo
        .file_diff("a.txt", false, DEFAULT_CONTEXT_LINES)
        .unwrap()
        .is_none());
}
