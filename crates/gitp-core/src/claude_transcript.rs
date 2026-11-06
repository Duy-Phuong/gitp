//! Reading the transcript Claude Code writes while a `claude -p` run goes:
//! `~/.claude/projects/<dir>/<session>.jsonl`, one JSON object per line. gitp
//! shows it as the conversation of a Claude job — the prompt, Claude's
//! messages, the tool calls and their results — and counts its tokens.
//!
//! The file is read in pieces as it grows ([`Transcript::read_more`]); only
//! complete lines are taken, and line types this doesn't know are skipped.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The tokens of one or more API messages.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub input: u64,
    pub cache_creation: u64,
    pub cache_read: u64,
    pub output: u64,
}

impl Usage {
    pub fn total(&self) -> u64 {
        self.input + self.cache_creation + self.cache_read + self.output
    }

    pub fn add(&mut self, other: &Usage) {
        self.input += other.input;
        self.cache_creation += other.cache_creation;
        self.cache_read += other.cache_read;
        self.output += other.output;
    }

    fn from_json(usage: &Value) -> Self {
        let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
        Self {
            input: n("input_tokens"),
            cache_creation: n("cache_creation_input_tokens"),
            cache_read: n("cache_read_input_tokens"),
            output: n("output_tokens"),
        }
    }
}

/// One step of the conversation, in file order. `at` is milliseconds since
/// the Unix epoch. `tokens` is on the first step of each API message: the
/// whole message's total.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TranscriptEvent {
    /// What was sent: the prompt of a fresh run, or the text of a resumed one.
    Prompt { at: u64, text: String },
    Text {
        at: u64,
        text: String,
        tokens: Option<u64>,
    },
    /// Claude Code keeps only a signature of most thinking: `text` is often empty.
    Thinking {
        at: u64,
        text: String,
        tokens: Option<u64>,
    },
    Tool {
        at: u64,
        id: String,
        name: String,
        /// One line: the Bash command, the path read, the pattern searched.
        summary: String,
        /// The tool's input as pretty JSON.
        input: String,
        tokens: Option<u64>,
    },
    Result {
        at: u64,
        tool_id: String,
        ok: bool,
        text: String,
    },
}

impl TranscriptEvent {
    pub fn at(&self) -> u64 {
        match self {
            Self::Prompt { at, .. }
            | Self::Text { at, .. }
            | Self::Thinking { at, .. }
            | Self::Tool { at, .. }
            | Self::Result { at, .. } => *at,
        }
    }
}

/// A transcript read so far. Feed it the file again with
/// [`read_more`](Self::read_more) to take what was added since.
#[derive(Debug, Default)]
pub struct Transcript {
    offset: u64,
    /// Each API message's usage and when it started, by message id: a
    /// message spans several lines, each repeating its usage, and counts once.
    messages: HashMap<String, (u64, Usage)>,
    pub events: Vec<TranscriptEvent>,
}

impl Transcript {
    /// Read what was added to the transcript at `path` since the last call;
    /// how many events that made. A partial last line (Claude Code is still
    /// writing it) waits for the next call.
    pub fn read_more(&mut self, path: &Path) -> std::io::Result<usize> {
        let mut file = File::open(path)?;
        let len = file.metadata()?.len();
        if len < self.offset {
            // Rewritten from scratch: read it all again.
            *self = Self::default();
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let Some(end) = bytes.iter().rposition(|b| *b == b'\n') else {
            return Ok(0);
        };
        let before = self.events.len();
        for line in bytes[..end].split(|b| *b == b'\n') {
            if let Ok(value) = serde_json::from_slice::<Value>(line) {
                self.take(&value);
            }
        }
        self.offset += end as u64 + 1;
        Ok(self.events.len() - before)
    }

    /// The tokens of every message so far.
    pub fn usage(&self) -> Usage {
        self.usage_since(0)
    }

    /// The tokens of the messages that started at or after `since` (ms).
    pub fn usage_since(&self, since: u64) -> Usage {
        let mut sum = Usage::default();
        for (at, usage) in self.messages.values() {
            if *at >= since {
                sum.add(usage);
            }
        }
        sum
    }

    fn take(&mut self, line: &Value) {
        if line.get("isSidechain").and_then(Value::as_bool) == Some(true)
            || line.get("isMeta").and_then(Value::as_bool) == Some(true)
        {
            return;
        }
        let at = line
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_timestamp)
            .unwrap_or(0);
        let Some(message) = line.get("message") else {
            return;
        };
        match line.get("type").and_then(Value::as_str) {
            Some("user") => self.take_user(at, message),
            Some("assistant") => self.take_assistant(at, message),
            _ => {}
        }
    }

