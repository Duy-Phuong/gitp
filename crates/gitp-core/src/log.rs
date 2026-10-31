//! History walk. Produces flat `CommitRow`s newest-first.
//!
//! The walk is `git log --date-order`, read as git lists it: with a
//! commit-graph, git lists the newest commits without reading the rest of the
//! history first, so the first page of a large log can be shown long before
//! the whole of it is read (see `LogWalk`). Graph-lane data (for rendering
//! branch lanes) is layered on in `graph.rs`.

use std::collections::{BinaryHeap, HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdout, Stdio};

use serde::{Deserialize, Serialize};

use crate::activity;
use crate::error::{Error, Result};
use crate::git_bin::git_command;
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

/// A log walk in progress: `git log` running, and the rows read from it so
/// far. Lanes depend only on the rows above, so the first rows can be laid out
/// and shown while the rest is still being read (`first_rows`).
pub struct LogWalk {
    /// `None` once git has listed everything (or there was nothing to walk).
    git: Option<GitLog>,
    rows: Vec<CommitRow>,
    scope: LogScope,
    tips: Vec<git2::Oid>,
    pinned_tip: Option<String>,
}

impl LogWalk {
    /// The first `n` rows (fewer if the log is shorter), laid out as they will
    /// be in the full log — or `None` when that can't be known yet: the pinned
    /// branch decides the layout from the top row down, and whether it is in
    /// the walk at all is only known once its tip has been read.
    pub fn first_rows(&mut self, n: usize) -> Result<Option<Vec<CommitRow>>> {
        self.read_until(n)?;
        let mut rows = self.rows[..n.min(self.rows.len())].to_vec();
        if let Some(tip) = self.pinned_tip.as_deref() {
            let read = |rows: &[CommitRow]| rows.iter().any(|r| r.id == tip);
            let known_absent = self.git.is_none() && !read(&self.rows);
            if !read(&rows) && !known_absent {
                return Ok(None);
            }
        }
        crate::graph::assign_lanes(&mut rows, self.pinned_tip.as_deref());
        Ok(Some(rows))
    }

    /// Whether git has listed the whole log.
    pub fn is_complete(&self) -> bool {
        self.git.is_none()
    }

    /// Read the rest of the log and lay it out.
    pub fn finish(mut self) -> Result<LogCache> {
        self.read_until(usize::MAX)?;
        let mut rows = std::mem::take(&mut self.rows);
        crate::graph::assign_lanes(&mut rows, self.pinned_tip.as_deref());
        Ok(LogCache {
            rows,
            scope: std::mem::take(&mut self.scope),
            tips: std::mem::take(&mut self.tips),
            pinned_tip: self.pinned_tip.take(),
            bodies: HashMap::new(),
        })
    }

    fn read_until(&mut self, n: usize) -> Result<()> {
        while self.rows.len() < n {
            let Some(git) = self.git.as_mut() else { break };
            match git.next_row()? {
                Some(row) => self.rows.push(row),
                None => self.git.take().unwrap().wait()?,
            }
        }
        Ok(())
    }
}

/// The fields of a log row, one record per commit (NUL-terminated by `-z`).
/// The summary goes last: it is the only field that can hold anything.
const LOG_FORMAT: &str = "--format=%H%x1f%P%x1f%at%x1f%an%x1f%ae%x1f%s";

/// A running `git log`. Stopped if dropped before it has listed everything.
struct GitLog {
    child: Child,
    stdout: BufReader<ChildStdout>,
    run: Option<activity::Run>,
}

impl GitLog {
    fn next_row(&mut self) -> Result<Option<CommitRow>> {
        let mut record = Vec::new();
        loop {
            record.clear();
            let read = self
                .stdout
                .read_until(0, &mut record)
                .map_err(|e| Error::Message(format!("failed to read git log: {e}")))?;
            if read == 0 {
                return Ok(None);
            }
            if record.last() == Some(&0) {
                record.pop();
            }
            if !record.is_empty() {
                return parse_row(&record).map(Some);
            }
        }
    }

    /// Wait for git to exit, once it has listed everything.
    fn wait(mut self) -> Result<()> {
        let mut stderr = Vec::new();
        if let Some(mut pipe) = self.child.stderr.take() {
            let _ = pipe.read_to_end(&mut stderr);
        }
        let status = self
            .child
            .wait()
            .map_err(|e| Error::Message(format!("failed to run git: {e}")))?;
        if let Some(run) = self.run.take() {
            run.finish(status.code(), status.success(), b"", &stderr);
        }
        if status.success() {
            Ok(())
        } else {
            Err(Error::Message(
                String::from_utf8_lossy(&stderr).trim().to_string(),
            ))
        }
    }
}

impl Drop for GitLog {
    fn drop(&mut self) {
        if let Some(run) = self.run.take() {
            let _ = self.child.kill();
            let _ = self.child.wait();
            run.fail("stopped after the rows needed");
        }
    }
}

