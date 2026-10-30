//! Submodules: what each one has checked out against what the superproject
//! records, `git submodule update` / `sync` to reconcile them, and adding,
//! re-pointing and removing one.
//!
//! Status comes from libgit2 (no output to parse, and it honours each
//! submodule's `ignore` setting as `git status` does). Update shells out like
//! the other network commands — it clones and fetches with the user's own
//! credentials — and runs with progress and Cancel (see `progress.rs`).

use std::path::{Component, Path};

use serde::Serialize;

use crate::error::{Error, Result};
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
            // libgit2 also lists one only HEAD still has — removed, with the
            // removal staged but not yet committed. It's gone as far as the
            // user is concerned.
            if !status.intersects(S::IN_INDEX | S::IN_CONFIG) {
                continue;
            }
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

    /// `git submodule add -- <url> [<path>]`: clone `url` into `path` (by
    /// default git's name for it: the URL's last part, minus `.git`) and stage
    /// it with its `.gitmodules` entry, for the user to commit. Clones, so it
    /// runs with progress and Cancel like `update_submodules`.
    pub fn add_submodule(&self, url: &str, path: Option<&str>) -> Result<String> {
        let url = submodule_url_arg(url)?;
        let mut args = vec!["submodule", "add", "--progress", "--", url];
        if let Some(path) = path {
            submodule_path_arg(path)?;
            args.push(path);
        }
        self.run_git_progress(&args)
    }

    /// `git submodule set-url -- <path> <url>`: point the submodule at a new
    /// URL in `.gitmodules`, and sync it into the config and the submodule's
    /// own remote. The `.gitmodules` change is left for the user to commit.
    pub fn set_submodule_url(&self, path: &str, url: &str) -> Result<String> {
        let url = submodule_url_arg(url)?;
        submodule_path_arg(path)?;
        self.run_git(&["submodule", "set-url", "--", path, url])
    }

    /// Remove the submodule at `path` the way git's docs describe: `deinit -f`
    /// (empty its folder, drop its config), `git rm -f` (drop the folder and
    /// its `.gitmodules` entry — the removal ends up staged, for the user to
    /// commit), then delete its clone under `.git/modules`, which neither of
    /// those touches and which would otherwise be silently reused by a later
    /// add of the same name.
    pub fn remove_submodule(&self, path: &str) -> Result<String> {
        submodule_path_arg(path)?;
        let name = self
            .submodules()?
            .into_iter()
            .find(|sm| sm.path == path)
            .map(|sm| sm.name)
            .ok_or_else(|| Error::Message(format!("No submodule at {path}.")))?;
        let mut out = vec![self.run_git(&["submodule", "deinit", "-f", "--", path])?];
        out.push(self.run_git(&["rm", "-f", "--", path])?);
        // The name comes from .gitmodules; git refuses ones that climb out of
        // `modules/`, but this is a recursive delete, so check again.
        if relative_inside(&name) {
            // The common dir, not this worktree's: that's where modules live.
            let common =
                self.run_git(&["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
            let clone = Path::new(&common).join("modules").join(&name);
            if clone.is_dir() {
                std::fs::remove_dir_all(&clone).map_err(|e| {
                    Error::Message(format!("can't remove {}: {e}", clone.display()))
                })?;
            }
        }
        Ok(out.join("\n").trim().to_string())
    }
}

/// A submodule URL from the user, trimmed: present, and not readable as an
/// option.
fn submodule_url_arg(url: &str) -> Result<&str> {
    let url = url.trim();
    if url.is_empty() {
        return Err(Error::Message("Enter the submodule's URL.".into()));
    }
    if url.starts_with('-') {
        return Err(Error::Message(format!("\"{url}\" can't be a URL.")));
    }
    Ok(url)
}

/// A submodule path from the user: relative, inside the working tree, and
/// not readable as an option.
fn submodule_path_arg(path: &str) -> Result<()> {
    if path.trim().is_empty() {
        return Err(Error::Message("Enter the folder for the submodule.".into()));
    }
    if path.starts_with('-') || !relative_inside(path) {
        return Err(Error::Message(format!(
            "\"{path}\" must be a folder inside the repository, without \"..\"."
        )));
    }
    Ok(())
}

/// Relative, with no `..` component (nor a root or drive prefix).
fn relative_inside(path: &str) -> bool {
    Path::new(path)
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}
