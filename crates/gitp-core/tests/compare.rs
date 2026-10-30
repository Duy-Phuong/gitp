mod common;

use common::FixtureRepo;
use gitp_core::{ChangeKind, Comparison, Repo};

/// Commit a tree holding exactly `files` (flat paths), with explicit parents,
/// and point `refs/heads/<branch>` at it. Trees are built from scratch so a
/// commit can add, change, delete and rename files all at once.
fn commit_tree(
    f: &FixtureRepo,
    branch: &str,
    files: &[(&str, &str)],
    parents: &[git2::Oid],
    message: &str,
) -> git2::Oid {
    let mut tb = f.repo.treebuilder(None).unwrap();
    for (path, contents) in files {
        let blob = f.repo.blob(contents.as_bytes()).unwrap();
        tb.insert(path, blob, 0o100644).unwrap();
    }
    let tree = f.repo.find_tree(tb.write().unwrap()).unwrap();
    let sig = f.repo.signature().unwrap();
    let parents: Vec<git2::Commit> = parents
        .iter()
        .map(|p| f.repo.find_commit(*p).unwrap())
        .collect();
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let oid = f
        .repo
        .commit(None, &sig, &sig, message, &tree, &parent_refs)
        .unwrap();
    f.repo
        .reference(&format!("refs/heads/{branch}"), oid, true, "fixture")
        .unwrap();
    oid
}

/// `(path, status)` for each changed file, in diff order.
fn changes(c: &Comparison) -> Vec<(String, ChangeKind)> {
    c.files.iter().map(|f| (f.path.clone(), f.status)).collect()
}

// Long enough that the rename survives libgit2's similarity threshold.
const MOVED: &str = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";

#[test]
fn reports_added_modified_deleted_and_renamed_files() {
    let f = FixtureRepo::init();
    let c1 = commit_tree(
        &f,
        "main",
        &[
            ("keep.txt", "1\n2\n3\n"),
            ("gone.txt", "bye\n"),
            ("old.txt", MOVED),
        ],
        &[],
        "before",
    );
    let c2 = commit_tree(
        &f,
        "main",
        &[
            ("keep.txt", "1\nX\n3\n"),
            ("new.txt", "hi\n"),
            ("moved.txt", MOVED),
        ],
        &[c1],
        "after",
    );
    let repo = Repo::open(f.path()).unwrap();

    let cmp = repo
        .compare(&c1.to_string(), &c2.to_string(), false)
        .unwrap();
    assert_eq!(
        changes(&cmp),
        [
            ("gone.txt".to_string(), ChangeKind::Deleted),
            ("keep.txt".to_string(), ChangeKind::Modified),
            ("moved.txt".to_string(), ChangeKind::Renamed),
            ("new.txt".to_string(), ChangeKind::Added),
        ]
    );
    let moved = cmp.files.iter().find(|f| f.path == "moved.txt").unwrap();
    assert_eq!(moved.old_path.as_deref(), Some("old.txt"));
    let keep = cmp.files.iter().find(|f| f.path == "keep.txt").unwrap();
    assert!(keep
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .any(|l| l.origin == '+' && l.content == "X"));

    assert_eq!((cmp.ahead, cmp.behind), (1, 0));
    assert_eq!(cmp.merge_base.as_deref(), Some(c1.to_string().as_str()));
    assert_eq!(cmp.base.id, c1.to_string());
    assert_eq!(cmp.base.summary, "before");
    assert_eq!(cmp.head.id, c2.to_string());
    assert_eq!(cmp.head.short_id, c2.to_string()[..7]);
    assert_eq!(cmp.head.summary, "after");
}

#[test]
fn keeps_the_revisions_as_given_for_display() {
    let f = FixtureRepo::init();
    let c1 = commit_tree(&f, "main", &[("a.txt", "a\n")], &[], "c1");
    commit_tree(&f, "feature", &[("a.txt", "b\n")], &[c1], "c2");
    let repo = Repo::open(f.path()).unwrap();

    let cmp = repo.compare("main", "feature", true).unwrap();
    assert_eq!(cmp.base.rev, "main");
    assert_eq!(cmp.head.rev, "feature");
    assert!(cmp.three_dot);
}

#[test]
fn identical_revisions_have_no_differences() {
    let f = FixtureRepo::init();
    let c1 = commit_tree(&f, "main", &[("a.txt", "a\n")], &[], "c1");
    f.repo
        .tag_lightweight("v1", &f.repo.find_object(c1, None).unwrap(), false)
        .unwrap();
    let repo = Repo::open(f.path()).unwrap();

    for three_dot in [false, true] {
        let cmp = repo.compare("main", "v1", three_dot).unwrap();
        assert!(cmp.files.is_empty());
        assert_eq!((cmp.ahead, cmp.behind), (0, 0));
    }
}

