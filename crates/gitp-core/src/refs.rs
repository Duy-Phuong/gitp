//! Reference listing for the sidebar: local branches (with ahead/behind vs their
//! upstream), remote-tracking branches, tags, and stashes.

use serde::Serialize;

use crate::error::Result;
use crate::repo::Repo;

/// A local branch and how far it is ahead/behind its upstream.
#[derive(Debug, Clone, Serialize)]
pub struct BranchRef {
    /// Short name, e.g. `master` or `feature/widget`.
    pub name: String,
    pub is_head: bool,
    /// Commits on the local branch not on its upstream (0 if no upstream).
    pub ahead: usize,
    /// Commits on the upstream not on the local branch (0 if no upstream).
    pub behind: usize,
    /// Full hex oid of the branch tip, so the UI can jump to that commit.
    pub target: String,
}

/// A remote-tracking branch, e.g. `origin/master`.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteBranch {
    /// The remote it belongs to, e.g. `origin`.
    pub remote: String,
    /// Full tracking name, e.g. `origin/master`.
    pub name: String,
    /// Full hex oid of the branch tip.
    pub target: String,
}

/// A tag and the commit it resolves to (peeled through annotated tags).
#[derive(Debug, Clone, Serialize)]
pub struct TagRef {
    pub name: String,
    pub target: String,
}

/// One entry in the stash stack.
#[derive(Debug, Clone, Serialize)]
pub struct StashRef {
    /// Stack position: 0 is the most recent (`stash@{0}`).
    pub index: usize,
    pub message: String,
}

/// Everything the sidebar's ref tree needs, in one shot.
#[derive(Debug, Clone, Serialize)]
pub struct Refs {
    /// Name of the checked-out branch, if HEAD is not detached.
    pub head: Option<String>,
    pub branches: Vec<BranchRef>,
    pub remotes: Vec<RemoteBranch>,
    pub tags: Vec<TagRef>,
    pub stashes: Vec<StashRef>,
}

impl Repo {
    /// List branches, remote-tracking branches, tags and stashes.
    pub fn refs(&self) -> Result<Refs> {
        let repo = &self.inner;

        let mut branches = Vec::new();
        let mut head = None;
        for entry in repo.branches(Some(git2::BranchType::Local))? {
            let (branch, _) = entry?;
            let name = match branch.name()? {
                Some(n) => n.to_string(),
                None => continue,
            };
            let is_head = branch.is_head();
            if is_head {
                head = Some(name.clone());
            }
            let (ahead, behind) = ahead_behind(repo, &branch);
            let target = branch
                .get()
                .target()
                .map(|oid| oid.to_string())
                .unwrap_or_default();
            branches.push(BranchRef {
                name,
                is_head,
                ahead,
                behind,
                target,
            });
        }
        branches.sort_by(|a, b| a.name.cmp(&b.name));

        let mut remotes = Vec::new();
        for entry in repo.branches(Some(git2::BranchType::Remote))? {
            let (branch, _) = entry?;
            if let Some(name) = branch.name()? {
                // Skip the symbolic `origin/HEAD` pointer.
                if name.ends_with("/HEAD") {
                    continue;
                }
                let remote = name.split('/').next().unwrap_or("").to_string();
                let target = branch
                    .get()
                    .target()
                    .map(|oid| oid.to_string())
                    .unwrap_or_default();
                remotes.push(RemoteBranch {
                    remote,
                    name: name.to_string(),
                    target,
                });
            }
        }
        remotes.sort_by(|a, b| a.name.cmp(&b.name));

        let mut tags: Vec<TagRef> = repo
            .tag_names(None)?
            .iter()
            .flatten()
            .map(|name| TagRef {
                name: name.to_string(),
                // Peel through annotated tags to the underlying commit.
                target: repo
                    .revparse_single(name)
                    .and_then(|obj| obj.peel_to_commit())
                    .map(|c| c.id().to_string())
                    .unwrap_or_default(),
            })
            .collect();
        tags.sort_by(|a, b| a.name.cmp(&b.name));

        Ok(Refs {
            head,
            branches,
            remotes,
            tags,
            stashes: read_stashes(repo),
        })
    }
}

/// Ahead/behind counts for `branch` vs its upstream, or (0, 0) if it has none.
fn ahead_behind(repo: &git2::Repository, branch: &git2::Branch) -> (usize, usize) {
    let local = match branch.get().target() {
        Some(oid) => oid,
        None => return (0, 0),
    };
    let upstream = match branch.upstream() {
        Ok(u) => u,
        Err(_) => return (0, 0),
    };
    let up = match upstream.get().target() {
        Some(oid) => oid,
        None => return (0, 0),
    };
    repo.graph_ahead_behind(local, up).unwrap_or((0, 0))
}

/// The full stash stack, read from the reflog of `refs/stash` (index 0 = newest).
fn read_stashes(repo: &git2::Repository) -> Vec<StashRef> {
    let reflog = match repo.reflog("refs/stash") {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    (0..reflog.len())
        .filter_map(|i| {
            reflog.get(i).map(|entry| StashRef {
                index: i,
                message: entry.message().unwrap_or("").to_string(),
            })
        })
        .collect()
}
