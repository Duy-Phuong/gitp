//! Local history: snapshots of the working tree, taken as files change, so
//! an edit that was never committed — then overwritten, deleted or lost to a
//! crash — can still be found and put back, the way IntelliJ's Local History
//! and VS Code's Timeline work.
//!
//! A snapshot is a commit in the repository's own object database, kept
//! under a private ref `refs/gitp/history/<millis>` that no branch list, log
//! walk or push refspec includes. Its tree is the working tree at that moment
//! — tracked changes and new files alike, minus ignored ones and files past a
//! size cap — written through a scratch index, so the real index and the
//! working tree are never touched. Its parent is HEAD at the time, which makes
//! `git diff-tree` against the parent the list of what was uncommitted then.
//!
//! Two snapshots with the same tree are one: nothing is stored when nothing
//! changed. Old snapshots go after [`HISTORY_KEEP_DAYS`] days, and the count is
//! capped at [`HISTORY_MAX`], so the store stays small and gc reclaims the rest.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::error::{Error, Result};
use crate::repo::Repo;

/// Where the snapshots live.
pub const HISTORY_REFS: &str = "refs/gitp/history/";
/// Snapshots older than this are dropped when a new one is taken.
pub const HISTORY_KEEP_DAYS: u64 = 14;
/// The most snapshots kept per repository.
pub const HISTORY_MAX: usize = 400;
/// A new (untracked) file bigger than this is left out of a snapshot: a
/// build artifact or a dataset would bloat the object database for nothing.
pub const HISTORY_MAX_NEW_FILE: u64 = 5 * 1024 * 1024;

/// One snapshot and what was uncommitted in it.
#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    /// The snapshot commit's id.
    pub id: String,
    /// When it was taken, milliseconds since the epoch.
    pub time: i64,
    /// The commit HEAD was at, so the list can say "on main at abc123".
    pub head: String,
    /// The files that differed from HEAD, as `git diff-tree --name-status`
    /// has them: `A`, `M`, `D`, and a rename as `R` with both names.
    pub files: Vec<SnapshotFile>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotFile {
    pub status: String,
    pub path: String,
    /// The old name of a renamed file.
    pub from: Option<String>,
}

/// One version of a file across the snapshots.
#[derive(Debug, Clone, Serialize)]
pub struct FileVersion {
    pub snapshot: String,
    pub time: i64,
    /// The blob id, so equal consecutive versions can be folded.
    pub blob: String,
    pub size: u64,
}

impl Repo {
    /// Take a snapshot of the working tree, unless it equals the last one.
    /// Returns the new snapshot's id. Refused while the index has unmerged
    /// entries (a conflict in progress): the files hold markers, not work.
    pub fn snapshot_working_tree(&self) -> Result<Option<String>> {
        let tree = match self.working_tree_as_tree()? {
            Some(tree) => tree,
            None => return Ok(None),
        };
        let head = self.head_commit_id().ok();
        if let Some(last) = self.latest_snapshot()? {
            let last_tree = self.run_git(&["rev-parse", &format!("{last}^{{tree}}")])?;
            if last_tree == tree {
                return Ok(None);
            }
        }
        // Nothing uncommitted at all: the tree is HEAD's. Worth no snapshot
        // either — there is nothing in it that a branch doesn't keep.
        if let Some(head) = &head {
            let head_tree = self.run_git(&["rev-parse", &format!("{head}^{{tree}}")])?;
            if head_tree == tree {
                return Ok(None);
            }
        }
        let identity = [
            ("GIT_AUTHOR_NAME", "gitp"),
            ("GIT_AUTHOR_EMAIL", "gitp@localhost"),
            ("GIT_COMMITTER_NAME", "gitp"),
            ("GIT_COMMITTER_EMAIL", "gitp@localhost"),
        ];
        let mut args = vec!["commit-tree", tree.as_str()];
        if let Some(head) = &head {
            args.extend(["-p", head.as_str()]);
        }
        args.extend(["-m", "gitp: local history"]);
        let commit = self.run_git_env(&args, &identity)?;
        let millis = now_millis();
        self.run_git(&["update-ref", &format!("{HISTORY_REFS}{millis}"), &commit])?;
        self.prune_history(millis);
        Ok(Some(commit))
    }

