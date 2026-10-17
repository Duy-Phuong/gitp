//! Per-line staging: stage / unstage / discard an arbitrary selection of the
//! changed lines of a file, within one block or across several.

mod common;

use std::path::Path;

use common::FixtureRepo;
use gitp_core::{Repo, DEFAULT_CONTEXT_LINES};

/// The `(hunk, line)` positions of the diff lines written as `"+text"` /
/// `"-text"`, as the diff pane would send them for a selection.
fn pick(
    repo: &Repo,
    path: &str,
    staged: bool,
    context: u32,
    wanted: &[&str],
) -> Vec<(usize, usize)> {
    let diff = repo
        .file_diff(path, staged, context)
        .unwrap()
        .expect("file has a diff");
    wanted
        .iter()
        .map(|w| {
            let (origin, text) = w.split_at(1);
            diff.hunks
                .iter()
                .enumerate()
                .find_map(|(h, hunk)| {
                    hunk.lines
                        .iter()
                        .position(|l| {
                            l.origin.to_string() == origin
                                && l.content.trim_end_matches('\r') == text
                        })
                        .map(|l| (h, l))
                })
                .unwrap_or_else(|| panic!("no diff line {w:?}"))
        })
        .collect()
}

/// `path`'s content in the index, or None when it isn't there.
fn index_text(fx: &FixtureRepo, path: &str) -> Option<String> {
    let mut index = fx.repo.index().unwrap();
    index.read(true).unwrap();
    let entry = index.get_path(Path::new(path), 0)?;
    let blob = fx.repo.find_blob(entry.id).unwrap();
    Some(String::from_utf8(blob.content().to_vec()).unwrap())
}

fn work_text(fx: &FixtureRepo, path: &str) -> String {
    std::fs::read_to_string(fx.path().join(path)).unwrap()
}

/// Lines 1–12 committed, then: line 2 replaced by "TWO" and "NEW" inserted
/// after line 3 — one block (3 lines of context joins them) with two changes.
fn one_block_repo() -> FixtureRepo {
    let fx = FixtureRepo::init();
    let base: String = (1..=12).map(|n| format!("line {n}\n")).collect();
    fx.commit_file("f.txt", &base, "base");
    let edited = base
        .replace("line 2\n", "TWO\n")
        .replace("line 3\n", "line 3\nNEW\n");
    std::fs::write(fx.path().join("f.txt"), edited).unwrap();
    fx
}

/// Lines 1–12 committed, then two separate blocks: "new a" / "new b" inserted
/// after line 2, and line 11 replaced by "LINE 11".
fn two_block_repo() -> FixtureRepo {
    let fx = FixtureRepo::init();
    let base: String = (1..=12).map(|n| format!("line {n}\n")).collect();
    fx.commit_file("f.txt", &base, "base");
    let edited = base
        .replace("line 2\n", "line 2\nnew a\nnew b\n")
        .replace("line 11\n", "LINE 11\n");
    std::fs::write(fx.path().join("f.txt"), edited).unwrap();
    fx
}

fn base_with(replace: &[(&str, &str)]) -> String {
    let mut s: String = (1..=12).map(|n| format!("line {n}\n")).collect();
    for (from, to) in replace {
        s = s.replace(from, to);
    }
    s
}

