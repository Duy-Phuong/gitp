//! What takes disk in and around a repository, for the Clean Up Storage
//! dialog: local branches already merged into the default branch (safe to
//! delete), the size of a folder, and the build folders (`target`,
//! `node_modules`) under the work tree.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::error::{Error, Result};
use crate::repo::Repo;

/// Local branches whose tip the default branch already contains.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MergedBranches {
    /// What they are merged into: `origin/main`, or the local `main`.
    pub base: String,
    pub branches: Vec<String>,
}

/// How deep under the work tree build folders are looked for.
const BUILD_DEPTH: usize = 4;
const BUILD_DIRS: [&str; 2] = ["target", "node_modules"];

impl Repo {
    /// The local branches merged into the default branch: every one but the
    /// default branch itself and the checked-out one, whose tip is the base's
    /// or one of its ancestors.
    pub fn merged_branches(&self) -> Result<MergedBranches> {
        let base = self.default_review_base()?;
        let base_oid = self.inner.revparse_single(&base)?.peel_to_commit()?.id();
        let default = self.default_branch_name();
        let head = self
            .inner
            .head()
            .ok()
            .and_then(|h| h.shorthand().map(str::to_string));
        let mut branches = Vec::new();
        for b in self.inner.branches(Some(git2::BranchType::Local))? {
            let (branch, _) = b?;
            let Some(name) = branch.name()?.map(str::to_string) else {
                continue;
            };
            if Some(&name) == default.as_ref() || Some(&name) == head.as_ref() {
                continue;
            }
            let Some(tip) = branch.get().target() else {
                continue;
            };
            if tip == base_oid || self.inner.graph_descendant_of(base_oid, tip)? {
                branches.push(name);
            }
        }
        branches.sort();
        Ok(MergedBranches { base, branches })
    }

    /// The `target` and `node_modules` folders under the work tree, a few
    /// levels down, without looking inside them or `.git`.
    pub fn build_folders(&self) -> Result<Vec<PathBuf>> {
        let root = self.workdir_path()?;
        let mut found = Vec::new();
        walk_build_dirs(&root, 0, &mut found);
        found.sort();
        Ok(found)
    }
}

fn walk_build_dirs(dir: &Path, depth: usize, found: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == ".git" {
            continue;
        }
        if BUILD_DIRS.contains(&name.as_ref()) {
            found.push(entry.path());
        } else if depth + 1 < BUILD_DEPTH {
            walk_build_dirs(&entry.path(), depth + 1, found);
        }
    }
}

/// The disk a folder takes, in bytes, as `du` counts it (blocks a
/// copy-on-write clone shares are counted in full).
pub fn disk_usage(path: &Path) -> Result<u64> {
    let out = Command::new("du")
        .args(["-sk", "--"])
        .arg(path)
        .output()
        .map_err(|e| Error::Message(format!("failed to run du: {e}")))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let kib: u64 = text
        .split_whitespace()
        .next()
        .and_then(|n| n.parse().ok())
        .ok_or_else(|| Error::Message(format!("du gave no size for {}", path.display())))?;
    Ok(kib * 1024)
}
