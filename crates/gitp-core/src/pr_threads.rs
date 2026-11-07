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
    Fix,
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
    /// A fix turn: the commit it made, and the worktree it made it in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    /// A reply draft: where it was posted, once it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub posted: Option<String>,
    /// A reply draft the user decided not to post.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dropped: bool,
}

impl ThreadTurn {
    /// A turn Claude wrote, against commit `head`.
    pub fn claude(kind: TurnKind, head: String, text: String) -> Self {
        Self {
            kind,
            role: TurnRole::Claude,
            at: now_millis(),
            head: Some(head),
            text,
            commit: None,
            worktree: None,
            posted: None,
            dropped: false,
        }
    }

    /// A turn the user wrote.
    pub fn user(kind: TurnKind, text: String) -> Self {
        Self {
            kind,
            role: TurnRole::User,
            at: now_millis(),
            head: None,
            text,
            commit: None,
            worktree: None,
            posted: None,
            dropped: false,
        }
    }
}

/// The conversation of one thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadConversation {
    pub version: u32,
    pub pr: u64,
    pub thread: u64,
    pub path: String,
    /// The pull request's title, the thread's line and its comments as the
    /// last turn was given them, for the search; files written before they
    /// were kept lack them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub comments: Vec<ThreadComment>,
    /// The Claude Code session to resume; `None` until a JSON answer gave one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// The session of the fixes, made in the pull request branch's worktree:
    /// Claude Code keeps sessions per directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix_session: Option<String>,
    pub turns: Vec<ThreadTurn>,
}

/// One comment of the thread, as kept in its conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadComment {
    pub author: String,
    pub body: String,
}

/// How many hits a search returns at most.
pub const THREAD_SEARCH_LIMIT: usize = 200;

/// Where the thread's latest reply draft is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReplyState {
    Ready,
    Posted,
}

/// One conversation a search found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThreadHit {
    pub pr: u64,
    pub thread: u64,
    pub path: String,
    pub line: Option<u32>,
    pub title: Option<String>,
    /// Up to 80 characters either side of the first word's first match, on
    /// one line; the start of the thread for an empty query.
    pub snippet: String,
    /// The snippet is from a reply draft that was dropped.
    pub dropped: bool,
    /// The last turn, epoch milliseconds.
    pub at: u64,
    pub fixed: bool,
    pub reply_state: Option<ReplyState>,
}

/// The first [`THREAD_SEARCH_LIMIT`] hits, newest first, and how many there were.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThreadSearch {
    pub hits: Vec<ThreadHit>,
    pub total: usize,
}

