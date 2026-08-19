//! History walk. Produces flat `CommitRow`s newest-first.
//!
//! Graph-lane data (for rendering branch lanes) is layered on in `graph.rs`.

use serde::Serialize;

use crate::error::Result;
use crate::repo::Repo;

/// Options controlling a history walk.
#[derive(Debug, Default, Clone)]
pub struct LogOptions {
    /// Stop after this many commits. `None` walks the whole reachable history.
    pub max_count: Option<usize>,
    /// Seed the walk from every local and remote branch tip (plus HEAD) rather
    /// than HEAD alone, so the graph shows all branches. Default `false`
    /// (current branch only).
    pub all_branches: bool,
}

/// One commit in the log, as plain data for frontends to render.
#[derive(Debug, Clone, Serialize)]
pub struct CommitRow {
    /// Full 40-char hex object id.
    pub id: String,
    /// Abbreviated id (7 chars) for display.
    pub short_id: String,
    /// First line of the commit message.
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    /// Author time, seconds since the Unix epoch.
    pub time: i64,
    /// Full hex ids of parent commits (first parent first).
    pub parents: Vec<String>,
    /// Column this commit's node occupies in the graph (0 = leftmost).
    pub lane: usize,
    /// Colour bucket for this commit's strand (stable along a branch).
    pub color: usize,
}

impl Repo {
    /// Walk history newest-first (topological + time ordered), starting from
    /// HEAD. With `options.all_branches`, also seed from every local and
    /// remote-tracking branch tip, so the graph shows commits on branches not
    /// reachable from HEAD — e.g. a remote branch ahead of the current one.
    /// Missing categories (say, no remotes) are skipped; an empty repo yields
    /// an empty log.
    pub fn log(&self, options: LogOptions) -> Result<Vec<CommitRow>> {
        let mut walk = self.inner.revwalk()?;
        if options.all_branches {
            let _ = walk.push_glob("refs/heads/*");
            let _ = walk.push_glob("refs/remotes/*");
        }
        let _ = walk.push_head();
        walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;

        let mut rows = Vec::new();
        for oid in walk {
            if let Some(max) = options.max_count {
                if rows.len() >= max {
                    break;
                }
            }
            let oid = oid?;
            let commit = self.inner.find_commit(oid)?;
            let author = commit.author();
            rows.push(CommitRow {
                id: oid.to_string(),
                short_id: oid.to_string()[..7].to_string(),
                summary: commit.summary().unwrap_or("").to_string(),
                author_name: author.name().unwrap_or("").to_string(),
                author_email: author.email().unwrap_or("").to_string(),
                time: author.when().seconds(),
                parents: commit.parent_ids().map(|p| p.to_string()).collect(),
                lane: 0,
                color: 0,
            });
        }
        crate::graph::assign_lanes(&mut rows);
        Ok(rows)
    }
}
