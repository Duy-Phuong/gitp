//! Submodules: what each one has checked out against what the superproject
//! records, and `git submodule update` / `sync` to reconcile them.
//!
//! Status comes from libgit2 (no output to parse, and it honours each
//! submodule's `ignore` setting as `git status` does). Update shells out like
//! the other network commands — it clones and fetches with the user's own
//! credentials — and runs with progress and Cancel (see `progress.rs`).

use serde::Serialize;

use crate::error::Result;
use crate::repo::Repo;

/// Where a submodule stands relative to the commit the superproject records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmoduleState {
    /// Not cloned / checked out yet (`git submodule update --init` would).
    Uninitialized,
    /// The recorded commit is checked out and nothing in it is changed.
    UpToDate,
    /// A different commit is checked out than the one recorded.
    Modified,
    /// The recorded commit is checked out, but its files have local changes.
    Dirty,
}

/// One submodule of the repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Submodule {
    pub name: String,
    /// Path relative to the superproject's working directory.
    pub path: String,
    pub url: Option<String>,
    /// The commit the superproject records for it — in the index, which is
    /// what `update` checks out and the next commit will record.
    pub recorded: Option<String>,
    /// The commit actually checked out in its folder; `None` when uninitialized.
    pub checked_out: Option<String>,
    pub state: SubmoduleState,
}

impl Repo {
    /// Every submodule declared in `.gitmodules`, in path order.
    pub fn submodules(&self) -> Result<Vec<Submodule>> {
        use git2::SubmoduleStatus as S;

        let mut list = Vec::new();
        for sm in self.inner.submodules()? {
            let name = sm.name().unwrap_or_default().to_string();
            // Unspecified: use the submodule's own `ignore` config, like git status.
            let status = self
                .inner
                .submodule_status(&name, git2::SubmoduleIgnore::Unspecified)?;
            let checked_out = sm.workdir_id();
            let state = if status.contains(S::WD_UNINITIALIZED) || checked_out.is_none() {
                SubmoduleState::Uninitialized
            } else if status.contains(S::WD_MODIFIED) {
                SubmoduleState::Modified
            } else if status.intersects(S::WD_INDEX_MODIFIED | S::WD_WD_MODIFIED | S::WD_UNTRACKED)
            {
                SubmoduleState::Dirty
            } else {
                SubmoduleState::UpToDate
            };
            list.push(Submodule {
                name,
                path: sm.path().to_string_lossy().into_owned(),
                url: sm.url().map(str::to_string),
                recorded: sm.index_id().or(sm.head_id()).map(|id| id.to_string()),
                checked_out: checked_out.map(|id| id.to_string()),
                state,
            });
        }
        list.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(list)
    }

    /// `git submodule update --init --recursive`, for the submodule at `path`
    /// or, with `None`, all of them: clone what isn't yet, and check out the
    /// recorded commit everywhere (detached, as git does). Reports progress
    /// and honours Cancel through the network hooks.
    pub fn update_submodules(&self, path: Option<&str>) -> Result<String> {
        let mut args = vec!["submodule", "update", "--progress", "--init", "--recursive"];
        if let Some(path) = path {
            args.extend(["--", path]);
        }
        self.run_git_progress(&args)
    }

    /// `git submodule sync --recursive`: copy each submodule's URL from
    /// `.gitmodules` into the repository's config (and the submodule's
    /// remote), after it changed upstream. Local only.
    pub fn sync_submodules(&self, path: Option<&str>) -> Result<String> {
        let mut args = vec!["submodule", "sync", "--recursive"];
        if let Some(path) = path {
            args.extend(["--", path]);
        }
        self.run_git(&args)
    }
}