// main and feature diverged from a shared base: two-dot shows everything that
// differs between the tips (main's own file looks deleted), three-dot only
// what feature added since the fork.
#[test]
fn two_dot_and_three_dot_differ_on_diverged_branches() {
    let f = FixtureRepo::init();
    let base = commit_tree(&f, "main", &[("a.txt", "a\n")], &[], "base");
    commit_tree(
        &f,
        "main",
        &[("a.txt", "a\n"), ("m.txt", "m\n")],
        &[base],
        "on main",
    );
    commit_tree(
        &f,
        "feature",
        &[("a.txt", "a\n"), ("f.txt", "f\n")],
        &[base],
        "on feature",
    );
    let repo = Repo::open(f.path()).unwrap();

    let two = repo.compare("main", "feature", false).unwrap();
    assert_eq!(
        changes(&two),
        [
            ("f.txt".to_string(), ChangeKind::Added),
            ("m.txt".to_string(), ChangeKind::Deleted),
        ]
    );
    let three = repo.compare("main", "feature", true).unwrap();
    assert_eq!(changes(&three), [("f.txt".to_string(), ChangeKind::Added)]);

    for cmp in [&two, &three] {
        assert_eq!((cmp.ahead, cmp.behind), (1, 1));
        assert_eq!(cmp.merge_base.as_deref(), Some(base.to_string().as_str()));
    }

    // The single-file re-diff follows the same mode.
    let m_two = repo
        .compare_file_diff("main", "feature", false, "m.txt", None, 3)
        .unwrap();
    assert_eq!(m_two.map(|d| d.status), Some(ChangeKind::Deleted));
    let m_three = repo
        .compare_file_diff("main", "feature", true, "m.txt", None, 3)
        .unwrap();
    assert!(
        m_three.is_none(),
        "feature didn't touch m.txt since the fork"
    );
}

#[test]
fn file_diff_follows_the_context_and_keeps_a_rename_paired() {
    let f = FixtureRepo::init();
    let lines: String = (1..=12).map(|n| format!("line {n}\n")).collect();
    let edited = lines
        .replace("line 2\n", "LINE 2\n")
        .replace("line 11\n", "LINE 11\n");
    let c1 = commit_tree(
        &f,
        "main",
        &[("f.txt", &lines), ("old.txt", MOVED)],
        &[],
        "c1",
    );
    let c2 = commit_tree(
        &f,
        "main",
        &[("f.txt", &edited), ("moved.txt", MOVED)],
        &[c1],
        "c2",
    );
    let repo = Repo::open(f.path()).unwrap();
    let (a, b) = (c1.to_string(), c2.to_string());

    let default = repo
        .compare_file_diff(&a, &b, false, "f.txt", None, 3)
        .unwrap()
        .unwrap();
    assert_eq!(default.hunks.len(), 2);
    let full = repo
        .compare_file_diff(&a, &b, false, "f.txt", None, u32::MAX / 2)
        .unwrap()
        .unwrap();
    assert_eq!(full.hunks.len(), 1, "the whole file as one block");

    let moved = repo
        .compare_file_diff(&a, &b, false, "moved.txt", Some("old.txt"), 3)
        .unwrap()
        .unwrap();
    assert_eq!(moved.status, ChangeKind::Renamed);
    assert_eq!(moved.old_path.as_deref(), Some("old.txt"));
}

#[test]
fn an_unknown_revision_is_an_error() {
    let f = FixtureRepo::init();
    commit_tree(&f, "main", &[("a.txt", "a\n")], &[], "c1");
    let repo = Repo::open(f.path()).unwrap();

    assert!(repo.compare("main", "no-such-ref", false).is_err());
    assert!(repo.compare("no-such-ref", "main", true).is_err());
    assert!(repo
        .compare_file_diff("main", "no-such-ref", false, "a.txt", None, 3)
        .is_err());
}

// Unrelated histories have no merge base: two-dot still works, three-dot has
// nothing to diff from and says so.
#[test]
fn three_dot_needs_a_common_ancestor() {
    let f = FixtureRepo::init();
    commit_tree(&f, "main", &[("a.txt", "a\n")], &[], "c1");
    commit_tree(&f, "orphan", &[("b.txt", "b\n")], &[], "o1");
    let repo = Repo::open(f.path()).unwrap();

    let two = repo.compare("main", "orphan", false).unwrap();
    assert!(two.merge_base.is_none());
    assert_eq!(two.files.len(), 2);
    assert_eq!((two.ahead, two.behind), (1, 1));
    let err = repo.compare("main", "orphan", true).unwrap_err();
    assert!(err.to_string().contains("common ancestor"), "{err}");
}

#[test]
fn compare_file_diff_can_ignore_whitespace() {
    let f = FixtureRepo::init();
    let c1 = commit_tree(&f, "main", &[("f.txt", "a b\nc\n")], &[], "c1");
    let c2 = commit_tree(&f, "main", &[("f.txt", "a  b\nC\n")], &[c1], "c2");
    let repo = Repo::open(f.path()).unwrap();
    let (a, b) = (c1.to_string(), c2.to_string());

    let added = |ws: bool| -> Vec<String> {
        let file = repo
            .compare_file_diff_with(&a, &b, false, "f.txt", None, 3, ws)
            .unwrap()
            .unwrap();
        file.hunks
            .iter()
            .flat_map(|h| &h.lines)
            .filter(|l| l.origin == '+')
            .map(|l| l.content.clone())
            .collect()
    };
    assert_eq!(added(false), vec!["a  b", "C"]);
    assert_eq!(added(true), vec!["C"]);
}