#[test]
fn stage_lines_stages_only_the_selected_addition() {
    let fx = one_block_repo();
    let repo = Repo::open(fx.path()).unwrap();
    let before = work_text(&fx, "f.txt");

    let sel = pick(&repo, "f.txt", false, DEFAULT_CONTEXT_LINES, &["+NEW"]);
    repo.stage_lines("f.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();

    assert_eq!(
        index_text(&fx, "f.txt").unwrap(),
        base_with(&[("line 3\n", "line 3\nNEW\n")]),
        "only NEW is staged; line 2 is still the original"
    );
    assert_eq!(work_text(&fx, "f.txt"), before, "working tree untouched");
}

#[test]
fn stage_lines_keeps_an_unselected_deletion_as_context() {
    let fx = one_block_repo();
    let repo = Repo::open(fx.path()).unwrap();

    // Stage the replacement text but not the removal of the old line.
    let sel = pick(&repo, "f.txt", false, DEFAULT_CONTEXT_LINES, &["+TWO"]);
    repo.stage_lines("f.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();
    assert_eq!(
        index_text(&fx, "f.txt").unwrap(),
        base_with(&[("line 2\n", "line 2\nTWO\n")])
    );
}

#[test]
fn stage_lines_can_stage_just_a_deletion() {
    let fx = one_block_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let sel = pick(&repo, "f.txt", false, DEFAULT_CONTEXT_LINES, &["-line 2"]);
    repo.stage_lines("f.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();
    assert_eq!(
        index_text(&fx, "f.txt").unwrap(),
        base_with(&[("line 2\n", "")])
    );
}

#[test]
fn unstage_lines_moves_only_the_selected_lines_back() {
    let fx = one_block_repo();
    let repo = Repo::open(fx.path()).unwrap();
    repo.stage_all().unwrap();

    let sel = pick(&repo, "f.txt", true, DEFAULT_CONTEXT_LINES, &["+TWO"]);
    repo.unstage_lines("f.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();

    // Line 2's removal and NEW stay staged; TWO goes back to unstaged.
    assert_eq!(
        index_text(&fx, "f.txt").unwrap(),
        base_with(&[("line 2\n", ""), ("line 3\n", "line 3\nNEW\n")])
    );
    let unstaged = repo
        .file_diff("f.txt", false, DEFAULT_CONTEXT_LINES)
        .unwrap()
        .expect("TWO is unstaged again");
    let changed: Vec<String> = unstaged
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter(|l| l.origin != ' ')
        .map(|l| format!("{}{}", l.origin, l.content))
        .collect();
    assert_eq!(changed, vec!["+TWO"]);
}

#[test]
fn discard_lines_reverts_only_the_selected_lines_in_the_working_tree() {
    let fx = one_block_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let sel = pick(&repo, "f.txt", false, DEFAULT_CONTEXT_LINES, &["+NEW"]);
    repo.discard_lines("f.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();

    assert_eq!(
        work_text(&fx, "f.txt"),
        base_with(&[("line 2\n", "TWO\n")]),
        "NEW is gone, the TWO edit survives"
    );
    assert_eq!(index_text(&fx, "f.txt").unwrap(), base_with(&[]));
}

#[test]
fn discard_lines_restores_a_selected_deletion_and_keeps_an_unselected_addition() {
    let fx = one_block_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let sel = pick(&repo, "f.txt", false, DEFAULT_CONTEXT_LINES, &["-line 2"]);
    repo.discard_lines("f.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();

    assert_eq!(
        work_text(&fx, "f.txt"),
        base_with(&[("line 2\n", "line 2\nTWO\n"), ("line 3\n", "line 3\nNEW\n")])
    );
}

// A selection that spans blocks: each block is cut down on its own, and the
// later block's header has to account for what the earlier one now adds.

#[test]
fn stage_lines_across_two_blocks() {
    let fx = two_block_repo();
    let repo = Repo::open(fx.path()).unwrap();
    assert_eq!(
        repo.file_diff("f.txt", false, DEFAULT_CONTEXT_LINES)
            .unwrap()
            .unwrap()
            .hunks
            .len(),
        2
    );

    let sel = pick(
        &repo,
        "f.txt",
        false,
        DEFAULT_CONTEXT_LINES,
        &["+new b", "-line 11", "+LINE 11"],
    );
    repo.stage_lines("f.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();

    assert_eq!(
        index_text(&fx, "f.txt").unwrap(),
        base_with(&[("line 2\n", "line 2\nnew b\n"), ("line 11\n", "LINE 11\n")])
    );
}

#[test]
fn unstage_lines_across_two_blocks() {
    let fx = two_block_repo();
    let repo = Repo::open(fx.path()).unwrap();
    repo.stage_all().unwrap();

    let sel = pick(
        &repo,
        "f.txt",
        true,
        DEFAULT_CONTEXT_LINES,
        &["+new a", "-line 11", "+LINE 11"],
    );
    repo.unstage_lines("f.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();

    assert_eq!(
        index_text(&fx, "f.txt").unwrap(),
        base_with(&[("line 2\n", "line 2\nnew b\n")])
    );
}

#[test]
fn discard_lines_across_two_blocks() {
    let fx = two_block_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let sel = pick(
        &repo,
        "f.txt",
        false,
        DEFAULT_CONTEXT_LINES,
        &["+new a", "+new b", "+LINE 11"],
    );
    repo.discard_lines("f.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();

    // The removal of line 11 wasn't selected, so it stays removed.
    assert_eq!(work_text(&fx, "f.txt"), base_with(&[("line 11\n", "")]));
}

#[test]
fn stage_lines_with_zero_context() {
    let fx = two_block_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let sel = pick(&repo, "f.txt", false, 0, &["+new a", "+LINE 11"]);
    repo.stage_lines("f.txt", &sel, 0).unwrap();

    assert_eq!(
        index_text(&fx, "f.txt").unwrap(),
        base_with(&[
            ("line 2\n", "line 2\nnew a\n"),
            ("line 11\n", "line 11\nLINE 11\n")
        ])
    );
}

#[test]
fn discard_lines_with_zero_context() {
    let fx = two_block_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let sel = pick(&repo, "f.txt", false, 0, &["+new b", "-line 11"]);
    repo.discard_lines("f.txt", &sel, 0).unwrap();

    assert_eq!(
        work_text(&fx, "f.txt"),
        base_with(&[
            ("line 2\n", "line 2\nnew a\n"),
            ("line 11\n", "line 11\nLINE 11\n")
        ])
    );
}

// New files: the patch creates (or, reversed, deletes) the file, which is only
// right when every line is selected — otherwise the file must stay.

#[test]
fn stage_lines_of_an_untracked_file_adds_just_those_lines() {
    let fx = FixtureRepo::init();
    fx.commit_file("keep.txt", "keep\n", "base");
    std::fs::write(fx.path().join("new.txt"), "x\ny\nz\n").unwrap();
    let repo = Repo::open(fx.path()).unwrap();

    let sel = pick(
        &repo,
        "new.txt",
        false,
        DEFAULT_CONTEXT_LINES,
        &["+x", "+z"],
    );
    repo.stage_lines("new.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();

    assert_eq!(index_text(&fx, "new.txt").unwrap(), "x\nz\n");
    assert_eq!(work_text(&fx, "new.txt"), "x\ny\nz\n");
}

#[test]
fn unstage_some_lines_of_an_added_file_keeps_it_staged() {
    let fx = FixtureRepo::init();
    fx.commit_file("keep.txt", "keep\n", "base");
    std::fs::write(fx.path().join("new.txt"), "x\ny\nz\n").unwrap();
    let repo = Repo::open(fx.path()).unwrap();
    repo.stage("new.txt").unwrap();

    let sel = pick(&repo, "new.txt", true, DEFAULT_CONTEXT_LINES, &["+y"]);
    repo.unstage_lines("new.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();
    assert_eq!(index_text(&fx, "new.txt").unwrap(), "x\nz\n");

    // Unstaging every remaining line takes the file back out of the index.
    let sel = pick(&repo, "new.txt", true, DEFAULT_CONTEXT_LINES, &["+x", "+z"]);
    repo.unstage_lines("new.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();
    assert_eq!(index_text(&fx, "new.txt"), None);
    assert_eq!(work_text(&fx, "new.txt"), "x\ny\nz\n");
}

#[test]
fn discard_some_lines_of_an_untracked_file_keeps_the_rest() {
    let fx = FixtureRepo::init();
    fx.commit_file("keep.txt", "keep\n", "base");
    std::fs::write(fx.path().join("new.txt"), "p\nq\n").unwrap();
    let repo = Repo::open(fx.path()).unwrap();

    let sel = pick(&repo, "new.txt", false, DEFAULT_CONTEXT_LINES, &["+p"]);
    repo.discard_lines("new.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();

    assert_eq!(work_text(&fx, "new.txt"), "q\n");
    assert_eq!(index_text(&fx, "new.txt"), None, "still untracked");
}

#[test]
fn stage_some_lines_of_a_deleted_file_keeps_it_in_the_index() {
    let fx = FixtureRepo::init();
    fx.commit_file("gone.txt", "a\nb\nc\n", "base");
    std::fs::remove_file(fx.path().join("gone.txt")).unwrap();
    let repo = Repo::open(fx.path()).unwrap();

    let sel = pick(&repo, "gone.txt", false, DEFAULT_CONTEXT_LINES, &["-b"]);
    repo.stage_lines("gone.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();
    assert_eq!(index_text(&fx, "gone.txt").unwrap(), "a\nc\n");
}

// A last line without a newline is marked "\ No newline at end of file" in
// the patch; cutting lines around it must keep that marker on the right line.

/// "a\nb" (no newline) committed, "a\nB\nc" (no newline) in the working tree.
fn no_newline_repo() -> FixtureRepo {
    let fx = FixtureRepo::init();
    fx.commit_file("f.txt", "a\nb", "base");
    std::fs::write(fx.path().join("f.txt"), "a\nB\nc").unwrap();
    fx
}

#[test]
fn stage_lines_after_a_last_line_without_newline() {
    let fx = no_newline_repo();
    let repo = Repo::open(fx.path()).unwrap();

    // Appending after "b" means "b" gains a newline.
    let sel = pick(&repo, "f.txt", false, DEFAULT_CONTEXT_LINES, &["+c"]);
    repo.stage_lines("f.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();
    assert_eq!(index_text(&fx, "f.txt").unwrap(), "a\nb\nc");
}

#[test]
fn stage_lines_inserting_before_the_unselected_last_line() {
    let fx = no_newline_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let sel = pick(&repo, "f.txt", false, DEFAULT_CONTEXT_LINES, &["+B"]);
    repo.stage_lines("f.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();
    assert_eq!(index_text(&fx, "f.txt").unwrap(), "a\nb\nB\n");
}

#[test]
fn stage_lines_removing_the_last_line_without_newline() {
    let fx = no_newline_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let sel = pick(&repo, "f.txt", false, DEFAULT_CONTEXT_LINES, &["-b"]);
    repo.stage_lines("f.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();
    assert_eq!(index_text(&fx, "f.txt").unwrap(), "a\n");
}

#[test]
fn discard_lines_next_to_a_last_line_without_newline() {
    let fx = no_newline_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let sel = pick(&repo, "f.txt", false, DEFAULT_CONTEXT_LINES, &["+B"]);
    repo.discard_lines("f.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();
    assert_eq!(work_text(&fx, "f.txt"), "a\nc");

    let fx = no_newline_repo();
    let repo = Repo::open(fx.path()).unwrap();
    let sel = pick(&repo, "f.txt", false, DEFAULT_CONTEXT_LINES, &["+c"]);
    repo.discard_lines("f.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();
    assert_eq!(work_text(&fx, "f.txt"), "a\nB\n");
}

// CRLF content is passed through byte for byte (no autocrlf conversion here,
// so the index really holds the carriage returns).

fn crlf_repo() -> FixtureRepo {
    let fx = FixtureRepo::init();
    fx.repo
        .config()
        .unwrap()
        .set_bool("core.autocrlf", false)
        .unwrap();
    fx.commit_file("f.txt", "one\r\ntwo\r\nthree\r\n", "base");
    std::fs::write(fx.path().join("f.txt"), "one\r\nTWO\r\nthree\r\nFOUR\r\n").unwrap();
    fx
}

#[test]
fn stage_lines_keeps_crlf_line_endings() {
    let fx = crlf_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let sel = pick(&repo, "f.txt", false, DEFAULT_CONTEXT_LINES, &["+FOUR"]);
    repo.stage_lines("f.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();
    assert_eq!(
        index_text(&fx, "f.txt").unwrap(),
        "one\r\ntwo\r\nthree\r\nFOUR\r\n"
    );
}

#[test]
fn discard_lines_keeps_crlf_line_endings() {
    let fx = crlf_repo();
    let repo = Repo::open(fx.path()).unwrap();

    let sel = pick(
        &repo,
        "f.txt",
        false,
        DEFAULT_CONTEXT_LINES,
        &["-two", "+TWO"],
    );
    repo.discard_lines("f.txt", &sel, DEFAULT_CONTEXT_LINES)
        .unwrap();
    assert_eq!(work_text(&fx, "f.txt"), "one\r\ntwo\r\nthree\r\nFOUR\r\n");
}

#[test]
fn a_selection_without_changed_lines_is_refused() {
    let fx = one_block_repo();
    let repo = Repo::open(fx.path()).unwrap();

    assert!(repo
        .stage_lines("f.txt", &[], DEFAULT_CONTEXT_LINES)
        .is_err());
    // (0, 0) is "line 1", a context line.
    assert!(repo
        .stage_lines("f.txt", &[(0, 0)], DEFAULT_CONTEXT_LINES)
        .is_err());
    assert!(
        repo.stage_lines("f.txt", &[(5, 0)], DEFAULT_CONTEXT_LINES)
            .is_err(),
        "no such block"
    );
    assert_eq!(index_text(&fx, "f.txt").unwrap(), base_with(&[]));
}
