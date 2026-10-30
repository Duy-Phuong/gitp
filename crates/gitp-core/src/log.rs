//! History walk. Produces flat `CommitRow`s newest-first.
//!
//! Graph-lane data (for rendering branch lanes) is layered on in `graph.rs`.

use std::collections::{BinaryHeap, HashMap, HashSet};

use serde::{Deserialize, Serialize};

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

/// What a cached log covers and how it is laid out, besides the refs
/// themselves: the frontend's history toggle and its per-repo graph settings.
/// The log is cached against it (see `LogCache::scope`).
#[derive(Debug, Default, Clone, PartialEq, Eq, Deserialize)]
pub struct LogScope {
    /// Walk every branch (see `LogOptions::all_branches`), or HEAD alone.
    pub all_branches: bool,
    /// A local branch whose first-parent chain keeps lane 0 ("Pin to Left").
    /// Ignored when the branch is gone or isn't in the walk.
    #[serde(default)]
    pub pinned: Option<String>,
    /// Full ref names (`refs/heads/x`, `refs/remotes/origin/x`) the
    /// all-branches walk leaves out ("Hide"). Their commits still show when
    /// another ref reaches them.
    #[serde(default)]
    pub hidden: Vec<String>,
    /// Full ref names to walk from instead of every branch ("Solo"), in either
    /// mode. HEAD is always walked as well.
    #[serde(default)]
    pub solo: Vec<String>,
}

impl LogScope {
    /// Whether the two walk from the same refs, i.e. differ in layout at most.
    fn same_walk(&self, other: &LogScope) -> bool {
        self.all_branches == other.all_branches
            && self.hidden == other.hidden
            && self.solo == other.solo
    }
}

/// Just the history toggle, with nothing pinned.
impl From<bool> for LogScope {
    fn from(all_branches: bool) -> Self {
        LogScope {
            all_branches,
            ..LogScope::default()
        }
    }
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

/// A full log plus the branch tips it was walked from, so that
/// `Repo::refresh_log` can later walk just the commits added since.
#[derive(Debug, Clone)]
pub struct LogCache {
    /// Every reachable commit, newest-first, with graph lanes assigned.
    pub rows: Vec<CommitRow>,
    scope: LogScope,
    /// The commits the walk was seeded from, sorted and deduplicated.
    tips: Vec<git2::Oid>,
    /// The pinned branch's tip the lanes were laid out with.
    pinned_tip: Option<String>,
    /// Lowercased message bodies by commit id, read in by the first search
    /// that needs them (see `Repo::search_log`).
    pub(crate) bodies: HashMap<String, Box<str>>,
}

impl LogCache {
    /// Whether this log was walked from every branch or from HEAD alone.
    pub fn all_branches(&self) -> bool {
        self.scope.all_branches
    }

    /// What this log covers and how it is laid out.
    pub fn scope(&self) -> &LogScope {
        &self.scope
    }
}

/// How `Repo::refresh_log` brought a `LogCache` up to date.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogRefresh {
    /// The tips haven't moved, so neither has the log.
    Unchanged,
    /// The same commits, with the lanes laid out again for another pinned
    /// branch.
    Relaid,
    /// Every cached commit is still reachable: only the `added` new commits
    /// were walked, and put above the cached rows.
    Extended { added: usize },
    /// A cached commit may have dropped out of history (a deleted branch, a
    /// reset, an amend, a rebase) or the mode changed: the whole history was
    /// walked again.
    Full,
}

impl Repo {
    /// Walk history newest-first (topological + time ordered), starting from
    /// HEAD. With `options.all_branches`, also seed from every local and
    /// remote-tracking branch tip, so the graph shows commits on branches not
    /// reachable from HEAD — e.g. a remote branch ahead of the current one.
    /// Missing categories (say, no remotes) are skipped; an empty repo yields
    /// an empty log.
    pub fn log(&self, options: LogOptions) -> Result<Vec<CommitRow>> {
        let tips = self.log_tips(&options.all_branches.into())?;
        let mut rows = self.walk_rows(&tips, options.max_count)?;
        crate::graph::assign_lanes(&mut rows, None);
        Ok(rows)
    }

    /// The full log (as `log` with no `max_count`), kept with the tips it was
    /// walked from so `refresh_log` can extend it cheaply later.
    pub fn log_cache(&self, all_branches: bool) -> Result<LogCache> {
        self.log_cache_scoped(&all_branches.into())
    }

    /// `log_cache` for a full `LogScope`.
    pub fn log_cache_scoped(&self, scope: &LogScope) -> Result<LogCache> {
        let tips = self.log_tips(scope)?;
        let mut rows = self.walk_rows(&tips, None)?;
        let pinned_tip = self.pinned_tip(scope);
        crate::graph::assign_lanes(&mut rows, pinned_tip.as_deref());
        Ok(LogCache {
            rows,
            scope: scope.clone(),
            tips,
            pinned_tip,
            bodies: HashMap::new(),
        })
    }