fn parse_row(record: &[u8]) -> Result<CommitRow> {
    let text = String::from_utf8_lossy(record);
    let mut fields = text.splitn(6, '\x1f');
    let mut next = || fields.next().unwrap_or("");
    let (id, parents, time, name, email, summary) =
        (next(), next(), next(), next(), next(), next());
    if id.len() < 7 {
        return Err(Error::Message(format!("unexpected git log output: {text}")));
    }
    Ok(CommitRow {
        id: id.to_string(),
        short_id: id[..7].to_string(),
        summary: summary.to_string(),
        author_name: name.to_string(),
        author_email: email.to_string(),
        time: time.parse().unwrap_or(0),
        parents: parents.split_whitespace().map(str::to_string).collect(),
        lane: 0,
        color: 0,
    })
}

impl Repo {
    /// Walk history newest-first (topological + time ordered), starting from
    /// HEAD. With `options.all_branches`, also seed from every local and
    /// remote-tracking branch tip, so the graph shows commits on branches not
    /// reachable from HEAD — e.g. a remote branch ahead of the current one.
    /// Missing categories (say, no remotes) are skipped; an empty repo yields
    /// an empty log.
    pub fn log(&self, options: LogOptions) -> Result<Vec<CommitRow>> {
        let mut walk = self.start_log_walk(&options.all_branches.into())?;
        let rows = walk.first_rows(options.max_count.unwrap_or(usize::MAX))?;
        Ok(rows.unwrap_or_default())
    }

    /// Start walking the log for `scope`: `git log --date-order` from its tips,
    /// read as git lists it. Nothing is read until asked for.
    pub fn start_log_walk(&self, scope: &LogScope) -> Result<LogWalk> {
        let tips = self.log_tips(scope)?;
        let git = if tips.is_empty() {
            None
        } else {
            Some(self.spawn_log(&tips)?)
        };
        Ok(LogWalk {
            git,
            rows: Vec::new(),
            scope: scope.clone(),
            tips,
            pinned_tip: self.pinned_tip(scope),
        })
    }

    /// `git log` from `tips`: newest first, never a parent above its child —
    /// the rule `topo_order` follows for the commits a refresh adds — and the
    /// commits as libgit2 reads them there (no replace refs, no mailmap). The
    /// tips go in on stdin: a big repo has hundreds.
    fn spawn_log(&self, tips: &[git2::Oid]) -> Result<GitLog> {
        let mut cmd = git_command();
        cmd.current_dir(self.workdir())
            .env("GIT_TERMINAL_PROMPT", "0")
            .args([
                "--no-replace-objects",
                "log",
                "--date-order",
                "--no-show-signature",
                "--no-use-mailmap",
                "-z",
                LOG_FORMAT,
                "--stdin",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let run = activity::Run::of(&cmd);
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => {
                run.fail(format_args!("failed to run git: {e}"));
                return Err(Error::Message(format!("failed to run git: {e}")));
            }
        };
        let mut stdin = child.stdin.take().expect("stdin is piped");
        let stdout = BufReader::new(child.stdout.take().expect("stdout is piped"));
        let git = GitLog {
            child,
            stdout,
            run: Some(run),
        };
        let written = tips.iter().try_for_each(|tip| writeln!(stdin, "{tip}"));
        drop(stdin);
        if let Err(e) = written {
            // git stopped reading them: it has exited, and says why.
            git.wait()?;
            return Err(Error::Message(format!("failed to start git log: {e}")));
        }
        Ok(git)
    }

    /// The full log (as `log` with no `max_count`), kept with the tips it was
    /// walked from so `refresh_log` can extend it cheaply later.
    pub fn log_cache(&self, all_branches: bool) -> Result<LogCache> {
        self.log_cache_scoped(&all_branches.into())
    }

    /// `log_cache` for a full `LogScope`.
    pub fn log_cache_scoped(&self, scope: &LogScope) -> Result<LogCache> {
        self.start_log_walk(scope)?.finish()
    }

    /// Whether git has no commit-graph to read here, and would read one. Without
    /// it `git log --date-order` reads every commit before listing the first —
    /// about a second per 100k commits.
    pub fn commit_graph_missing(&self) -> bool {
        let enabled = self
            .inner
            .config()
            .and_then(|c| c.get_bool("core.commitGraph"))
            .unwrap_or(true);
        let info = self.common_dir().join("objects").join("info");
        enabled
            && !info.join("commit-graph").is_file()
            && !info
                .join("commit-graphs")
                .join("commit-graph-chain")
                .is_file()
    }

    /// Write a commit-graph of every reachable commit, as `git gc` would.
    pub fn write_commit_graph(&self) -> Result<()> {
        self.run_git(&["commit-graph", "write", "--reachable"])
            .map(|_| ())
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
