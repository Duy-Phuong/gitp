//! Linked worktrees: listing, adding (existing branch, new branch, detached),
//! removing (clean, dirty, forced), locking and pruning — real repos built
//! with the `git` CLI, which is what these operations shell out to.

use std::path::{Path, PathBuf};
use std::process::Command;

use gitp_core::{Repo, WorktreeTarget};
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {args:?} failed in {dir:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A temp dir holding the main worktree at `main/` (branch `main`, two
/// commits), with room for linked worktrees beside it.
struct Setup {
    root: TempDir,
    first: String,
    second: String,
}

impl Setup {
    fn new() -> Self {
        let root = TempDir::new().unwrap();
        let main = root.path().join("main");
        std::fs::create_dir(&main).unwrap();
        git(&main, &["init", "-q", "-b", "main"]);
        git(&main, &["config", "user.name", "Tester"]);
        git(&main, &["config", "user.email", "t@t.io"]);
        std::fs::write(main.join("a.txt"), "one\n").unwrap();
        git(&main, &["add", "."]);
        git(&main, &["commit", "-q", "-m", "first"]);
        let first = git(&main, &["rev-parse", "HEAD"]);
        std::fs::write(main.join("a.txt"), "two\n").unwrap();
        git(&main, &["commit", "-q", "-am", "second"]);
        let second = git(&main, &["rev-parse", "HEAD"]);
        Self {
            root,
            first,
            second,
        }
    }

    fn main(&self) -> PathBuf {
        self.root.path().join("main")
    }

    /// Where a linked worktree called `name` goes: beside `main/`.
    fn sibling(&self, name: &str) -> PathBuf {
        self.root.path().join(name)
    }

    fn repo(&self) -> Repo {
        Repo::open(self.main()).unwrap()
    }
}

/// Canonical form, so `/var/...` and `/private/var/...` (macOS temp dirs)
/// compare equal.
fn canon(p: impl AsRef<Path>) -> PathBuf {
    std::fs::canonicalize(p).unwrap()
}

#[test]
fn lists_the_main_worktree_and_linked_ones() {
    let s = Setup::new();
    git(
        &s.main(),
        &["worktree", "add", "-q", "-b", "feat", "../linked"],
    );

    let list = s.repo().worktrees().unwrap();
    assert_eq!(list.len(), 2);
    let (main, linked) = (&list[0], &list[1]);

    assert_eq!(canon(&main.path), canon(s.main()));
    assert!(main.is_main && main.is_current);
    assert_eq!(main.branch.as_deref(), Some("main"));
    assert_eq!(main.head.as_deref(), Some(s.second.as_str()));

    assert_eq!(canon(&linked.path), canon(s.sibling("linked")));
    assert!(!linked.is_main && !linked.is_current);
    assert_eq!(linked.branch.as_deref(), Some("feat"));
    assert_eq!(linked.head.as_deref(), Some(s.second.as_str()));
    assert!(!linked.locked && !linked.prunable);

    // Opened from the linked worktree, that one is the current one.
    let from_linked = Repo::open(s.sibling("linked"))
        .unwrap()
        .worktrees()
        .unwrap();
    assert!(!from_linked[0].is_current && from_linked[1].is_current);
}

#[test]
fn adds_a_worktree_for_an_existing_branch() {
    let s = Setup::new();
    git(&s.main(), &["branch", "topic", &s.first]);

    let path = s
        .repo()
        .add_worktree(
            "../topic-wt",
            &WorktreeTarget::Branch {
                name: "topic".into(),
            },
        )
        .unwrap();
    assert_eq!(canon(&path), canon(s.sibling("topic-wt")));
    assert!(s.sibling("topic-wt").join("a.txt").exists());

    let list = s.repo().worktrees().unwrap();
    let wt = list.iter().find(|w| !w.is_main).unwrap();
    assert_eq!(wt.branch.as_deref(), Some("topic"));
    assert_eq!(wt.head.as_deref(), Some(s.first.as_str()));
}

#[test]
fn adds_a_worktree_on_a_new_branch_from_a_revision() {
    let s = Setup::new();
    s.repo()
        .add_worktree(
            "../fresh",
            &WorktreeTarget::NewBranch {
                name: "fresh".into(),
                start: s.first.clone(),
            },
        )
        .unwrap();

    assert_eq!(
        git(&s.main(), &["rev-parse", "refs/heads/fresh"]),
        s.first,
        "the new branch starts at the given revision"
    );
    let list = s.repo().worktrees().unwrap();
    assert_eq!(list[1].branch.as_deref(), Some("fresh"));
}

#[test]
fn adds_a_detached_worktree() {
    let s = Setup::new();
    s.repo()
        .add_worktree(
            "../detached",
            &WorktreeTarget::Detached {
                rev: s.first.clone(),
            },
        )
        .unwrap();

    let list = s.repo().worktrees().unwrap();
    assert_eq!(list[1].branch, None);
    assert_eq!(list[1].head.as_deref(), Some(s.first.as_str()));
}

#[test]
fn adding_a_branch_already_checked_out_elsewhere_fails_with_gits_reason() {
    let s = Setup::new();
    let err = s
        .repo()
        .add_worktree(
            "../again",
            &WorktreeTarget::Branch {
                name: "main".into(),
            },
        )
        .unwrap_err()
        .to_string();
    assert!(err.contains("main"), "{err}");
    assert!(err.contains("already"), "git explains why: {err}");
    assert!(!s.sibling("again").exists(), "nothing was created");
}

#[test]
fn checking_out_a_branch_held_by_another_worktree_is_refused() {
    let s = Setup::new();
    git(
        &s.main(),
        &["worktree", "add", "-q", "-b", "feat", "../linked", &s.first],
    );

    let err = s.repo().checkout_branch("feat").unwrap_err().to_string();
    assert!(err.contains("feat") && err.contains("linked"), "{err}");
    // Nothing moved: still on main, at main's content.
    assert_eq!(git(&s.main(), &["symbolic-ref", "--short", "HEAD"]), "main");
    assert_eq!(
        std::fs::read_to_string(s.main().join("a.txt")).unwrap(),
        "two\n"
    );
}

#[test]
fn removes_a_clean_worktree() {
    let s = Setup::new();
    git(&s.main(), &["worktree", "add", "-q", "--detach", "../gone"]);

    s.repo().remove_worktree(&s.sibling("gone"), false).unwrap();
    assert!(!s.sibling("gone").exists());
    assert_eq!(s.repo().worktrees().unwrap().len(), 1);
}

#[test]
fn remove_refuses_a_dirty_worktree_unless_forced() {
    let s = Setup::new();
    git(
        &s.main(),
        &["worktree", "add", "-q", "--detach", "../dirty"],
    );
    std::fs::write(s.sibling("dirty").join("a.txt"), "edited\n").unwrap();

    let err = s
        .repo()
        .remove_worktree(&s.sibling("dirty"), false)
        .unwrap_err()
        .to_string();
    assert!(err.contains("--force"), "git's refusal is surfaced: {err}");
    assert!(s.sibling("dirty").exists(), "nothing was removed");

    s.repo().remove_worktree(&s.sibling("dirty"), true).unwrap();
    assert!(!s.sibling("dirty").exists());
}

#[test]
fn locks_and_unlocks_a_worktree() {
    let s = Setup::new();
    git(
        &s.main(),
        &["worktree", "add", "-q", "--detach", "../locked"],
    );
    let path = s.sibling("locked");

    s.repo().lock_worktree(&path, "on a USB stick").unwrap();
    let list = s.repo().worktrees().unwrap();
    assert!(list[1].locked);
    assert_eq!(list[1].lock_reason.as_deref(), Some("on a USB stick"));

    s.repo().unlock_worktree(&path).unwrap();
    let list = s.repo().worktrees().unwrap();
    assert!(!list[1].locked);
    assert_eq!(list[1].lock_reason, None);
}

#[test]
fn prunes_a_worktree_whose_folder_was_deleted() {
    let s = Setup::new();
    git(
        &s.main(),
        &["worktree", "add", "-q", "--detach", "../vanished"],
    );
    std::fs::remove_dir_all(s.sibling("vanished")).unwrap();

    let list = s.repo().worktrees().unwrap();
    assert!(list[1].prunable, "its folder is gone");

    s.repo().prune_worktrees().unwrap();
    assert_eq!(s.repo().worktrees().unwrap().len(), 1);
}

#[test]
fn counts_the_changes_of_every_other_worktree() {
    let s = Setup::new();
    // Nothing linked: nothing to count, and no git spawned to find that out.
    assert!(s.repo().other_worktree_changes().unwrap().is_empty());

    git(
        &s.main(),
        &["worktree", "add", "-q", "-b", "dirty", "../dirty"],
    );
    git(
        &s.main(),
        &["worktree", "add", "-q", "-b", "clean", "../clean"],
    );
    git(
        &s.main(),
        &["worktree", "add", "-q", "--detach", "../vanished"],
    );
    std::fs::remove_dir_all(s.sibling("vanished")).unwrap();
    let dirty = s.sibling("dirty");
    // One partially staged file (in both status lists, counted once), one
    // staged new file and one untracked: three paths.
    std::fs::write(dirty.join("a.txt"), "three\n").unwrap();
    git(&dirty, &["add", "a.txt"]);
    std::fs::write(dirty.join("a.txt"), "four\n").unwrap();
    std::fs::write(dirty.join("b.txt"), "new\n").unwrap();
    git(&dirty, &["add", "b.txt"]);
    std::fs::write(dirty.join("c.txt"), "untracked\n").unwrap();
    // The current worktree's own changes are not part of the summary.
    std::fs::write(s.main().join("a.txt"), "main edit\n").unwrap();

    let counts = s.repo().other_worktree_changes().unwrap();
    let count_of = |name: &str| {
        counts
            .iter()
            .find(|c| canon(&c.path) == canon(s.sibling(name)))
            .map(|c| c.changes)
    };
    assert_eq!(
        counts.len(),
        2,
        "the current and the vanished one are left out: {counts:?}"
    );
    assert_eq!(count_of("dirty"), Some(3));
    assert_eq!(count_of("clean"), Some(0));

    // Seen from the linked worktree, the main one is the other one.
    let from_dirty = Repo::open(&dirty)
        .unwrap()
        .other_worktree_changes()
        .unwrap();
    let main = from_dirty
        .iter()
        .find(|c| canon(&c.path) == canon(s.main()))
        .expect("main is listed");
    assert_eq!(main.changes, 1);
    assert!(from_dirty.iter().all(|c| canon(&c.path) != canon(&dirty)));
}