    /// The working tree as a tree object: the tracked files as they are on
    /// disk, plus the new files that aren't ignored and aren't too big.
    /// `None` while the index has unmerged entries.
    fn working_tree_as_tree(&self) -> Result<Option<String>> {
        let scratch = self.inner.path().join("gitp-undo-index-history.tmp");
        let real = self.inner.path().join("index");
        let _ = fs::remove_file(&scratch);
        if real.exists() {
            fs::copy(&real, &scratch)
                .map_err(|e| Error::Message(format!("can't copy the index: {e}")))?;
        }
        let scratch_str = scratch.to_string_lossy().into_owned();
        let env = [("GIT_INDEX_FILE", scratch_str.as_str())];
        let result = (|| {
            if !real.exists() {
                if self.head_commit_id().is_ok() {
                    self.run_git_env(&["read-tree", "HEAD"], &env)?;
                }
            } else if self.run_git_env(&["write-tree"], &env).is_err() {
                // Unmerged entries: a conflict is being resolved.
                return Ok(None);
            }
            self.run_git_env(&["add", "-u"], &env)?;
            let new_files = self.small_untracked_files()?;
            if !new_files.is_empty() {
                // The list goes through a file: NUL-separated, so any name works.
                let list_path = self.inner.path().join("gitp-undo-index-history.paths");
                let list: Vec<u8> = new_files
                    .iter()
                    .flat_map(|p| p.as_bytes().iter().copied().chain([0u8]))
                    .collect();
                fs::write(&list_path, list)
                    .map_err(|e| Error::Message(format!("can't write the file list: {e}")))?;
                let from = format!("--pathspec-from-file={}", list_path.display());
                let added = self.run_git_env(&["add", "--pathspec-file-nul", &from], &env);
                let _ = fs::remove_file(&list_path);
                added?;
            }
            Ok(Some(self.run_git_env(&["write-tree"], &env)?))
        })();
        let _ = fs::remove_file(&scratch);
        result
    }

    /// Untracked, non-ignored files no bigger than [`HISTORY_MAX_NEW_FILE`].
    fn small_untracked_files(&self) -> Result<Vec<String>> {
        let workdir = self.workdir_path()?;
        let out = self.run_git_raw(&["ls-files", "--others", "--exclude-standard", "-z"])?;
        Ok(out
            .split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .filter(|p| {
                fs::metadata(workdir.join(p))
                    .map(|m| m.is_file() && m.len() <= HISTORY_MAX_NEW_FILE)
                    .unwrap_or(false)
            })
            .collect())
    }

    /// The newest snapshot's commit id, if any.
    fn latest_snapshot(&self) -> Result<Option<String>> {
        let out = self.run_git(&[
            "for-each-ref",
            "--sort=-refname",
            "--count=1",
            "--format=%(objectname)",
            HISTORY_REFS,
        ])?;
        let id = out.trim();
        Ok((!id.is_empty()).then(|| id.to_string()))
    }

    /// Every snapshot, newest first, with the files that were uncommitted in
    /// it. One `git log` over the refs: `--no-walk` lists the snapshots
    /// themselves, not their ancestry, and `--name-status` diffs each against
    /// its parent — HEAD at the time.
    pub fn local_history(&self) -> Result<Vec<Snapshot>> {
        let refs = self.history_refs()?;
        if refs.is_empty() {
            return Ok(Vec::new());
        }
        let mut args = vec![
            "log",
            "--no-walk=unsorted",
            "--format=%x01%H%x00%P",
            "--name-status",
            "-z",
            "-M",
            "--no-renames",
        ];
        // Renames are read as a delete plus an add: a snapshot compares a
        // working tree with a commit, where "renamed" rarely means much.
        args.retain(|a| *a != "-M");
        let ref_names: Vec<&str> = refs.iter().map(|(name, _)| name.as_str()).collect();
        args.extend(ref_names.iter().copied());
        let out = self.run_git_raw(&args)?;
        let by_id: std::collections::HashMap<&str, i64> = refs
            .iter()
            .map(|(name, id)| (id.as_str(), millis_of(name)))
            .collect();
        let mut snapshots = parse_log(&out, &by_id);
        snapshots.sort_by_key(|s| std::cmp::Reverse(s.time));
        Ok(snapshots)
    }

