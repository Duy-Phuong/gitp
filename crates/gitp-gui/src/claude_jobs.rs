//! The Claude jobs: every Claude Code run gitp starts — a review, Explain
//! more on a finding, a turn or a fix on a pull request thread — in one list,
//! with its conversation read live from Claude Code's transcript, a Stop,
//! and today's finished jobs kept across a restart.
//!
//! A job is registered before its run starts ([`ClaudeJobs::begin`]), hears
//! which Claude session the run writes through the core's `on_claude_run`
//! hook, and ends with [`Running::finish`]. One review per pull request and
//! one turn per thread run at a time, as before; a thread is one job across
//! its turns of the day.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gitp_core::{
    local_day_start, subagent_transcripts, transcript_path, NetworkHooks, Transcript,
    TranscriptEvent, Usage,
};
use serde::{Deserialize, Serialize};

/// The event the frontend gets when a quit waits on running jobs.
pub(crate) const QUIT_EVENT: &str = "claude-jobs-quit";

/// How much of a tool's input or output an event carries; the rest comes on
/// request ([`ClaudeJobs::full`]).
const EVENT_TEXT_LIMIT: usize = 4 * 1024;

/// How much of a finished job's output the saved list keeps.
const OUTPUT_LIMIT: usize = 64 * 1024;

/// How long Stop and quit waits for the stopped runs to return.
const QUIT_WAIT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum JobKind {
    Review,
    Explain,
    Thread,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum JobState {
    Running,
    Done,
    Failed,
    Stopped,
    /// Saved as running by a gitp that quit or crashed while it ran.
    Interrupted,
}

/// A Claude Code session a job ran, and where.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct JobSession {
    pub id: String,
    pub dir: String,
}

/// One job as the list keeps it, saved and sent to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Job {
    pub id: u64,
    pub kind: JobKind,
    /// What it is: "Review with Skill · #3426", "OrderService.java:88 · #3426".
    pub label: String,
    /// What it does now, for a thread: "Check", "Follow-up", "Fix".
    pub activity: String,
    pub repo: String,
    pub pr: u64,
    pub thread: Option<u64>,
    /// The finding of an Explain more.
    pub finding: Option<String>,
    pub state: JobState,
    /// Ms since the Unix epoch.
    pub started: u64,
    pub ended: Option<u64>,
    /// When the current (or last) turn started.
    pub turn_started: u64,
    /// The time of the turns before the current one, in ms.
    pub spent: u64,
    pub turns: u32,
    pub error: Option<String>,
    /// The shell line of the last run, and how big its stdin was.
    pub command: String,
    pub stdin_bytes: usize,
    /// What the last run printed, capped at [`OUTPUT_LIMIT`].
    pub output: Option<String>,
    pub sessions: Vec<JobSession>,
    /// Today's tokens: of all turns, and of the current turn.
    pub tokens: Usage,
    pub turn_tokens: Usage,
}

/// What a new job is, for [`ClaudeJobs::begin`].
pub(crate) struct NewJob {
    pub kind: JobKind,
    pub label: String,
    pub activity: String,
    pub repo: String,
    pub pr: u64,
    pub thread: Option<u64>,
    pub finding: Option<String>,
    pub command: String,
    pub stdin_bytes: usize,
}

/// A page of a job's conversation: the steps from `after` on, and the index
/// to ask from next time.
#[derive(Debug, Serialize)]
pub(crate) struct EventsPage {
    pub events: Vec<EventOut>,
    pub next: usize,
    /// Whether any of the job's transcripts exists: none means the command
    /// doesn't pass the session id, or Claude Code removed the session.
    pub found: bool,
}

/// One step, with its long text cut: `cut` is the full length when it was.
#[derive(Debug, Serialize)]
pub(crate) struct EventOut {
    #[serde(flatten)]
    pub event: TranscriptEvent,
    pub cut: Option<usize>,
}

/// A tool call's whole input and output, for "show all".
#[derive(Debug, Serialize, PartialEq, Eq)]
pub(crate) struct ToolFull {
    pub input: String,
    pub output: String,
}

