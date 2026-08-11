//! Test fixtures: build hermetic temp repos in-process via git2.
//!
//! Each integration-test binary uses only a subset of these helpers, so unused
//! ones are expected here.
#![allow(dead_code)]

use std::path::Path;
use tempfile::TempDir;

/// A throwaway git repo in a temp dir. Dropping it deletes the repo.
pub struct FixtureRepo {
    pub dir: TempDir,
    pub repo: git2::Repository,
}

impl FixtureRepo {
    /// Initialize an empty repo with a deterministic identity configured.
    pub fn init() -> Self {
        let dir = TempDir::new().expect("temp dir");
        let repo = git2::Repository::init(dir.path()).expect("git init");
        {
            let mut cfg = repo.config().expect("config");
            cfg.set_str("user.name", "Fixture Author").unwrap();
            cfg.set_str("user.email", "author@example.com").unwrap();
        }
        Self { dir, repo }
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    /// Create a commit with explicit parents and an explicit author time
    /// (seconds since epoch), decoupled from the working tree. Each commit gets
    /// a unique tree derived from `message`. Does not move any ref.
    ///
    /// `time` lets tests force a deterministic newest-first ordering among
    /// sibling branches.
    pub fn commit_raw(&self, message: &str, parents: &[git2::Oid], time: i64) -> git2::Oid {
        let blob = self.repo.blob(message.as_bytes()).unwrap();
        let mut tb = self.repo.treebuilder(None).unwrap();
        tb.insert(format!("{message}.txt"), blob, 0o100644).unwrap();
        let tree = self.repo.find_tree(tb.write().unwrap()).unwrap();

        let when = git2::Time::new(time, 0);
        let sig = git2::Signature::new("Fixture Author", "author@example.com", &when).unwrap();

        let parent_commits: Vec<git2::Commit> = parents
            .iter()
            .map(|p| self.repo.find_commit(*p).unwrap())
            .collect();
        let parent_refs: Vec<&git2::Commit> = parent_commits.iter().collect();

        self.repo
            .commit(None, &sig, &sig, message, &tree, &parent_refs)
            .unwrap()
    }

    /// Point HEAD (via `refs/heads/main`) at `oid`, so `Repo::log` walks from it.
    pub fn point_head_at(&self, oid: git2::Oid) {
        self.repo
            .reference("refs/heads/main", oid, true, "fixture")
            .unwrap();
        self.repo.set_head("refs/heads/main").unwrap();
    }

    /// Write a file, stage it, and commit. Returns the new commit's oid.
    /// Parents are the current HEAD (if any).
    pub fn commit_file(&self, name: &str, contents: &str, message: &str) -> git2::Oid {
        let full = self.dir.path().join(name);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&full, contents).unwrap();

        let mut index = self.repo.index().unwrap();
        index.add_path(Path::new(name)).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = self.repo.find_tree(tree_oid).unwrap();

        let sig = self.repo.signature().unwrap();
        let parents = match self.repo.head() {
            Ok(head) => {
                let commit = head.peel_to_commit().unwrap();
                vec![commit]
            }
            Err(_) => vec![],
        };
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        self.repo
            .commit(Some("HEAD"), &sig, &sig, message, &tree, &parent_refs)
            .unwrap()
    }
}
