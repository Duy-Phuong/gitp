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
fn worktrees_share_one_common_dir_and_know_their_main() {
    let s = Setup::new();
    git(
        &s.main(),
        &["worktree", "add", "-q", "-b", "feat", "../linked"],
    );
    let main = s.repo();
    let linked = Repo::open(s.sibling("linked")).unwrap();

    assert_eq!(main.common_dir(), canon(s.main().join(".git")));
    assert_eq!(linked.common_dir(), main.common_dir());
    assert_eq!(main.main_worktree(), None);
    assert_eq!(canon(linked.main_worktree().unwrap()), canon(s.main()));

    // Another repository has a common dir of its own.
    let other = Setup::new();
    assert_ne!(other.repo().common_dir(), main.common_dir());
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
fn summaries_count_changes_and_ahead_behind_per_worktree() {
    let s = Setup::new();
    let remote = s.sibling("remote.git");
    git(
        s.root.path(),
        &["init", "-q", "--bare", remote.to_str().unwrap()],
    );
    git(
        &s.main(),
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&s.main(), &["push", "-q", "-u", "origin", "main"]);
    git(
        &s.main(),
        &["worktree", "add", "-q", "-b", "feat", "../linked"],
    );
    let linked = s.sibling("linked");
    git(&linked, &["push", "-q", "-u", "origin", "feat"]);
    // feat: one commit ahead of origin/feat, one edit and one new file.
    std::fs::write(linked.join("b.txt"), "b\n").unwrap();
    git(&linked, &["add", "b.txt"]);
    git(&linked, &["commit", "-q", "-m", "third"]);
    std::fs::write(linked.join("a.txt"), "edited\n").unwrap();
    std::fs::write(linked.join("new.txt"), "new\n").unwrap();
    // main: behind origin/main by one (reset back after the push).
    git(&s.main(), &["reset", "-q", "--hard", &s.first]);

    let list = s.repo().worktree_summaries().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(canon(&list[0].path), canon(s.main()));
    assert_eq!((list[0].changed, list[0].ahead, list[0].behind), (0, 0, 1));
    assert_eq!(canon(&list[1].path), canon(&linked));
    assert_eq!((list[1].changed, list[1].ahead, list[1].behind), (2, 1, 0));
}

#[test]
fn summaries_leave_out_a_worktree_whose_folder_is_gone() {
    let s = Setup::new();
    git(
        &s.main(),
        &["worktree", "add", "-q", "--detach", "../vanished"],
    );
    std::fs::remove_dir_all(s.sibling("vanished")).unwrap();
    assert_eq!(s.repo().worktree_summaries().unwrap().len(), 1);
}

#[test]
fn unsaved_work_lists_uncommitted_files_and_unpushed_commits() {
    let s = Setup::new();
    let remote = s.sibling("remote.git");
    git(
        s.root.path(),
        &["init", "-q", "--bare", remote.to_str().unwrap()],
    );
    git(
        &s.main(),
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&s.main(), &["push", "-q", "origin", "main"]);
    git(
        &s.main(),
        &["worktree", "add", "-q", "-b", "feat", "../linked"],
    );
    let linked = s.sibling("linked");

    // Clean, and nothing beyond what origin/main has.
    let clean = s.repo().worktree_unsaved_work(&linked).unwrap();
    assert!(clean.changed.is_empty());
    assert_eq!(clean.unpushed, 0);

    // No upstream: commits on no remote branch count as unpushed.
    git(
        &linked,
        &["commit", "-q", "--allow-empty", "-m", "local only"],
    );
    std::fs::write(linked.join("a.txt"), "edited\n").unwrap();
    std::fs::write(linked.join("untracked.txt"), "u\n").unwrap();
    let work = s.repo().worktree_unsaved_work(&linked).unwrap();
    assert_eq!(work.changed, ["a.txt", "untracked.txt"]);
    assert_eq!(work.untracked, 1);
    assert_eq!(work.unpushed, 1);

    // With an upstream: what it's ahead of that.
    git(&linked, &["push", "-q", "-u", "origin", "feat"]);
    git(&linked, &["commit", "-q", "--allow-empty", "-m", "two"]);
    git(&linked, &["commit", "-q", "--allow-empty", "-m", "three"]);
    assert_eq!(s.repo().worktree_unsaved_work(&linked).unwrap().unpushed, 2);
}

#[test]
fn unsaved_work_on_a_detached_head_counts_commits_no_branch_has() {
    let s = Setup::new();
    git(
        &s.main(),
        &["worktree", "add", "-q", "--detach", "../detached"],
    );
    let wt = s.sibling("detached");
    assert_eq!(s.repo().worktree_unsaved_work(&wt).unwrap().unpushed, 0);
    git(
        &wt,
        &["commit", "-q", "--allow-empty", "-m", "orphan-to-be"],
    );
    assert_eq!(s.repo().worktree_unsaved_work(&wt).unwrap().unpushed, 1);
}

#[test]
fn unsaved_work_without_any_remote_reports_nothing_unpushed() {
    let s = Setup::new();
    git(
        &s.main(),
        &["worktree", "add", "-q", "-b", "feat", "../linked"],
    );
    git(
        &s.sibling("linked"),
        &["commit", "-q", "--allow-empty", "-m", "x"],
    );
    let work = s
        .repo()
        .worktree_unsaved_work(&s.sibling("linked"))
        .unwrap();
    assert_eq!(work.unpushed, 0, "nowhere to push it");
}

#[test]
fn moves_a_linked_worktree() {
    let s = Setup::new();
    git(
        &s.main(),
        &["worktree", "add", "-q", "-b", "feat", "../before"],
    );

    let to = s
        .repo()
        .move_worktree(&s.sibling("before"), "../after")
        .unwrap();
    assert_eq!(canon(&to), canon(s.sibling("after")));
    assert!(!s.sibling("before").exists());
    assert!(s.sibling("after").join("a.txt").exists());
    let list = s.repo().worktrees().unwrap();
    assert_eq!(canon(&list[1].path), canon(s.sibling("after")));
    assert_eq!(list[1].branch.as_deref(), Some("feat"));
}

#[test]
fn move_refuses_the_main_worktree_and_a_locked_one() {
    let s = Setup::new();
    let err = s
        .repo()
        .move_worktree(&s.main(), "../elsewhere")
        .unwrap_err()
        .to_string();
    assert!(err.contains("main worktree"), "{err}");

    git(
        &s.main(),
        &["worktree", "add", "-q", "--detach", "../pinned"],
    );
    s.repo()
        .lock_worktree(&s.sibling("pinned"), "on a USB stick")
        .unwrap();
    let err = s
        .repo()
        .move_worktree(&s.sibling("pinned"), "../elsewhere")
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("locked") && err.contains("on a USB stick"),
        "{err}"
    );
    assert!(err.contains("Unlock"), "{err}");
    assert!(s.sibling("pinned").exists() && !s.sibling("elsewhere").exists());
}

