//! Repository handle — the entry point for all read operations.

use std::path::Path;

use crate::error::Result;

/// An opened git repository. Wraps a `git2::Repository` and exposes gitp-core's
/// frontend-agnostic operations (log, commit detail, config).
pub struct Repo {
    pub(crate) inner: git2::Repository,
}

impl Repo {
    /// Open the repository at `path` (or any parent — respects the git discovery
    /// rules). Errors if `path` is not inside a git working tree.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let inner = git2::Repository::discover(path)?;
        Ok(Self { inner })
    }
}

impl Repo {
    /// The working directory, or the `.git` directory for a bare repo.
    pub fn workdir(&self) -> &Path {
        self.inner.workdir().unwrap_or_else(|| self.inner.path())
    }

    /// Resolve `rev` — a ref name, a short id, or a full id — to the full hex
    /// id of the commit it names.
    pub fn resolve_commit(&self, rev: &str) -> Result<String> {
        Ok(self
            .inner
            .revparse_single(rev)?
            .peel_to_commit()?
            .id()
            .to_string())
    }

    /// Size and mtime of `.git/index`, or `None` if it can't be read.
    ///
    /// A single `stat`. Every operation that stages, unstages, commits, checks
    /// out, merges, resets or stashes rewrites the index, so a caller holding a
    /// cached `git status` can use this to notice its own writes immediately,
    /// without waiting for a filesystem watcher's delivery latency.
    pub fn index_stamp(&self) -> Option<(u64, std::time::SystemTime)> {
        let meta = std::fs::metadata(self.inner.path().join("index")).ok()?;
        let mtime = meta.modified().ok()?;
        Some((meta.len(), mtime))
    }

    /// A cheap hash of everything that decides whether the *history view* is
    /// stale: every ref's name and target, which branch HEAD points at, and the
    /// HEAD reflog's size/mtime.
    ///
    /// Callers cache expensive derived data (the full log walk, the sidebar's
    /// `Refs`) against this instead of invalidating by hand at each mutation
    /// site — one check that can't be forgotten, rather than a dozen that can.
    /// Measured at ~4ms on a repo with 838 refs, versus ~200ms for the log walk
    /// and ~40ms for `refs()`, so the check pays for itself many times over.
    ///
    /// The reflog is included because `Refs::recent` is derived from it, and a
    /// checkout round trip (A → B → A) can leave every ref oid exactly as it
    /// started while changing the recent list.
    pub fn state_fingerprint(&self) -> Result<u64> {
        use std::hash::{Hash, Hasher};

        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        // Hashing raw oid bytes rather than formatting hex: same discrimination,
        // no allocation per ref.
        for reference in self.inner.references()? {
            let reference = reference?;
            reference.name_bytes().hash(&mut hasher);
            if let Some(oid) = reference.target() {
                oid.as_bytes().hash(&mut hasher);
            }
        }
        // HEAD is symbolic and absent from `references()`. Its *name* matters on
        // its own: checking out a different branch at the same commit leaves
        // every oid unchanged but must still repaint.
        match self.inner.head() {
            Ok(head) => {
                head.name_bytes().hash(&mut hasher);
                if let Some(oid) = head.target() {
                    oid.as_bytes().hash(&mut hasher);
                }
            }
            Err(_) => 0u8.hash(&mut hasher), // unborn branch
        }
        if let Ok(meta) = std::fs::metadata(self.inner.path().join("logs/HEAD")) {
            meta.len().hash(&mut hasher);
            if let Ok(mtime) = meta.modified() {
                mtime.hash(&mut hasher);
            }
        }
        Ok(hasher.finish())
    }
}