/// One session's transcript as read so far: the main file and its subagents'.
#[derive(Default)]
struct SessionRead {
    path: Option<PathBuf>,
    main: Transcript,
    subagents: HashMap<PathBuf, Transcript>,
}

impl SessionRead {
    fn refresh(&mut self, id: &str, find: &dyn Fn(&str) -> Option<PathBuf>) {
        if self.path.is_none() {
            self.path = find(id);
        }
        let Some(path) = self.path.clone() else {
            return;
        };
        if self.main.read_more(&path).is_err() {
            return;
        }
        for sub in subagent_transcripts(&path) {
            let _ = self
                .subagents
                .entry(sub.clone())
                .or_default()
                .read_more(&sub);
        }
    }

    fn usage_since(&self, since: u64) -> Usage {
        let mut sum = self.main.usage_since(since);
        for t in self.subagents.values() {
            sum.add(&t.usage_since(since));
        }
        sum
    }
}

#[derive(Default)]
struct Inner {
    jobs: Vec<Job>,
    cancels: HashMap<u64, Arc<AtomicBool>>,
    reads: HashMap<String, SessionRead>,
    next_id: u64,
    store: Option<PathBuf>,
    quitting: bool,
}

/// The jobs; cheap to clone, every clone is the same list.
#[derive(Clone)]
pub(crate) struct ClaudeJobs {
    inner: Arc<Mutex<Inner>>,
    find: Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl Default for ClaudeJobs {
    fn default() -> Self {
        Self {
            inner: Arc::default(),
            find: Arc::new(transcript_path),
            now: Arc::new(now_ms),
        }
    }
}

/// A job's run while it goes: its cancel flag and hooks, and how it ends.
pub(crate) struct Running {
    jobs: ClaudeJobs,
    pub id: u64,
    pub cancel: Arc<AtomicBool>,
}

impl Running {
    /// The hooks for the run's repo handle: the cancel flag, and the session
    /// each Claude run writes.
    pub fn hooks(&self) -> NetworkHooks {
        let jobs = self.jobs.clone();
        let id = self.id;
        NetworkHooks {
            cancel: Some(Arc::clone(&self.cancel)),
            on_claude_run: Some(Box::new(move |run| {
                jobs.add_session(id, &run.session, &run.dir.to_string_lossy());
            })),
            ..NetworkHooks::default()
        }
    }

    /// End the run: done with what it printed, failed with the error, or
    /// stopped when its cancel went up. `sessions` are any the answer named.
    pub fn finish(self, out: Result<String, String>, sessions: &[(String, String)]) {
        for (session, dir) in sessions {
            self.jobs.add_session(self.id, session, dir);
        }
        let stopped = self.cancel.load(Ordering::SeqCst);
        let now = (self.jobs.now)();
        let mut inner = self.jobs.inner.lock().unwrap();
        inner.cancels.remove(&self.id);
        let find = Arc::clone(&self.jobs.find);
        refresh_job(&mut inner, self.id, &*find);
        if let Some(job) = inner.jobs.iter_mut().find(|j| j.id == self.id) {
            job.ended = Some(now);
            job.spent += now.saturating_sub(job.turn_started);
            match out {
                Ok(text) => {
                    job.state = JobState::Done;
                    job.error = None;
                    job.output = Some(cap(&text, OUTPUT_LIMIT).0);
                }
                Err(_) if stopped => {
                    job.state = JobState::Stopped;
                    job.error = None;
                }
                Err(e) => {
                    job.state = JobState::Failed;
                    job.error = Some(e);
                }
            }
        }
        save(&inner);
    }
}

impl ClaudeJobs {
    /// Keep the list in `file`, and load today's jobs from it: those saved as
    /// running are interrupted.
    pub fn load(&self, file: PathBuf) {
        let today = local_day_start((self.now)());
        let saved: Vec<Job> = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let mut inner = self.inner.lock().unwrap();
        for mut job in saved.into_iter().filter(|j| j.started >= today) {
            if job.state == JobState::Running {
                job.state = JobState::Interrupted;
            }
            inner.next_id = inner.next_id.max(job.id + 1);
            inner.jobs.push(job);
        }
        inner.store = Some(file);
    }