    fn take_user(&mut self, at: u64, message: &Value) {
        match message.get("content") {
            Some(Value::String(text)) if !text.trim().is_empty() => {
                self.events.push(TranscriptEvent::Prompt {
                    at,
                    text: text.clone(),
                });
            }
            Some(Value::Array(blocks)) => {
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    self.events.push(TranscriptEvent::Result {
                        at,
                        tool_id: str_of(block, "tool_use_id"),
                        ok: block.get("is_error").and_then(Value::as_bool) != Some(true),
                        text: result_text(block.get("content")),
                    });
                }
            }
            _ => {}
        }
    }

    fn take_assistant(&mut self, at: u64, message: &Value) {
        let id = str_of(message, "id");
        let usage = message
            .get("usage")
            .map(Usage::from_json)
            .unwrap_or_default();
        // The first line of a message carries its total on its first step;
        // a later line of the same message only updates the count.
        let mut tokens = match self.messages.get_mut(&id) {
            Some(known) => {
                known.1 = usage;
                None
            }
            None => {
                if !id.is_empty() {
                    self.messages.insert(id.clone(), (at, usage));
                }
                Some(usage.total())
            }
        };
        let Some(Value::Array(blocks)) = message.get("content") else {
            return;
        };
        for block in blocks {
            let event = match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = str_of(block, "text");
                    if text.trim().is_empty() {
                        continue;
                    }
                    TranscriptEvent::Text {
                        at,
                        text,
                        tokens: tokens.take(),
                    }
                }
                Some("thinking") => TranscriptEvent::Thinking {
                    at,
                    text: str_of(block, "thinking"),
                    tokens: tokens.take(),
                },
                Some("tool_use") => {
                    let name = str_of(block, "name");
                    let input = block.get("input").cloned().unwrap_or(Value::Null);
                    TranscriptEvent::Tool {
                        at,
                        id: str_of(block, "id"),
                        summary: tool_summary(&name, &input),
                        input: serde_json::to_string_pretty(&input).unwrap_or_default(),
                        name,
                        tokens: tokens.take(),
                    }
                }
                _ => continue,
            };
            self.events.push(event);
        }
    }
}

/// Where Claude Code keeps the transcript of session `session`, if it has
/// one: `<config>/projects/<any dir>/<session>.jsonl`, where `<config>` is
/// `$CLAUDE_CONFIG_DIR` or `~/.claude`. The directory is named after the run's
/// working directory; any of them will do, since a session id is unique.
pub fn transcript_path(session: &str) -> Option<PathBuf> {
    let config = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude")))?;
    transcript_path_in(&config.join("projects"), session)
}

/// [`transcript_path`] under the projects directory `projects`.
pub fn transcript_path_in(projects: &Path, session: &str) -> Option<PathBuf> {
    if session.is_empty()
        || !session
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    let name = format!("{session}.jsonl");
    std::fs::read_dir(projects)
        .ok()?
        .flatten()
        .map(|dir| dir.path().join(&name))
        .find(|path| path.is_file())
}

/// The transcripts of the subagents a session dispatched: Claude Code writes
/// each to `<session>/subagents/agent-*.jsonl` beside the main file, which
/// holds only the Agent call and its result.
pub fn subagent_transcripts(main: &Path) -> Vec<PathBuf> {
    let dir = main.with_extension("").join("subagents");
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
                .collect()
        })
        .unwrap_or_default();
    found.sort();
    found
}

