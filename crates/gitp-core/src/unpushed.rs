//! Commits on the default branch that its upstream doesn't have yet: work
//! that exists only on this machine, which the status bar shows and a quit
//! warns about. Local refs only — no network call.

use serde::Serialize;

use crate::error::Result;
use crate::repo::Repo;

/// The default branch and how many commits it has that its upstream doesn't.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Unpushed {
    pub branch: String,
    pub ahead: usize,
}

impl Repo {
    /// The local default branch: the one `origin/HEAD` names, else `main`,
    /// else `master` — whichever exists as a local branch first.
    pub fn default_branch_name(&self) -> Option<String> {
        let git = &self.inner;
        let from_origin = git
            .find_reference("refs/remotes/origin/HEAD")
            .ok()
            .and_then(|r| r.symbolic_target().map(str::to_string))
            .and_then(|t| t.strip_prefix("refs/remotes/origin/").map(str::to_string));
        from_origin
            .into_iter()
            .chain(["main".to_string(), "master".to_string()])
            .find(|name| git.find_reference(&format!("refs/heads/{name}")).is_ok())
    }

    /// The default branch's commits its upstream doesn't have, or `None`
    /// when there are none, or it has no upstream to compare with.
    pub fn unpushed_default(&self) -> Result<Option<Unpushed>> {
        let Some(name) = self.default_branch_name() else {
            return Ok(None);
        };
        let local = self.inner.find_branch(&name, git2::BranchType::Local)?;
        let Ok(upstream) = local.upstream() else {
            return Ok(None);
        };
        let (Some(here), Some(there)) = (local.get().target(), upstream.get().target()) else {
            return Ok(None);
        };
        let (ahead, _) = self.inner.graph_ahead_behind(here, there)?;
        Ok((ahead > 0).then_some(Unpushed {
            branch: name,
            ahead,
        }))
    }
}
