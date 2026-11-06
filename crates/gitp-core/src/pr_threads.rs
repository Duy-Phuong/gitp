//! The Claude conversation kept for each line-comment thread of a pull
//! request: one JSON file under the repository's own git directory,
//! `<common dir>/gitp/pr-threads/<pr number>/<root comment id>.json`, so it
//! is never in the working tree, never committed, and shared by every
//! worktree of the repository. Conversations whose last turn is older than
//! [`THREAD_KEEP`] are pruned.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::repo::Repo;

/// How long a conversation is kept after its last turn: two months.
pub const THREAD_KEEP: Duration = Duration::from_secs(60 * 24 * 60 * 60);

/// What a turn asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TurnKind {
    Check,
    Explain,
    Followup,
    ReplyDraft,
}

/// Who wrote a turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnRole {
    User,
    Claude,
}

/// One message of the conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadTurn {
    pub kind: TurnKind,
    pub role: TurnRole,
    /// Epoch milliseconds.
    pub at: u64,
    /// The head commit a Claude turn was made against; `None` on a user turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    pub text: String,
}

/// The conversation of one thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadConversation {
    pub version: u32,
    pub pr: u64,
    pub thread: u64,
    pub path: String,
    /// The Claude Code session to resume; `None` until a JSON answer gave one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    pub turns: Vec<ThreadTurn>,
}

/// Now, in epoch milliseconds.
pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Repo {
    fn threads_dir(&self) -> PathBuf {
        self.common_dir().join("gitp").join("pr-threads")
    }

    fn thread_file(&self, number: u64, thread: u64) -> PathBuf {
        self.threads_dir()
            .join(number.to_string())
            .join(format!("{thread}.json"))
    }

    /// The saved conversation of thread `thread` on pull request `number`,
    /// or `None` when there is none. A file that no longer parses is deleted
    /// and counts as none.
    pub fn thread_conversation(&self, number: u64, thread: u64) -> Result<Option<ThreadConversation>> {
        load(&self.thread_file(number, thread))
    }

    /// Write the conversation, whole and atomically.
    pub fn save_thread_conversation(&self, c: &ThreadConversation) -> Result<()> {
        let file = self.thread_file(c.pr, c.thread);
        let dir = file.parent().expect("the file is in a folder");
        std::fs::create_dir_all(dir).map_err(|e| io_err(dir, e))?;
        let tmp = file.with_extension("json.tmp");
        let text = serde_json::to_vec_pretty(c)
            .map_err(|e| Error::Message(format!("can't encode the conversation: {e}")))?;
        std::fs::write(&tmp, text).map_err(|e| io_err(&tmp, e))?;
        std::fs::rename(&tmp, &file).map_err(|e| io_err(&file, e))
    }

    /// Delete the conversation; nothing to delete is fine.
    pub fn clear_thread_conversation(&self, number: u64, thread: u64) -> Result<()> {
        let file = self.thread_file(number, thread);
        match std::fs::remove_file(&file) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_err(&file, e)),
        }
    }

    /// Delete every conversation whose last turn is older than [`THREAD_KEEP`]
    /// before `now_millis`, every damaged one, and the pull request folders
    /// left empty. Returns how many files went.
    pub fn prune_thread_conversations(&self, now_millis: u64) -> Result<usize> {
        let root = self.threads_dir();
        let folders = match std::fs::read_dir(&root) {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(io_err(&root, e)),
        };
        let cutoff = now_millis.saturating_sub(THREAD_KEEP.as_millis() as u64);
        let mut deleted = 0;
        for folder in folders.flatten() {
            let folder = folder.path();
            if !folder.is_dir() {
                continue;
            }
            for entry in std::fs::read_dir(&folder).map_err(|e| io_err(&folder, e))?.flatten() {
                let file = entry.path();
                if file.extension().is_none_or(|x| x != "json") {
                    continue;
                }
                match load(&file)? {
                    None => deleted += 1,
                    Some(c) if c.turns.last().is_none_or(|t| t.at < cutoff) => {
                        std::fs::remove_file(&file).map_err(|e| io_err(&file, e))?;
                        deleted += 1;
                    }
                    Some(_) => {}
                }
            }
            // Only an empty folder goes: the not-empty error is the normal case.
            let _ = std::fs::remove_dir(&folder);
        }
        Ok(deleted)
    }
}

fn load(file: &PathBuf) -> Result<Option<ThreadConversation>> {
    let text = match std::fs::read(file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_err(file, e)),
    };
    match serde_json::from_slice(&text) {
        Ok(c) => Ok(Some(c)),
        Err(_) => {
            std::fs::remove_file(file).map_err(|e| io_err(file, e))?;
            Ok(None)
        }
    }
}