/// The reply the thread has ready to post: its latest reply draft, unless
/// that one was posted or dropped.
pub fn prepared_reply(c: &ThreadConversation) -> Option<&ThreadTurn> {
    let last = c
        .turns
        .iter()
        .rev()
        .find(|t| t.kind == TurnKind::ReplyDraft && t.role == TurnRole::Claude)?;
    (last.posted.is_none() && !last.dropped).then_some(last)
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
    pub fn thread_conversation(
        &self,
        number: u64,
        thread: u64,
    ) -> Result<Option<ThreadConversation>> {
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

    /// The latest reply draft was posted at `url`.
    pub fn mark_reply_posted(&self, number: u64, thread: u64, url: &str) -> Result<()> {
        self.change_prepared_reply(number, thread, |t| t.posted = Some(url.to_string()))
    }

    /// The latest reply draft is not to be posted.
    pub fn drop_reply(&self, number: u64, thread: u64) -> Result<()> {
        self.change_prepared_reply(number, thread, |t| t.dropped = true)
    }

    fn change_prepared_reply(
        &self,
        number: u64,
        thread: u64,
        change: impl FnOnce(&mut ThreadTurn),
    ) -> Result<()> {
        let mut c = self.thread_conversation(number, thread)?.ok_or_else(|| {
            Error::Message(format!(
                "#{number} has no Claude conversation on that thread"
            ))
        })?;
        // Only the latest draft counts: an older one was superseded.
        let at = c
            .turns
            .iter()
            .rposition(|t| t.kind == TurnKind::ReplyDraft && t.role == TurnRole::Claude)
            .filter(|&i| c.turns[i].posted.is_none() && !c.turns[i].dropped)
            .ok_or_else(|| Error::Message("The thread has no reply ready.".into()))?;
        change(&mut c.turns[at]);
        self.save_thread_conversation(&c)
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

    /// The conversations every word of `query` (split on whitespace) is
    /// found in, case-insensitively — in a comment, a turn (dropped drafts
    /// too), the title, the path or the pull request number — with the last
    /// turn in `range` (`[from, to)`, epoch milliseconds) and on pull request
    /// `pr` when given. Damaged files are deleted on the way, as on a load.
    pub fn search_thread_conversations(
        &self,
        query: &str,
        range: Option<(u64, u64)>,
        pr: Option<u64>,
    ) -> Result<ThreadSearch> {
        let root = self.threads_dir();
        let folders = match std::fs::read_dir(&root) {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ThreadSearch {
                    hits: Vec::new(),
                    total: 0,
                })
            }
            Err(e) => return Err(io_err(&root, e)),
        };
        let words: Vec<Vec<char>> = query.split_whitespace().map(fold).collect();
        let mut hits = Vec::new();
        for folder in folders.flatten() {
            let folder = folder.path();
            let number = folder
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.parse::<u64>().ok());
            if !folder.is_dir() || number.is_none() || pr.is_some_and(|p| Some(p) != number) {
                continue;
            }
            for entry in std::fs::read_dir(&folder)
                .map_err(|e| io_err(&folder, e))?
                .flatten()
            {
                let file = entry.path();
                if file.extension().is_none_or(|x| x != "json") {
                    continue;
                }
                let Some(c) = load(&file)? else { continue };
                let Some(at) = c.turns.last().map(|t| t.at) else {
                    continue;
                };
                if range.is_some_and(|(from, to)| at < from || at >= to) {
                    continue;
                }
                if let Some((snippet, dropped)) = find_snippet(&c, &words) {
                    hits.push(hit(&c, at, snippet, dropped));
                }
            }
        }
        hits.sort_by_key(|h| std::cmp::Reverse((h.at, h.pr, h.thread)));
        let total = hits.len();
        hits.truncate(THREAD_SEARCH_LIMIT);
        Ok(ThreadSearch { hits, total })
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
            for entry in std::fs::read_dir(&folder)
                .map_err(|e| io_err(&folder, e))?
                .flatten()
            {
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

/// How many characters a snippet keeps either side of the match.
const SNIPPET_SIDE: usize = 80;

/// Lowercase, one character for one, so positions match the original's.
fn fold(s: &str) -> Vec<char> {
    s.chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect()
}

fn position(hay: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// The snippet and whether it came from a dropped draft, when every word is
/// in some field of `c`; the start of the thread when there are no words.
fn find_snippet(c: &ThreadConversation, words: &[Vec<char>]) -> Option<(String, bool)> {
    let number = c.pr.to_string();
    let mut fields: Vec<(&str, bool)> = c
        .comments
        .iter()
        .map(|x| (x.body.as_str(), false))
        .collect();
    fields.extend(c.turns.iter().map(|t| (t.text.as_str(), t.dropped)));
    fields.extend(c.title.as_deref().map(|t| (t, false)));
    fields.push((c.path.as_str(), false));
    fields.push((number.as_str(), false));
    let Some(first) = words.first() else {
        let (text, dropped) = c
            .comments
            .first()
            .map(|x| (x.body.as_str(), false))
            .or_else(|| c.turns.last().map(|t| (t.text.as_str(), t.dropped)))?;
        let chars: Vec<char> = text.chars().collect();
        return Some((cut(&chars, 0, 2 * SNIPPET_SIDE), dropped));
    };
    let folded: Vec<Vec<char>> = fields.iter().map(|(text, _)| fold(text)).collect();
    if !words
        .iter()
        .all(|w| folded.iter().any(|f| position(f, w).is_some()))
    {
        return None;
    }
    let (i, at) = folded
        .iter()
        .enumerate()
        .find_map(|(i, f)| position(f, first).map(|p| (i, p)))?;
    let chars: Vec<char> = fields[i].0.chars().collect();
    let start = at.saturating_sub(SNIPPET_SIDE);
    Some((
        cut(&chars, start, at + first.len() + SNIPPET_SIDE),
        fields[i].1,
    ))
}

/// `chars[start..end]` on one line, with `…` where it was cut.
fn cut(chars: &[char], start: usize, end: usize) -> String {
    let end = end.min(chars.len());
    let text: String = chars[start..end].iter().collect();
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    format!(
        "{}{text}{}",
        if start > 0 { "…" } else { "" },
        if end < chars.len() { "…" } else { "" }
    )
}

fn hit(c: &ThreadConversation, at: u64, snippet: String, dropped: bool) -> ThreadHit {
    let last_draft = c
        .turns
        .iter()
        .rev()
        .find(|t| t.kind == TurnKind::ReplyDraft && t.role == TurnRole::Claude);
    ThreadHit {
        pr: c.pr,
        thread: c.thread,
        path: c.path.clone(),
        line: c.line,
        title: c.title.clone(),
        snippet,
        dropped,
        at,
        fixed: c
            .turns
            .iter()
            .any(|t| t.kind == TurnKind::Fix && t.commit.is_some()),
        reply_state: if prepared_reply(c).is_some() {
            Some(ReplyState::Ready)
        } else if last_draft.is_some_and(|t| t.posted.is_some()) {
            Some(ReplyState::Posted)
        } else {
            None
        },
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
        git.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
            .unwrap();
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
            title: None,
            line: None,
            comments: vec![],
            session: Some("9f3c".into()),
            fix_session: None,
            turns: vec![ThreadTurn {
                at: 1_000,
                ..ThreadTurn::claude(TurnKind::Check, "a1b2".into(), "**Bottom line:** …".into())
            }],
        };
        repo.save_thread_conversation(&c).unwrap();
        let file = dir.path().join(".git/gitp/pr-threads/3426/1234567890.json");
        assert!(file.is_file());
        assert!(
            !dir.path().join("gitp").exists(),
            "never in the working tree"
        );
        assert!(
            !file.with_extension("json.tmp").exists(),
            "the temp file was renamed away"
        );
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
            at,
            head: None,
            ..ThreadTurn::claude(TurnKind::Check, String::new(), "x".into())
        }
    }

    fn conv(pr: u64, thread: u64, at: u64) -> ThreadConversation {
        ThreadConversation {
            version: 1,
            pr,
            thread,
            path: "a".into(),
            title: None,
            line: None,
            comments: vec![],
            session: None,
            fix_session: None,
            turns: vec![turn(1), turn(at)],
        }
    }

    #[test]
    fn pruning_deletes_conversations_older_than_sixty_days_and_empty_folders() {
        let (dir, repo) = test_repo();
        let now: u64 = 100 * 24 * 60 * 60 * 1000;
        let keep = THREAD_KEEP.as_millis() as u64;
        repo.save_thread_conversation(&conv(1, 10, now - keep - 1))
            .unwrap();
        repo.save_thread_conversation(&conv(1, 11, now - keep + 1))
            .unwrap();
        repo.save_thread_conversation(&conv(2, 20, now - keep - 1))
            .unwrap();
        let damaged = dir.path().join(".git/gitp/pr-threads/3/30.json");
        std::fs::create_dir_all(damaged.parent().unwrap()).unwrap();
        std::fs::write(&damaged, "nope").unwrap();
        assert_eq!(repo.prune_thread_conversations(now).unwrap(), 3);
        assert!(repo.thread_conversation(1, 10).unwrap().is_none());
        assert!(repo.thread_conversation(1, 11).unwrap().is_some());
        assert!(!dir.path().join(".git/gitp/pr-threads/2").exists());
        assert!(!dir.path().join(".git/gitp/pr-threads/3").exists());
        assert_eq!(
            repo.prune_thread_conversations(now).unwrap(),
            0,
            "a second pass finds nothing"
        );
        let (_d2, empty) = test_repo();
        assert_eq!(
            empty.prune_thread_conversations(now).unwrap(),
            0,
            "no folder yet is not an error"
        );
    }

    #[test]
    fn a_prepared_reply_is_the_latest_draft_until_posted_or_dropped() {
        let (_dir, repo) = test_repo();
        let draft = |text: &str| ThreadTurn::claude(TurnKind::ReplyDraft, "h".into(), text.into());
        let mut c = ThreadConversation {
            version: 1,
            pr: 1,
            thread: 2,
            path: "a".into(),
            title: None,
            line: None,
            comments: vec![],
            session: None,
            fix_session: None,
            turns: vec![
                draft("A"),
                ThreadTurn::user(TurnKind::Followup, "q".into()),
                draft("B"),
            ],
        };
        assert_eq!(prepared_reply(&c).map(|t| t.text.as_str()), Some("B"));
        repo.save_thread_conversation(&c).unwrap();
        repo.mark_reply_posted(1, 2, "https://x").unwrap();
        c = repo.thread_conversation(1, 2).unwrap().unwrap();
        assert_eq!(prepared_reply(&c), None);
        assert_eq!(c.turns[2].posted.as_deref(), Some("https://x"));
        assert_eq!(c.turns[0].posted, None, "only the latest draft");
        c.turns.push(draft("C"));
        repo.save_thread_conversation(&c).unwrap();
        assert_eq!(prepared_reply(&c).map(|t| t.text.as_str()), Some("C"));
        repo.drop_reply(1, 2).unwrap();
        c = repo.thread_conversation(1, 2).unwrap().unwrap();
        assert_eq!(prepared_reply(&c), None);
        assert!(c.turns[3].dropped);
        assert!(repo.drop_reply(1, 2).is_err(), "nothing left to drop");
        assert!(
            repo.mark_reply_posted(9, 9, "u").is_err(),
            "no conversation"
        );
    }

    #[test]
    fn a_turn_without_the_new_fields_still_loads() {
        let (dir, repo) = test_repo();
        let file = dir.path().join(".git/gitp/pr-threads/5/6.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            r#"{"version":1,"pr":5,"thread":6,"path":"a","session":"s","turns":[{"kind":"check","role":"claude","at":1,"head":"h","text":"x"}]}"#,
        )
        .unwrap();
        let c = repo.thread_conversation(5, 6).unwrap().unwrap();
        assert_eq!(
            (
                c.fix_session.clone(),
                c.turns[0].commit.clone(),
                c.turns[0].dropped
            ),
            (None, None, false)
        );
        let text = serde_json::to_string(&c).unwrap();
        assert!(
            !text.contains("dropped") && !text.contains("fix_session"),
            "{text}"
        );
    }

    #[test]
    fn a_conversation_with_no_turns_counts_as_stale() {
        let (_dir, repo) = test_repo();
        repo.save_thread_conversation(&ThreadConversation {
            version: 1,
            pr: 1,
            thread: 1,
            path: "a".into(),
            title: None,
            line: None,
            comments: vec![],
            session: None,
            fix_session: None,
            turns: vec![],
        })
        .unwrap();
        assert_eq!(repo.prune_thread_conversations(u64::MAX).unwrap(), 1);
    }

    fn stored(pr: u64, thread: u64, at: u64, comment: &str, answer: &str) -> ThreadConversation {
        ThreadConversation {
            version: 1,
            pr,
            thread,
            path: "src/retry.ts".into(),
            title: Some(format!("PR {pr}")),
            line: Some(12),
            comments: vec![ThreadComment {
                author: "anna".into(),
                body: comment.into(),
            }],
            session: None,
            fix_session: None,
            turns: vec![ThreadTurn {
                at,
                ..ThreadTurn::claude(TurnKind::Check, "h".into(), answer.into())
            }],
        }
    }

    fn found(s: &ThreadSearch) -> Vec<(u64, u64)> {
        s.hits.iter().map(|h| (h.pr, h.thread)).collect()
    }

    #[test]
    fn every_token_must_match_somewhere_case_insensitively() {
        let (_dir, repo) = test_repo();
        repo.save_thread_conversation(&stored(
            1,
            10,
            100,
            "Retry STOPS early",
            "the loop ends one try sooner",
        ))
        .unwrap();
        repo.save_thread_conversation(&stored(2, 20, 200, "naming nit", "rename it"))
            .unwrap();
        let s = repo
            .search_thread_conversations("retry LOOP", None, None)
            .unwrap();
        assert_eq!((found(&s), s.total), (vec![(1, 10)], 1));
        let s = repo
            .search_thread_conversations("loop nit", None, None)
            .unwrap();
        assert_eq!((found(&s), s.total), (vec![], 0));
    }

    #[test]
    fn the_pr_number_path_and_title_match_as_words() {
        let (_dir, repo) = test_repo();
        let mut c = stored(3426, 10, 100, "a", "b");
        c.path = "crates/core/src/merge.rs".into();
        c.title = Some("Faster merges".into());
        repo.save_thread_conversation(&c).unwrap();
        repo.save_thread_conversation(&stored(7, 20, 200, "a", "b"))
            .unwrap();
        for q in ["3426", "merge.rs", "faster"] {
            assert_eq!(
                found(&repo.search_thread_conversations(q, None, None).unwrap()),
                vec![(3426, 10)],
                "{q}"
            );
        }
    }

    #[test]
    fn range_and_pr_filters() {
        let (_dir, repo) = test_repo();
        repo.save_thread_conversation(&stored(1, 10, 100, "x", "y"))
            .unwrap();
        repo.save_thread_conversation(&stored(1, 11, 200, "x", "y"))
            .unwrap();
        repo.save_thread_conversation(&stored(2, 20, 300, "x", "y"))
            .unwrap();
        let s = repo
            .search_thread_conversations("x", Some((150, 300)), None)
            .unwrap();
        assert_eq!(found(&s), vec![(1, 11)], "[from, to): 300 is out");
        let s = repo
            .search_thread_conversations("x", None, Some(1))
            .unwrap();
        assert_eq!(found(&s), vec![(1, 11), (1, 10)]);
    }

    #[test]
    fn an_empty_query_with_a_pr_lists_only_that_pr() {
        let (_dir, repo) = test_repo();
        repo.save_thread_conversation(&stored(1, 10, 100, "first comment", "y"))
            .unwrap();
        repo.save_thread_conversation(&stored(2, 20, 300, "root comment", "y"))
            .unwrap();
        repo.save_thread_conversation(&stored(2, 21, 200, "other", "y"))
            .unwrap();
        let s = repo
            .search_thread_conversations("  ", None, Some(2))
            .unwrap();
        assert_eq!(found(&s), vec![(2, 20), (2, 21)]);
        assert_eq!(
            s.hits[0].snippet, "root comment",
            "the start of the root comment"
        );
        assert_eq!(
            found(&repo.search_thread_conversations("", None, None).unwrap()),
            vec![(2, 20), (2, 21), (1, 10)]
        );
    }

    #[test]
    fn hits_are_newest_first_and_capped_with_the_total() {
        let (_dir, repo) = test_repo();
        for i in 0..205 {
            repo.save_thread_conversation(&stored(1 + i % 3, i, 1_000 + i, "x", "y"))
                .unwrap();
        }
        let s = repo.search_thread_conversations("", None, None).unwrap();
        assert_eq!((s.hits.len(), s.total), (THREAD_SEARCH_LIMIT, 205));
        assert_eq!((s.hits[0].at, s.hits[199].at), (1_204, 1_005));
    }

    #[test]
    fn the_snippet_is_80_chars_either_side_of_the_first_match() {
        let (_dir, repo) = test_repo();
        let long = format!("{}NEEDLE{}", "a".repeat(100), "b".repeat(100));
        repo.save_thread_conversation(&stored(1, 10, 100, &long, "short answer needle"))
            .unwrap();
        let s = repo
            .search_thread_conversations("needle", None, None)
            .unwrap();
        assert_eq!(
            s.hits[0].snippet,
            format!("…{}NEEDLE{}…", "a".repeat(80), "b".repeat(80))
        );
        repo.save_thread_conversation(&stored(
            1,
            10,
            100,
            "nothing here",
            "line one\n\nline   two sooner",
        ))
        .unwrap();
        let s = repo
            .search_thread_conversations("SOONER", None, None)
            .unwrap();
        assert_eq!(
            s.hits[0].snippet, "line one line two sooner",
            "the first field it matches, one line"
        );
    }

    #[test]
    fn a_snippet_cuts_on_characters_not_bytes() {
        let (_dir, repo) = test_repo();
        let text = format!("{}Ünïcode{}", "é".repeat(100), "ø".repeat(100));
        repo.save_thread_conversation(&stored(1, 10, 100, &text, "y"))
            .unwrap();
        let s = repo
            .search_thread_conversations("ünïCODE", None, None)
            .unwrap();
        assert_eq!(
            s.hits[0].snippet,
            format!("…{}Ünïcode{}…", "é".repeat(80), "ø".repeat(80))
        );
    }

    #[test]
    fn a_match_in_a_dropped_draft_is_marked() {
        let (_dir, repo) = test_repo();
        let mut c = stored(1, 10, 100, "naming", "nothing to change");
        c.turns.push(ThreadTurn {
            dropped: true,
            ..ThreadTurn::claude(
                TurnKind::ReplyDraft,
                "h".into(),
                "We will rename foo.".into(),
            )
        });
        repo.save_thread_conversation(&c).unwrap();
        assert!(
            repo.search_thread_conversations("rename", None, None)
                .unwrap()
                .hits[0]
                .dropped
        );
        assert!(
            !repo
                .search_thread_conversations("nothing", None, None)
                .unwrap()
                .hits[0]
                .dropped
        );
    }

    #[test]
    fn hits_carry_the_place_and_the_badges() {
        let (_dir, repo) = test_repo();
        let draft = |posted: Option<&str>| ThreadTurn {
            at: 50,
            posted: posted.map(String::from),
            ..ThreadTurn::claude(TurnKind::ReplyDraft, "h".into(), "reply".into())
        };
        let mut fixed = stored(1, 10, 100, "x", "y");
        fixed.turns.insert(
            0,
            ThreadTurn {
                at: 10,
                commit: Some("c0ffee".into()),
                ..ThreadTurn::claude(TurnKind::Fix, "h".into(), "fixed".into())
            },
        );
        let mut ready = stored(2, 20, 200, "x", "y");
        ready.turns.insert(0, draft(None));
        let mut posted = stored(3, 30, 300, "x", "y");
        posted.turns.insert(0, draft(Some("https://x")));
        for c in [&fixed, &ready, &posted] {
            repo.save_thread_conversation(c).unwrap();
        }
        let s = repo.search_thread_conversations("", None, None).unwrap();
        let badges: Vec<_> = s
            .hits
            .iter()
            .map(|h| (h.pr, h.fixed, h.reply_state))
            .collect();
        assert_eq!(
            badges,
            vec![
                (3, false, Some(ReplyState::Posted)),
                (2, false, Some(ReplyState::Ready)),
                (1, true, None)
            ]
        );
        let h = &s.hits[2];
        assert_eq!(
            (h.thread, h.path.as_str(), h.line, h.title.as_deref(), h.at),
            (10, "src/retry.ts", Some(12), Some("PR 1"), 100)
        );
    }

    #[test]
    fn an_old_file_without_title_line_comments_loads_and_matches_on_turns() {
        let (dir, repo) = test_repo();
        let file = dir.path().join(".git/gitp/pr-threads/5/6.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            r#"{"version":1,"pr":5,"thread":6,"path":"a","turns":[{"kind":"check","role":"claude","at":1,"head":"h","text":"an old answer"}]}"#,
        )
        .unwrap();
        let c = repo.thread_conversation(5, 6).unwrap().unwrap();
        assert_eq!((c.title.clone(), c.line, c.comments.len()), (None, None, 0));
        let text = serde_json::to_string(&c).unwrap();
        assert!(
            !text.contains("title") && !text.contains("comments") && !text.contains("\"line\""),
            "{text}"
        );
        let s = repo.search_thread_conversations("OLD", None, None).unwrap();
        assert_eq!(
            (found(&s), s.hits[0].title.clone(), s.hits[0].line),
            (vec![(5, 6)], None, None)
        );
        assert_eq!(s.hits[0].snippet, "an old answer");
    }

    #[test]
    fn no_folder_is_no_hits() {
        let (_dir, repo) = test_repo();
        let s = repo.search_thread_conversations("x", None, None).unwrap();
        assert_eq!((s.hits.len(), s.total), (0, 0));
    }
}