/// The start of the local day that `now_ms` (ms since the Unix epoch) falls
/// in, in ms since the Unix epoch.
pub fn local_day_start(now_ms: u64) -> u64 {
    #[cfg(unix)]
    {
        let secs = (now_ms / 1000) as libc::time_t;
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        // SAFETY: localtime_r writes only into `tm`, which outlives the call.
        if !unsafe { libc::localtime_r(&secs, &mut tm) }.is_null() {
            let into_day = (tm.tm_hour as u64 * 3600 + tm.tm_min as u64 * 60 + tm.tm_sec as u64)
                * 1000
                + now_ms % 1000;
            return now_ms.saturating_sub(into_day);
        }
    }
    now_ms - now_ms % 86_400_000
}

/// A fresh random session id (a version-4 UUID) for `claude --session-id`.
pub fn new_session_id() -> String {
    let mut b = [0u8; 16];
    let read = File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b));
    if read.is_err() {
        // No /dev/urandom: the clock and the process id are unique enough.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mixed = nanos ^ ((std::process::id() as u128) << 64);
        b = mixed.to_le_bytes();
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn str_of(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// A tool result's content: a string, or text blocks (an image is noted).
fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|b| match b.get("type").and_then(Value::as_str) {
                Some("text") => str_of(b, "text"),
                Some(other) => format!("[{other}]"),
                None => String::new(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// One line that says what a tool call does.
fn tool_summary(name: &str, input: &Value) -> String {
    let key = match name {
        "Bash" => "command",
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => "file_path",
        "Grep" | "Glob" => "pattern",
        "Skill" => "skill",
        "Task" | "Agent" => "description",
        "WebFetch" => "url",
        "WebSearch" => "query",
        _ => "",
    };
    let text = input
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            input
                .as_object()
                .and_then(|o| o.values().find_map(|v| v.as_str().map(str::to_string)))
        })
        .unwrap_or_default();
    let line = text.lines().next().unwrap_or_default().trim();
    if line.chars().count() > 200 {
        format!("{}…", line.chars().take(200).collect::<String>())
    } else {
        line.to_string()
    }
}

/// `2026-11-06T10:43:33.698Z` (UTC, as Claude Code writes it) in ms since
/// the Unix epoch.
fn parse_timestamp(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let mut ms = 0;
    if b.get(19) == Some(&b'.') {
        let frac: String = s[20..].chars().take_while(|c| c.is_ascii_digit()).collect();
        let padded = format!("{:0<3}", &frac[..frac.len().min(3)]);
        ms = padded.parse::<i64>().ok()?;
    }
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let total = ((days * 24 + h) * 60 + mi) * 60 + sec;
    u64::try_from(total * 1000 + ms).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn line(v: Value) -> String {
        format!("{v}\n")
    }

    fn assistant(id: &str, at: &str, output: u64, content: Value) -> String {
        line(serde_json::json!({
            "type": "assistant", "timestamp": at,
            "message": {"id": id, "content": content, "usage": {
                "input_tokens": 2, "cache_creation_input_tokens": 100,
                "cache_read_input_tokens": 1000, "output_tokens": output}}
        }))
    }

    fn sample() -> String {
        let mut s = String::new();
        s += &line(serde_json::json!({"type": "queue-operation", "operation": "enqueue"}));
        s += &line(
            serde_json::json!({"type": "user", "timestamp": "2026-11-06T10:43:30.000Z",
            "message": {"role": "user", "content": "Check the thread."}}),
        );
        s += &assistant(
            "m1",
            "2026-11-06T10:43:33.698Z",
            50,
            serde_json::json!([{"type": "thinking", "thinking": ""}]),
        );
        s += &assistant(
            "m1",
            "2026-11-06T10:43:35.000Z",
            50,
            serde_json::json!([
            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "git show HEAD\n--stat", "description": "x"}}]),
        );
        s += &line(
            serde_json::json!({"type": "user", "timestamp": "2026-11-06T10:43:36.000Z",
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "commit abc"}]}}),
        );
        s += &assistant(
            "m2",
            "2026-11-06T10:44:20.816Z",
            7,
            serde_json::json!([{"type": "text", "text": "## Answer"}]),
        );
        s += &line(
            serde_json::json!({"type": "user", "isSidechain": true, "timestamp": "2026-11-06T10:44:21.000Z",
            "message": {"content": "a subagent's prompt"}}),
        );
        s
    }

    #[test]
    fn reads_the_steps_in_order_and_counts_each_message_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(&path, sample()).unwrap();
        let mut t = Transcript::default();
        assert_eq!(t.read_more(&path).unwrap(), 5);
        let kinds: Vec<_> = t
            .events
            .iter()
            .map(|e| {
                serde_json::to_value(e).unwrap()["kind"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(kinds, ["prompt", "thinking", "tool", "result", "text"]);
        // m1 spans two lines and counts once: 2 + 100 + 1000 + 50; m2 the same with 7.
        assert_eq!(t.usage().total(), 1152 + 1109);
        assert_eq!(t.usage().output, 57);
        match &t.events[1] {
            TranscriptEvent::Thinking { tokens, .. } => assert_eq!(*tokens, Some(1152)),
            other => panic!("{other:?}"),
        }
        match &t.events[2] {
            TranscriptEvent::Tool {
                summary,
                tokens,
                name,
                ..
            } => {
                assert_eq!(name, "Bash");
                assert_eq!(summary, "git show HEAD");
                assert_eq!(*tokens, None, "the message's tokens are on its first step");
            }
            other => panic!("{other:?}"),
        }
        match &t.events[3] {
            TranscriptEvent::Result {
                tool_id, ok, text, ..
            } => {
                assert_eq!(
                    (tool_id.as_str(), *ok, text.as_str()),
                    ("t1", true, "commit abc")
                );
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(t.events[4].at(), 1_793_961_860_816);
        assert_eq!(t.usage_since(1_793_961_860_000).total(), 1109);
    }

    #[test]
    fn a_partial_last_line_waits_until_it_is_complete() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let all = sample();
        let cut = all.find("## Answer").unwrap();
        std::fs::write(&path, &all[..cut]).unwrap();
        let mut t = Transcript::default();
        assert_eq!(t.read_more(&path).unwrap(), 4);
        assert_eq!(t.read_more(&path).unwrap(), 0, "nothing new yet");
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        f.write_all(all[cut..].as_bytes()).unwrap();
        assert_eq!(t.read_more(&path).unwrap(), 1);
        assert!(matches!(&t.events[4], TranscriptEvent::Text { text, .. } if text == "## Answer"));
    }

    #[test]
    fn finds_the_file_in_any_project_directory_and_refuses_odd_ids() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("-Users-me-src-app");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(project.join("abc-123.jsonl"), "").unwrap();
        assert_eq!(
            transcript_path_in(dir.path(), "abc-123"),
            Some(project.join("abc-123.jsonl"))
        );
        assert_eq!(transcript_path_in(dir.path(), "nope"), None);
        assert_eq!(transcript_path_in(dir.path(), "../abc-123"), None);
        assert_eq!(transcript_path_in(dir.path(), ""), None);
        assert!(subagent_transcripts(&project.join("abc-123.jsonl")).is_empty());
        let agents = project.join("abc-123").join("subagents");
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::write(agents.join("agent-b.jsonl"), "").unwrap();
        std::fs::write(agents.join("agent-a.jsonl"), "").unwrap();
        std::fs::write(agents.join("notes.txt"), "").unwrap();
        assert_eq!(
            subagent_transcripts(&project.join("abc-123.jsonl")),
            [agents.join("agent-a.jsonl"), agents.join("agent-b.jsonl")]
        );
    }

    #[test]
    fn new_session_ids_are_v4_uuids() {
        let a = new_session_id();
        assert_eq!(a.len(), 36);
        assert_eq!(&a[14..15], "4");
        assert_ne!(a, new_session_id());
    }

    #[test]
    fn the_local_day_starts_at_most_a_day_before() {
        let now = 1_793_961_813_698;
        let start = local_day_start(now);
        assert!(start <= now && now - start < 86_400_000);
        assert_eq!(local_day_start(start), start);
    }

    #[test]
    fn parses_timestamps() {
        assert_eq!(parse_timestamp("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_timestamp("2026-11-06T10:43:33.698Z"),
            Some(1_793_961_813_698)
        );
        assert_eq!(
            parse_timestamp("2026-11-06T10:43:33Z"),
            Some(1_793_961_813_000)
        );
        assert_eq!(parse_timestamp("garbage"), None);
    }
}