fn io_err(path: &std::path::Path, e: std::io::Error) -> Error {
    Error::Message(format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_repo() -> (tempfile::TempDir, Repo) {
        let dir = tempfile::tempdir().unwrap();
        let git = git2::Repository::init(dir.path()).unwrap();
        let sig = git2::Signature::now("T", "t@example.com").unwrap();
        let tree = git.treebuilder(None).unwrap().write().unwrap();
        let tree = git.find_tree(tree).unwrap();
        git.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        let repo = Repo::open(dir.path()).unwrap();
        (dir, repo)
    }

    #[test]
    fn a_conversation_is_saved_under_the_git_dir_and_loaded_back() {
        let (dir, repo) = test_repo();
        assert_eq!(repo.thread_conversation(3426, 1234567890).unwrap(), None);
        let c = ThreadConversation {
            version: 1,
            pr: 3426,
            thread: 1234567890,
            path: "src/retry.ts".into(),
            session: Some("9f3c".into()),
            turns: vec![ThreadTurn {
                kind: TurnKind::Check,
                role: TurnRole::Claude,
                at: 1_000,
                head: Some("a1b2".into()),
                text: "**Bottom line:** …".into(),
            }],
        };
        repo.save_thread_conversation(&c).unwrap();
        let file = dir.path().join(".git/gitp/pr-threads/3426/1234567890.json");
        assert!(file.is_file());
        assert!(!dir.path().join("gitp").exists(), "never in the working tree");
        assert!(!file.with_extension("json.tmp").exists(), "the temp file was renamed away");
        assert_eq!(repo.thread_conversation(3426, 1234567890).unwrap(), Some(c));
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("\"kind\": \"check\""), "{text}");
        repo.clear_thread_conversation(3426, 1234567890).unwrap();
        assert!(!file.exists());
        repo.clear_thread_conversation(3426, 1234567890).unwrap();
    }

    #[test]
    fn a_damaged_file_loads_as_nothing_and_is_deleted() {
        let (dir, repo) = test_repo();
        let file = dir.path().join(".git/gitp/pr-threads/1/2.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "{not json").unwrap();
        assert_eq!(repo.thread_conversation(1, 2).unwrap(), None);
        assert!(!file.exists());
    }

    fn turn(at: u64) -> ThreadTurn {
        ThreadTurn {
            kind: TurnKind::Check,
            role: TurnRole::Claude,
            at,
            head: None,
            text: "x".into(),
        }
    }

    fn conv(pr: u64, thread: u64, at: u64) -> ThreadConversation {
        ThreadConversation {
            version: 1,
            pr,
            thread,
            path: "a".into(),
            session: None,
            turns: vec![turn(1), turn(at)],
        }
    }

    #[test]
    fn pruning_deletes_conversations_older_than_sixty_days_and_empty_folders() {
        let (dir, repo) = test_repo();
        let now: u64 = 100 * 24 * 60 * 60 * 1000;
        let keep = THREAD_KEEP.as_millis() as u64;
        repo.save_thread_conversation(&conv(1, 10, now - keep - 1)).unwrap();
        repo.save_thread_conversation(&conv(1, 11, now - keep + 1)).unwrap();
        repo.save_thread_conversation(&conv(2, 20, now - keep - 1)).unwrap();
        let damaged = dir.path().join(".git/gitp/pr-threads/3/30.json");
        std::fs::create_dir_all(damaged.parent().unwrap()).unwrap();
        std::fs::write(&damaged, "nope").unwrap();
        assert_eq!(repo.prune_thread_conversations(now).unwrap(), 3);
        assert!(repo.thread_conversation(1, 10).unwrap().is_none());
        assert!(repo.thread_conversation(1, 11).unwrap().is_some());
        assert!(!dir.path().join(".git/gitp/pr-threads/2").exists());
        assert!(!dir.path().join(".git/gitp/pr-threads/3").exists());
        assert_eq!(repo.prune_thread_conversations(now).unwrap(), 0, "a second pass finds nothing");
        let (_d2, empty) = test_repo();
        assert_eq!(empty.prune_thread_conversations(now).unwrap(), 0, "no folder yet is not an error");
    }

    #[test]
    fn a_conversation_with_no_turns_counts_as_stale() {
        let (_dir, repo) = test_repo();
        repo.save_thread_conversation(&ThreadConversation {
            version: 1,
            pr: 1,
            thread: 1,
            path: "a".into(),
            session: None,
            turns: vec![],
        })
        .unwrap();
        assert_eq!(repo.prune_thread_conversations(u64::MAX).unwrap(), 1);
    }
}