    /// Register a run about to start, or refuse it while the same review or
    /// a turn on the same thread runs. A thread's run joins its job of today.
    pub fn begin(&self, new: NewJob) -> Result<Running, String> {
        let now = (self.now)();
        let today = local_day_start(now);
        let mut inner = self.inner.lock().unwrap();
        let same = |j: &Job| {
            j.kind == new.kind
                && j.repo == new.repo
                && j.pr == new.pr
                && j.thread == new.thread
                && j.finding == new.finding
        };
        if inner
            .jobs
            .iter()
            .any(|j| j.state == JobState::Running && same(j))
        {
            return Err(match new.kind {
                JobKind::Review => format!("A review of #{} is already running.", new.pr),
                JobKind::Thread => "A turn on this thread is already running.".into(),
                JobKind::Explain => format!(
                    "Finding {} of #{} is already being explained.",
                    new.finding.as_deref().unwrap_or_default(),
                    new.pr
                ),
            });
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let reuse = new.kind == JobKind::Thread;
        let id = match inner
            .jobs
            .iter_mut()
            .find(|j| reuse && same(j) && j.started >= today)
        {
            Some(job) => {
                job.state = JobState::Running;
                job.activity = new.activity;
                job.label = new.label;
                job.turn_started = now;
                job.turns += 1;
                job.ended = None;
                job.error = None;
                job.command = new.command;
                job.stdin_bytes = new.stdin_bytes;
                job.turn_tokens = Usage::default();
                job.id
            }
            None => {
                let id = inner.next_id;
                inner.next_id += 1;
                inner.jobs.push(Job {
                    id,
                    kind: new.kind,
                    label: new.label,
                    activity: new.activity,
                    repo: new.repo,
                    pr: new.pr,
                    thread: new.thread,
                    finding: new.finding,
                    state: JobState::Running,
                    started: now,
                    ended: None,
                    turn_started: now,
                    spent: 0,
                    turns: 1,
                    error: None,
                    command: new.command,
                    stdin_bytes: new.stdin_bytes,
                    output: None,
                    sessions: Vec::new(),
                    tokens: Usage::default(),
                    turn_tokens: Usage::default(),
                });
                id
            }
        };
        inner.cancels.insert(id, Arc::clone(&cancel));
        save(&inner);
        Ok(Running {
            jobs: self.clone(),
            id,
            cancel,
        })
    }

    fn add_session(&self, id: u64, session: &str, dir: &str) {
        if session.is_empty() {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        if let Some(job) = inner.jobs.iter_mut().find(|j| j.id == id) {
            if !job.sessions.iter().any(|s| s.id == session) {
                job.sessions.push(JobSession {
                    id: session.to_string(),
                    dir: dir.to_string(),
                });
                save(&inner);
            }
        }
    }

    /// Today's jobs, newest first, with the running ones' tokens read again.
    pub fn list(&self) -> Vec<Job> {
        let today = local_day_start((self.now)());
        let mut inner = self.inner.lock().unwrap();
        let running: Vec<u64> = inner
            .jobs
            .iter()
            .filter(|j| j.state == JobState::Running)
            .map(|j| j.id)
            .collect();
        for id in running {
            refresh_job(&mut inner, id, &*self.find);
        }
        let mut jobs: Vec<Job> = inner
            .jobs
            .iter()
            .filter(|j| j.started >= today)
            .cloned()
            .collect();
        jobs.sort_by(|a, b| b.turn_started.cmp(&a.turn_started));
        jobs
    }

    /// The steps of job `id`'s conversation from index `after` on, all its
    /// sessions merged by time.
    pub fn events(&self, id: u64, after: usize) -> Result<EventsPage, String> {
        let mut inner = self.inner.lock().unwrap();
        refresh_job(&mut inner, id, &*self.find);
        let job = inner
            .jobs
            .iter()
            .find(|j| j.id == id)
            .ok_or("No such job.")?;
        let merged = merged_events(&inner, job);
        let found = job
            .sessions
            .iter()
            .any(|s| inner.reads.get(&s.id).is_some_and(|r| r.path.is_some()));
        let next = merged.len();
        let events = merged
            .into_iter()
            .skip(after)
            .map(|e| cut_event(e.clone()))
            .collect();
        Ok(EventsPage {
            events,
            next,
            found,
        })
    }

    /// The whole input and output of tool call `tool` in job `id`.
    pub fn full(&self, id: u64, tool: &str) -> Result<ToolFull, String> {
        let inner = self.inner.lock().unwrap();
        let job = inner
            .jobs
            .iter()
            .find(|j| j.id == id)
            .ok_or("No such job.")?;
        let mut full = ToolFull {
            input: String::new(),
            output: String::new(),
        };
        for event in merged_events(&inner, job) {
            match event {
                TranscriptEvent::Tool { id, input, .. } if id == tool => full.input = input.clone(),
                TranscriptEvent::Result { tool_id, text, .. } if tool_id == tool => {
                    full.output = text.clone()
                }
                _ => {}
            }
        }
        Ok(full)
    }

    /// Raise job `id`'s cancel flag, if it runs.
    pub fn stop(&self, id: u64) {
        if let Some(cancel) = self.inner.lock().unwrap().cancels.get(&id) {
            cancel.store(true, Ordering::SeqCst);
        }
    }

    /// Stop the running job of `kind` that matches, if any: the Cancel of a
    /// review or a thread turn where it was started.
    pub fn stop_matching(&self, kind: JobKind, repo: &str, pr: u64, thread: Option<u64>) {
        let id = self
            .inner
            .lock()
            .unwrap()
            .jobs
            .iter()
            .find(|j| {
                j.state == JobState::Running
                    && j.kind == kind
                    && j.repo == repo
                    && j.pr == pr
                    && j.thread == thread
            })
            .map(|j| j.id);
        if let Some(id) = id {
            self.stop(id);
        }
    }

    /// The labels of the running jobs — none, and a quit goes ahead.
    pub fn running(&self) -> Vec<String> {
        let inner = self.inner.lock().unwrap();
        if inner.quitting {
            return Vec::new();
        }
        inner
            .jobs
            .iter()
            .filter(|j| j.state == JobState::Running)
            .map(|j| display_label(j))
            .collect()
    }

    /// For Stop and quit: let the quit through, stop every job, and wait
    /// (at most [`QUIT_WAIT`]) until each run has returned.
    pub fn stop_all_for_quit(&self) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.quitting = true;
            for cancel in inner.cancels.values() {
                cancel.store(true, Ordering::SeqCst);
            }
        }
        let deadline = Instant::now() + QUIT_WAIT;
        while Instant::now() < deadline && !self.inner.lock().unwrap().cancels.is_empty() {
            std::thread::sleep(Duration::from_millis(50));
        }
        save(&self.inner.lock().unwrap());
    }
}

// --- Tauri commands ------------------------------------------------------

#[tauri::command]
pub(crate) fn claude_jobs(jobs: tauri::State<ClaudeJobs>) -> Vec<Job> {
    jobs.list()
}

#[tauri::command(async)]
pub(crate) fn claude_job_events(
    id: u64,
    after: usize,
    jobs: tauri::State<ClaudeJobs>,
) -> Result<EventsPage, String> {
    jobs.events(id, after)
}

#[tauri::command(async)]
pub(crate) fn claude_job_full(
    id: u64,
    tool: String,
    jobs: tauri::State<ClaudeJobs>,
) -> Result<ToolFull, String> {
    jobs.full(id, &tool)
}

#[tauri::command]
pub(crate) fn claude_job_stop(id: u64, jobs: tauri::State<ClaudeJobs>) {
    jobs.stop(id);
}

/// Stop and quit, from the dialog [`QUIT_EVENT`] asked for.
#[tauri::command(async)]
pub(crate) fn claude_jobs_quit(app: tauri::AppHandle, jobs: tauri::State<ClaudeJobs>) {
    jobs.stop_all_for_quit();
    app.exit(0);
}

/// "Check · OrderService.java:88 · #3426", or the label alone.
fn display_label(job: &Job) -> String {
    if job.activity.is_empty() {
        job.label.clone()
    } else {
        format!("{} · {}", job.activity, job.label)
    }
}

/// Read job `id`'s transcripts again and update its tokens.
fn refresh_job(inner: &mut Inner, id: u64, find: &dyn Fn(&str) -> Option<PathBuf>) {
    let Some(job) = inner.jobs.iter().find(|j| j.id == id) else {
        return;
    };
    let (sessions, started, turn_started) = (
        job.sessions
            .iter()
            .map(|s| s.id.clone())
            .collect::<Vec<_>>(),
        job.started,
        job.turn_started,
    );
    let mut tokens = Usage::default();
    let mut turn_tokens = Usage::default();
    for session in &sessions {
        let read = inner.reads.entry(session.clone()).or_default();
        read.refresh(session, find);
        tokens.add(&read.usage_since(started));
        turn_tokens.add(&read.usage_since(turn_started));
    }
    if let Some(job) = inner.jobs.iter_mut().find(|j| j.id == id) {
        // A transcript gone since (Claude Code cleaned it up) keeps the count
        // the job had.
        if tokens.total() > 0 || job.state == JobState::Running {
            job.tokens = tokens;
            job.turn_tokens = turn_tokens;
        }
    }
}

/// The steps of all of `job`'s sessions, by time; a session's own order holds.
fn merged_events<'a>(inner: &'a Inner, job: &Job) -> Vec<&'a TranscriptEvent> {
    let mut all: Vec<&TranscriptEvent> = job
        .sessions
        .iter()
        .filter_map(|s| inner.reads.get(&s.id))
        .flat_map(|r| r.main.events.iter())
        .collect();
    all.sort_by_key(|e| e.at());
    all
}