#[test]
fn stale_worktrees_lists_what_prune_would_remove_without_removing_it() {
    let s = Setup::new();
    assert!(s.repo().stale_worktrees().unwrap().is_empty());

    git(
        &s.main(),
        &["worktree", "add", "-q", "--detach", "../vanished"],
    );
    std::fs::remove_dir_all(s.sibling("vanished")).unwrap();

    let stale = s.repo().stale_worktrees().unwrap();
    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0].name, "vanished");
    assert!(!stale[0].reason.is_empty());
    assert_eq!(
        s.repo().worktrees().unwrap().len(),
        2,
        "dry run: still listed"
    );
}

#[test]
fn summaries_count_each_changed_path_of_every_worktree_once() {
    let s = Setup::new();
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
    // The current worktree is summarised too.
    std::fs::write(s.main().join("a.txt"), "main edit\n").unwrap();

    let list = s.repo().worktree_summaries().unwrap();
    let count_of = |name: &Path| {
        list.iter()
            .find(|w| canon(&w.path) == canon(name))
            .map(|w| w.changed)
    };
    assert_eq!(list.len(), 3, "the vanished one is left out: {list:?}");
    assert_eq!(count_of(&s.main()), Some(1));
    assert_eq!(count_of(&dirty), Some(3));
    assert_eq!(count_of(&s.sibling("clean")), Some(0));

    // Seen from the linked worktree, the same counts.
    let from_dirty = Repo::open(&dirty).unwrap().worktree_summaries().unwrap();
    assert_eq!(from_dirty, list);
}