    /// The versions of `path` the snapshots hold where it differed from HEAD
    /// at the time, newest first, equal consecutive versions folded into one.
    pub fn file_versions(&self, path: &str) -> Result<Vec<FileVersion>> {
        let refs = self.history_refs()?;
        if refs.is_empty() {
            return Ok(Vec::new());
        }
        let mut args = vec![
            "log",
            "--no-walk=unsorted",
            "--format=%x01%H",
            "--raw",
            "-z",
            "--no-renames",
        ];
        let ref_names: Vec<&str> = refs.iter().map(|(name, _)| name.as_str()).collect();
        args.extend(ref_names.iter().copied());
        args.extend(["--", path]);
        let out = self.run_git_raw(&args)?;
        let by_id: std::collections::HashMap<&str, i64> = refs
            .iter()
            .map(|(name, id)| (id.as_str(), millis_of(name)))
            .collect();
        let mut versions = parse_raw_versions(&out, path, &by_id);
        versions.sort_by_key(|v| std::cmp::Reverse(v.time));
        // Fold runs of the same content: the file changed once, then the
        // snapshots kept catching other files.
        versions.dedup_by(|a, b| a.blob == b.blob);
        for v in &mut versions {
            v.size = self
                .run_git(&["cat-file", "-s", &v.blob])
                .ok()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0);
        }
        Ok(versions)
    }

    /// The bytes of `path` in snapshot `snapshot`.
    pub fn snapshot_file(&self, snapshot: &str, path: &str) -> Result<Vec<u8>> {
        let object = self
            .inner
            .revparse_single(&format!("{}:{path}", snapshot_rev(snapshot)?))?;
        let blob = object
            .as_blob()
            .ok_or_else(|| Error::Message(format!("{path} is not a file in that snapshot")))?;
        Ok(blob.content().to_vec())
    }

    /// Write the version of `path` from snapshot `snapshot` to the working
    /// tree, making its folders if they are gone. The index is not touched.
    pub fn restore_from_snapshot(&self, snapshot: &str, path: &str) -> Result<()> {
        let bytes = self.snapshot_file(snapshot, path)?;
        let full = self.workdir_path()?.join(inside_workdir(path)?);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| Error::Message(format!("can't create the folder of {path}: {e}")))?;
        }
        fs::write(&full, bytes).map_err(|e| Error::Message(format!("can't write {path}: {e}")))
    }

    /// Drop every snapshot.
    pub fn clear_local_history(&self) -> Result<()> {
        let refs = self.history_refs()?;
        if refs.is_empty() {
            return Ok(());
        }
        let script: String = refs
            .iter()
            .map(|(name, _)| format!("delete {name}\n"))
            .collect();
        self.run_git_stdin(&["update-ref", "--stdin"], &script)
            .map(|_| ())
    }

    /// `(ref name, commit id)` of each snapshot.
    fn history_refs(&self) -> Result<Vec<(String, String)>> {
        let out = self.run_git(&[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)",
            HISTORY_REFS,
        ])?;
        Ok(out
            .lines()
            .filter_map(|l| l.split_once('\0'))
            .map(|(n, id)| (n.to_string(), id.to_string()))
            .collect())
    }

    /// Delete the snapshots older than [`HISTORY_KEEP_DAYS`], and the oldest
    /// beyond [`HISTORY_MAX`]. Best effort.
    fn prune_history(&self, now: u128) {
        let Ok(refs) = self.history_refs() else {
            return;
        };
        let mut names: Vec<&str> = refs.iter().map(|(n, _)| n.as_str()).collect();
        names.sort_unstable();
        let cutoff = now.saturating_sub(HISTORY_KEEP_DAYS as u128 * 24 * 3600 * 1000) as i64;
        let over = names.len().saturating_sub(HISTORY_MAX);
        let stale: Vec<&str> = names
            .iter()
            .enumerate()
            .filter(|(i, n)| *i < over || millis_of(n) < cutoff)
            .map(|(_, n)| *n)
            .collect();
        if stale.is_empty() {
            return;
        }
        let script: String = stale.iter().map(|n| format!("delete {n}\n")).collect();
        let _ = self.run_git_stdin(&["update-ref", "--stdin"], &script);
    }
}

/// The snapshot id as a revision, refused when it isn't a hex id: it goes
/// into a revspec.
fn snapshot_rev(snapshot: &str) -> Result<&str> {
    if snapshot.len() >= 7 && snapshot.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(snapshot)
    } else {
        Err(Error::Message(format!("{snapshot} is not a snapshot id")))
    }
}