fn cut_event(event: TranscriptEvent) -> EventOut {
    let mut cut = None;
    let event = match event {
        TranscriptEvent::Tool {
            at,
            id,
            name,
            summary,
            input,
            tokens,
        } => {
            let (input, full) = cap(&input, EVENT_TEXT_LIMIT);
            cut = full;
            TranscriptEvent::Tool {
                at,
                id,
                name,
                summary,
                input,
                tokens,
            }
        }
        TranscriptEvent::Result {
            at,
            tool_id,
            ok,
            text,
        } => {
            let (text, full) = cap(&text, EVENT_TEXT_LIMIT);
            cut = full;
            TranscriptEvent::Result {
                at,
                tool_id,
                ok,
                text,
            }
        }
        other => other,
    };
    EventOut { event, cut }
}

/// `text` cut to at most `limit` bytes on a char boundary, and its full
/// length when it was cut.
fn cap(text: &str, limit: usize) -> (String, Option<usize>) {
    if text.len() <= limit {
        return (text.to_string(), None);
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), Some(text.len()))
}

/// Write the list where [`ClaudeJobs::load`] said, if it did.
fn save(inner: &Inner) {
    let Some(file) = &inner.store else {
        return;
    };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec(&inner.jobs) {
        let tmp = file.with_extension("json.tmp");
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, file);
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::atomic::AtomicU64;

    /// Jobs with their clock at `clock` and transcripts under `projects`.
    fn jobs_at(clock: Arc<AtomicU64>, projects: PathBuf) -> ClaudeJobs {
        ClaudeJobs {
            inner: Arc::default(),
            find: Arc::new(move |id| gitp_core::transcript_path_in(&projects, id)),
            now: Arc::new(move || clock.load(Ordering::SeqCst)),
        }
    }

    fn review(pr: u64) -> NewJob {
        NewJob {
            kind: JobKind::Review,
            label: format!("Generate Drafts · #{pr}"),
            activity: String::new(),
            repo: "/src/app".into(),
            pr,
            thread: None,
            finding: None,
            command: "claude -p review".into(),
            stdin_bytes: 1234,
        }
    }

    fn turn(activity: &str) -> NewJob {
        NewJob {
            kind: JobKind::Thread,
            label: "Order.java:88 · #7".into(),
            activity: activity.into(),
            thread: Some(500),
            ..review(7)
        }
    }

    fn transcript(projects: &Path, session: &str, lines: &[serde_json::Value]) {
        let dir = projects.join("-src-app");
        std::fs::create_dir_all(&dir).unwrap();
        let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(dir.join(format!("{session}.jsonl")), text).unwrap();
    }

    fn answer(id: &str, at: &str, text: &str, output: u64) -> serde_json::Value {
        serde_json::json!({"type": "assistant", "timestamp": at, "message": {"id": id,
            "content": [{"type": "text", "text": text}],
            "usage": {"input_tokens": 10, "output_tokens": output}}})
    }

    // 2026-11-06T10:00:00Z.
    const T0: u64 = 1_793_959_200_000;

    #[test]
    fn a_second_review_of_the_same_pull_request_is_refused_and_stop_ends_it_as_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let jobs = jobs_at(Arc::new(AtomicU64::new(T0)), dir.path().into());
        let run = jobs.begin(review(7)).unwrap();
        assert_eq!(
            jobs.begin(review(7)).err().unwrap(),
            "A review of #7 is already running."
        );
        let other = jobs.begin(review(8)).unwrap();
        other.finish(Ok("No findings.".into()), &[]);
        assert_eq!(jobs.running(), ["Generate Drafts · #7"]);
        jobs.stop_matching(JobKind::Review, "/src/app", 7, None);
        assert!(run.cancel.load(Ordering::SeqCst), "the run sees the flag");
        run.finish(Err("Cancelled".into()), &[]);
        let list = jobs.list();
        let state = |pr| list.iter().find(|j| j.pr == pr).unwrap().state;
        assert_eq!((state(7), state(8)), (JobState::Stopped, JobState::Done));
        assert!(jobs.running().is_empty());
    }

    #[test]
    fn a_thread_is_one_job_across_its_turns_of_the_day() {
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(AtomicU64::new(T0));
        let jobs = jobs_at(Arc::clone(&clock), dir.path().into());
        let first = jobs.begin(turn("Check")).unwrap();
        assert_eq!(
            jobs.begin(turn("Follow-up")).err().unwrap(),
            "A turn on this thread is already running."
        );
        clock.store(T0 + 5_000, Ordering::SeqCst);
        first.finish(Ok("answer".into()), &[]);
        clock.store(T0 + 60_000, Ordering::SeqCst);
        let second = jobs.begin(turn("Follow-up")).unwrap();
        assert_eq!(second.id, 0, "the same job");
        clock.store(T0 + 62_000, Ordering::SeqCst);
        second.finish(Ok("more".into()), &[]);
        let list = jobs.list();
        assert_eq!(list.len(), 1);
        let job = &list[0];
        assert_eq!(
            (job.turns, job.activity.as_str(), job.spent),
            (2, "Follow-up", 7_000)
        );
        assert_eq!(job.output.as_deref(), Some("more"));
    }

    #[test]
    fn the_sessions_a_run_writes_give_the_conversation_and_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let jobs = jobs_at(Arc::new(AtomicU64::new(T0)), dir.path().into());
        let run = jobs.begin(turn("Fix")).unwrap();
        let tell = run.hooks().on_claude_run.unwrap();
        tell(&gitp_core::ClaudeRun {
            session: "fix-1".into(),
            resumed: false,
            dir: "/wt".into(),
        });
        tell(&gitp_core::ClaudeRun {
            session: "main-1".into(),
            resumed: true,
            dir: "/src/app".into(),
        });
        let page = jobs.events(0, 0).unwrap();
        assert!(!page.found && page.events.is_empty(), "no transcript yet");
        let big = "x".repeat(EVENT_TEXT_LIMIT + 10);
        transcript(
            dir.path(),
            "fix-1",
            &[
                serde_json::json!({"type": "user", "timestamp": "2026-11-06T10:00:01.000Z",
                "message": {"content": "Fix it."}}),
                serde_json::json!({"type": "assistant", "timestamp": "2026-11-06T10:00:02.000Z",
                "message": {"id": "a", "content": [{"type": "tool_use", "id": "t1", "name": "Bash",
                "input": {"command": "make test"}}], "usage": {"input_tokens": 100, "output_tokens": 5}}}),
                serde_json::json!({"type": "user", "timestamp": "2026-11-06T10:00:03.000Z",
                "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": big}]}}),
            ],
        );
        transcript(
            dir.path(),
            "main-1",
            &[
                // Before the job: shown, not counted.
                answer("old", "2026-11-05T09:00:00.000Z", "Yesterday's check.", 50),
                answer("b", "2026-11-06T10:00:04.000Z", "Reply drafted.", 7),
            ],
        );
        let page = jobs.events(0, 0).unwrap();
        assert!(page.found);
        let kinds: Vec<String> = page
            .events
            .iter()
            .map(|e| {
                serde_json::to_value(e).unwrap()["kind"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(kinds, ["text", "prompt", "tool", "result", "text"]);
        assert_eq!(page.events[3].cut, Some(EVENT_TEXT_LIMIT + 10));
        assert_eq!(jobs.full(0, "t1").unwrap().output, big);
        assert_eq!(jobs.events(0, page.next).unwrap().events.len(), 0);
        let job = &jobs.list()[0];
        assert_eq!(job.tokens.total(), 105 + 17);
        assert_eq!(job.sessions.len(), 2);
    }

    #[test]
    fn todays_jobs_come_back_after_a_restart_and_a_running_one_is_interrupted() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("jobs").join("claude-jobs.json");
        let clock = Arc::new(AtomicU64::new(T0));
        let jobs = jobs_at(Arc::clone(&clock), dir.path().into());
        jobs.load(file.clone());
        jobs.begin(review(1))
            .unwrap()
            .finish(Err("boom".into()), &[]);
        let _still = jobs.begin(review(2)).unwrap();
        let again = jobs_at(Arc::clone(&clock), dir.path().into());
        again.load(file.clone());
        let list = again.list();
        let state = |pr| list.iter().find(|j| j.pr == pr).unwrap().state;
        assert_eq!(
            (state(1), state(2)),
            (JobState::Failed, JobState::Interrupted)
        );
        assert_eq!(again.begin(review(3)).unwrap().id, 2, "ids go on");
        clock.store(T0 + 2 * 86_400_000, Ordering::SeqCst);
        let later = jobs_at(clock, dir.path().into());
        later.load(file);
        assert!(later.list().is_empty(), "yesterday's jobs are gone");
    }

    #[test]
    fn stop_and_quit_stops_every_job_and_waits_for_them() {
        let dir = tempfile::tempdir().unwrap();
        let jobs = jobs_at(Arc::new(AtomicU64::new(T0)), dir.path().into());
        let run = jobs.begin(review(1)).unwrap();
        let worker = std::thread::spawn(move || {
            while !run.cancel.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
            run.finish(Err("Cancelled".into()), &[]);
        });
        jobs.stop_all_for_quit();
        worker.join().unwrap();
        assert_eq!(jobs.list()[0].state, JobState::Stopped);
        assert!(jobs.running().is_empty(), "the quit goes through");
    }

    #[test]
    fn cap_cuts_on_a_char_boundary() {
        assert_eq!(cap("héllo", 2), ("h".to_string(), Some(6)));
        assert_eq!(cap("hi", 2), ("hi".to_string(), None));
    }
}
