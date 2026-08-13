//! Full file listing of a commit's tree — every blob path, for the File Tree
//! view. The frontend derives the folder structure from the flat path list.

use crate::error::Result;
use crate::repo::Repo;

impl Repo {
    /// Every file (blob) path in `rev`'s tree, recursively, sorted. Directories
    /// are not listed on their own — they're implied by the paths.
    pub fn commit_tree(&self, rev: &str) -> Result<Vec<String>> {
        let commit = self.inner.revparse_single(rev)?.peel_to_commit()?;
        let tree = commit.tree()?;

        let mut paths = Vec::new();
        tree.walk(git2::TreeWalkMode::PreOrder, |root, entry| {
            if entry.kind() == Some(git2::ObjectType::Blob) {
                if let Some(name) = entry.name() {
                    // `root` is "" at the top level and "dir/" inside subtrees.
                    paths.push(format!("{root}{name}"));
                }
            }
            git2::TreeWalkResult::Ok
        })?;
        paths.sort();
        Ok(paths)
    }
}