    /// The commit the scope's pinned branch points at, if it still exists.
    fn pinned_tip(&self, scope: &LogScope) -> Option<String> {
        let name = scope.pinned.as_deref()?;
        let branch = self.inner.find_branch(name, git2::BranchType::Local).ok()?;
        let commit = branch.get().peel_to_commit().ok()?;
        Some(commit.id().to_string())
    }

    /// Bring `cache` up to date with the current refs.
    ///
    /// A full walk on a 100k-commit repo is a noticeable stall, and nearly
    /// every change — a commit, a fetch, a new branch — only *adds* history.
    /// When every old tip is still reachable from the new ones, no cached
    /// commit can have disappeared, so only the commits missing from the cache
    /// need reading. None of them is an ancestor of a cached commit, so putting
    /// them all above the cached rows keeps the order topological; it may
    /// differ from a fresh walk only in where the new commits would have
    /// interleaved by date. Anything else falls back to a full walk.
    pub fn refresh_log(&self, cache: &mut LogCache, all_branches: bool) -> Result<LogRefresh> {
        self.refresh_log_scoped(cache, &all_branches.into())
    }

    /// `refresh_log` for a full `LogScope`. A different pinned branch only
    /// lays the lanes out again; a different walk (the toggle, hidden or
    /// soloed refs) is a full walk, so the commits of a ref shown again are
    /// interleaved by date rather than all put on top.
    pub fn refresh_log_scoped(&self, cache: &mut LogCache, scope: &LogScope) -> Result<LogRefresh> {
        let tips = self.log_tips(scope)?;
        let pinned_tip = self.pinned_tip(scope);
        let relaid = pinned_tip != cache.pinned_tip;
        // The same tips walk the same commits, whatever the scope says — so
        // hiding a tag, or a branch in Current mode, costs no walk at all.
        if tips == cache.tips {
            cache.scope = scope.clone();
            if !relaid {
                return Ok(LogRefresh::Unchanged);
            }
            crate::graph::assign_lanes(&mut cache.rows, pinned_tip.as_deref());
            cache.pinned_tip = pinned_tip;
            return Ok(LogRefresh::Relaid);
        }
        if scope.same_walk(&cache.scope) {
            cache.scope = scope.clone();
            if let Some(new_rows) = self.commits_since(cache, &tips)? {
                let added = new_rows.len();
                if added > 0 || relaid {
                    cache.rows.splice(0..0, new_rows);
                    // The new strands shift the lanes of everything below them.
                    crate::graph::assign_lanes(&mut cache.rows, pinned_tip.as_deref());
                }
                cache.tips = tips;
                cache.pinned_tip = pinned_tip;
                return Ok(LogRefresh::Extended { added });
            }
        }
        // A commit's message never changes, so the bodies read so far stay good.
        let bodies = std::mem::take(&mut cache.bodies);
        *cache = self.log_cache_scoped(scope)?;
        cache.bodies = bodies;
        Ok(LogRefresh::Full)
    }

    /// The commits reachable from `tips` but not in `cache`, newest first in
    /// topological order — or `None` if some cached commit is no longer
    /// reachable from `tips`.
    fn commits_since(
        &self,
        cache: &LogCache,
        tips: &[git2::Oid],
    ) -> Result<Option<Vec<CommitRow>>> {
        let cached: HashSet<&str> = cache.rows.iter().map(|r| r.id.as_str()).collect();

        // Read the new commits by following parents down from the new tips
        // until they reach the cache. Not a revwalk hiding the old tips: that
        // has libgit2 walk down to the oldest hidden tip, which in a repo with
        // a branch left at some ancient commit costs as much as a full walk.
        let mut found: Vec<(i64, CommitRow)> = Vec::new();
        let mut seen: HashSet<git2::Oid> = HashSet::new();
        let mut stack: Vec<git2::Oid> = tips.to_vec();
        while let Some(oid) = stack.pop() {
            if !seen.insert(oid) || cached.contains(oid.to_string().as_str()) {
                continue;
            }
            // A parent missing from both the cache and the object store (a
            // shallow clone's boundary, say): let the full walk deal with it.
            let Ok(commit) = self.inner.find_commit(oid) else {
                return Ok(None);
            };
            stack.extend(commit.parent_ids());
            found.push((commit.time().seconds(), row_for(&commit)));
        }

        // Every old tip must still be reachable. Paths down from the new tips
        // leave the new commits through their parents (or start at a tip that
        // was already cached), so those are where reachability enters the
        // cached rows; from there it flows down parent links, and the rows are
        // in child-before-parent order, so one pass settles it.
        let tip_ids: Vec<String> = tips.iter().map(|t| t.to_string()).collect();
        let mut reached: HashSet<&str> = found
            .iter()
            .flat_map(|(_, r)| r.parents.iter().map(String::as_str))
            .chain(tip_ids.iter().map(String::as_str))
            .filter(|id| cached.contains(id))
            .collect();
        let old_tips: Vec<String> = cache.tips.iter().map(|t| t.to_string()).collect();
        let mut pending: HashSet<&str> = old_tips
            .iter()
            .map(String::as_str)
            .filter(|id| !reached.contains(id))
            .collect();
        for row in &cache.rows {
            if pending.is_empty() {
                break;
            }
            if reached.contains(row.id.as_str()) {
                pending.remove(row.id.as_str());
                reached.extend(row.parents.iter().map(String::as_str));
            }
        }
        if !pending.is_empty() {
            return Ok(None);
        }
        Ok(Some(topo_order(found)))
    }