/// A plain relative path: a restore writes under the working tree only.
fn inside_workdir(path: &str) -> Result<PathBuf> {
    use std::path::Component;
    let rel = Path::new(path);
    let plain = !rel.as_os_str().is_empty()
        && rel
            .components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if plain {
        Ok(rel.to_path_buf())
    } else {
        Err(Error::Message(format!(
            "not a path inside the repository: {path}"
        )))
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// The time in a snapshot ref's name.
fn millis_of(refname: &str) -> i64 {
    refname
        .rsplit('/')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// `git log --no-walk --format=%x01%H%x00%P --name-status -z`: each record
/// starts with \x01, then the id, NUL, the parents, a newline, then the
/// NUL-separated status/path pairs.
fn parse_log(out: &[u8], times: &std::collections::HashMap<&str, i64>) -> Vec<Snapshot> {
    let mut snapshots = Vec::new();
    for record in out.split(|b| *b == 1).filter(|r| !r.is_empty()) {
        let (meta, entries) = split_record(record);
        let mut meta = meta.split('\0');
        let id = meta.next().unwrap_or("").trim().to_string();
        if id.is_empty() {
            continue;
        }
        let head = meta
            .next()
            .unwrap_or("")
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string();
        let rest: Vec<&str> = entries
            .split('\0')
            .map(str::trim)
            .filter(|f| !f.is_empty())
            .collect();
        let mut files = Vec::new();
        let mut i = 0;
        while i < rest.len() {
            let status = rest[i];
            if status.starts_with('R') || status.starts_with('C') {
                if i + 2 < rest.len() {
                    files.push(SnapshotFile {
                        status: status[..1].to_string(),
                        path: rest[i + 2].to_string(),
                        from: Some(rest[i + 1].to_string()),
                    });
                }
                i += 3;
            } else {
                if i + 1 < rest.len() {
                    files.push(SnapshotFile {
                        status: status.to_string(),
                        path: rest[i + 1].to_string(),
                        from: None,
                    });
                }
                i += 2;
            }
        }
        snapshots.push(Snapshot {
            time: times.get(id.as_str()).copied().unwrap_or(0),
            id,
            head,
            files,
        });
    }
    snapshots
}

/// `git log --no-walk --format=%x01%H --raw -z -- path`: the id, a newline,
/// then raw lines `:<old mode> <new mode> <old blob> <new blob> <status>`,
/// each followed by the NUL-terminated path.
fn parse_raw_versions(
    out: &[u8],
    path: &str,
    times: &std::collections::HashMap<&str, i64>,
) -> Vec<FileVersion> {
    let mut versions = Vec::new();
    for record in out.split(|b| *b == 1).filter(|r| !r.is_empty()) {
        let (meta, entries) = split_record(record);
        let id = meta.trim().to_string();
        if id.is_empty() {
            continue;
        }
        let fields: Vec<&str> = entries.split('\0').collect();
        let mut i = 0;
        while i + 1 < fields.len() {
            let line = fields[i].trim();
            let file = fields[i + 1];
            if line.starts_with(':') && file == path {
                let parts: Vec<&str> = line.split_whitespace().collect();
                // A deletion has an all-zero new blob: no version to offer.
                if let Some(blob) = parts.get(3).filter(|b| !b.chars().all(|c| c == '0')) {
                    versions.push(FileVersion {
                        snapshot: id.clone(),
                        time: times.get(id.as_str()).copied().unwrap_or(0),
                        blob: (*blob).to_string(),
                        size: 0,
                    });
                }
            }
            i += 2;
        }
    }
    versions
}

/// A record as `(the format line, the entries after its newline)`.
fn split_record(record: &[u8]) -> (String, String) {
    let text = String::from_utf8_lossy(record);
    // With `-z`, git ends the format line with a NUL before the newline.
    let nul = |s: &str| {
        s.trim_matches(|c: char| c == '\0' || c.is_whitespace())
            .to_string()
    };
    match text.split_once('\n') {
        Some((meta, entries)) => (nul(meta), entries.to_string()),
        None => (nul(&text), String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_name_status_records() {
        let mut times = std::collections::HashMap::new();
        times.insert("aaaa", 5i64);
        let out = b"\x01aaaa\0bbbb\nM\0src/a.rs\0A\0new.txt\0D\0gone.txt\0";
        let snaps = parse_log(out, &times);
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0].head, "bbbb");
        assert_eq!(snaps[0].time, 5);
        let files: Vec<(String, String)> = snaps[0]
            .files
            .iter()
            .map(|f| (f.status.clone(), f.path.clone()))
            .collect();
        assert_eq!(
            files,
            vec![
                ("M".into(), "src/a.rs".into()),
                ("A".into(), "new.txt".into()),
                ("D".into(), "gone.txt".into())
            ]
        );
    }

    #[test]
    fn parses_raw_blob_ids_and_skips_deletions() {
        let mut times = std::collections::HashMap::new();
        times.insert("aaaa", 1i64);
        times.insert("cccc", 2i64);
        let out = b"\x01aaaa\n:100644 100644 1111111 2222222 M\0f.txt\0\x01cccc\n:100644 000000 2222222 0000000 D\0f.txt\0";
        let versions = parse_raw_versions(out, "f.txt", &times);
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].blob, "2222222");
        assert_eq!(versions[0].time, 1);
    }

    #[test]
    fn only_plain_relative_paths_are_restored() {
        assert!(inside_workdir("src/a.rs").is_ok());
        assert!(inside_workdir("../x").is_err());
        assert!(inside_workdir("/etc/passwd").is_err());
        assert!(snapshot_rev("--exec=true").is_err());
        assert!(snapshot_rev("0123abcd").is_ok());
    }
}