    /// The commits a log walk starts from: HEAD, plus every local and
    /// remote-tracking branch tip not hidden when `all_branches` is set — or,
    /// with refs soloed, HEAD and those alone. Refs that don't peel to a
    /// commit are skipped, as `Revwalk::push_glob` would.
    fn log_tips(&self, scope: &LogScope) -> Result<Vec<git2::Oid>> {
        let mut tips = Vec::new();
        if !scope.solo.is_empty() {
            for name in &scope.solo {
                if let Ok(commit) = self
                    .inner
                    .find_reference(name)
                    .and_then(|r| r.peel_to_commit())
                {
                    tips.push(commit.id());
                }
            }
        } else if scope.all_branches {
            let hidden: HashSet<&str> = scope.hidden.iter().map(String::as_str).collect();
            for glob in ["refs/heads/*", "refs/remotes/*"] {
                for reference in self.inner.references_glob(glob)? {
                    let Ok(reference) = reference else { continue };
                    if reference.name().is_some_and(|n| hidden.contains(n)) {
                        continue;
                    }
                    if let Ok(commit) = reference.peel_to_commit() {
                        tips.push(commit.id());
                    }
                }
            }
        }
        if let Ok(commit) = self.inner.head().and_then(|h| h.peel_to_commit()) {
            tips.push(commit.id());
        }
        tips.sort();
        tips.dedup();
        Ok(tips)
    }

    /// Rows for every commit reachable from `tips`, newest first (topological +
    /// time ordered), lanes not yet assigned.
    fn walk_rows(&self, tips: &[git2::Oid], max_count: Option<usize>) -> Result<Vec<CommitRow>> {
        let mut walk = self.inner.revwalk()?;
        for tip in tips {
            walk.push(*tip)?;
        }
        walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;

        let mut rows = Vec::new();
        for oid in walk {
            if let Some(max) = max_count {
                if rows.len() >= max {
                    break;
                }
            }
            rows.push(row_for(&self.inner.find_commit(oid?)?));
        }
        Ok(rows)
    }
}

fn row_for(commit: &git2::Commit) -> CommitRow {
    let author = commit.author();
    // Format the oid once: `oid.to_string()` allocates a fresh 40-char String
    // each call, and this runs for every commit in the walk.
    let id = commit.id().to_string();
    CommitRow {
        short_id: id[..7].to_string(),
        id,
        summary: commit.summary().unwrap_or("").to_string(),
        author_name: author.name().unwrap_or("").to_string(),
        author_email: author.email().unwrap_or("").to_string(),
        time: author.when().seconds(),
        parents: commit.parent_ids().map(|p| p.to_string()).collect(),
        lane: 0,
        color: 0,
    }
}

/// Order `(commit time, row)` pairs newest first, but never a parent above its
/// child — the same rule as the revwalk's `TOPOLOGICAL | TIME` sort: of the
/// commits whose children have all been placed, take the newest next.
fn topo_order(commits: Vec<(i64, CommitRow)>) -> Vec<CommitRow> {
    let index: HashMap<&str, usize> = commits
        .iter()
        .enumerate()
        .map(|(i, (_, r))| (r.id.as_str(), i))
        .collect();
    let mut children = vec![0usize; commits.len()];
    for (_, row) in &commits {
        for parent in &row.parents {
            if let Some(&j) = index.get(parent.as_str()) {
                children[j] += 1;
            }
        }
    }
    let mut ready: BinaryHeap<(i64, usize)> = (0..commits.len())
        .filter(|&i| children[i] == 0)
        .map(|i| (commits[i].0, i))
        .collect();
    let mut order = Vec::with_capacity(commits.len());
    while let Some((_, i)) = ready.pop() {
        order.push(i);
        for parent in &commits[i].1.parents {
            if let Some(&j) = index.get(parent.as_str()) {
                children[j] -= 1;
                if children[j] == 0 {
                    ready.push((commits[j].0, j));
                }
            }
        }
    }
    let mut slots: Vec<Option<CommitRow>> = commits.into_iter().map(|(_, r)| Some(r)).collect();
    order
        .into_iter()
        .map(|i| slots[i].take().unwrap())
        .collect()
}
