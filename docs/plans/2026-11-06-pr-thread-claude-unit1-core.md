# PR thread Claude, unit 1: storage and runner in gitp-core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Rust side of "Claude on a pull request thread": a conversation file per thread under `.git/gitp/pr-threads/`, and one function that runs a thread command for a turn and appends its answer.

**Architecture:** A new `pr_threads.rs` module owns the JSON file (load, save, delete, prune) keyed on the repository's `common_dir()`. `gh.rs` gains `thread_claude_turn`, built like `generate_review_drafts` and `explain_review_finding`: fetch the head when missing, write the thread as a temp JSON file, run the shell line through `run_shell` with the cancel flag, read the answer, append the turn, save. No Tauri, no frontend in this unit.

**Tech Stack:** Rust, git2, serde_json, tempfile (all already in `gitp-core`).

**Spec:** `docs/specs/2026-11-06-pr-thread-claude-design.md` (sections "Storage", "What the command gets", "Rust and frontend shape").

## Global Constraints

- Files live under `<common_dir>/gitp/pr-threads/<pr number>/<root comment id>.json`; never under the working tree.
- Writes are whole-file and atomic: write `<file>.tmp`, then rename.
- Pruning deletes a file whose last turn is older than 60 days, then empty `<pr number>` folders; a file that fails to parse is deleted too.
- The command gets `GITP_PR_NUMBER`, `GITP_PR_REPO`, `GITP_PR_URL`, `GITP_PR_HEAD`, `GITP_PR_AUTHOR`, `GITP_GH_LOGIN`, `GITP_THREAD_ID`, `GITP_THREAD_PATH`, `GITP_THREAD_LINE`, `GITP_THREAD_FILE`, `GITP_CLAUDE_SESSION`, `GITP_TURN_KIND`; the user's text on stdin.
- Turn kinds are exactly `check`, `explain`, `followup`, `reply-draft`.
- Timeout per turn: 20 minutes (`EXPLAIN_TIMEOUT`).
- Times are stored as epoch milliseconds (`u64`), not ISO strings: the crate has no date library and the frontend formats dates already. (A deviation from the spec's example JSON, which is illustrative.)
- Never run `rustfmt` on `lib.rs`; format only your own hunks. `cargo` needs the sandbox off and `source "$HOME/.cargo/env"`.

## Review Focus

1. A thread id or PR number that is not a plain integer must never form a path: both are `u64`, so the file name is numeric by type (Task 1 tests a save/load round trip of `(3426, 1234567890)`).
2. A damaged JSON file must not make the view fail: `load` returns `Ok(None)` and the file is deleted (Task 1).
3. A command that prints plain Markdown, not JSON, must still work: the whole stdout is the text and no session is stored (Task 3).
4. A `claude --output-format json` answer whose `is_error` is true must fail the turn with its `result` as the message, not store it as an answer (Task 3).
5. A head commit that is already local must not trigger a network fetch (Task 2).

---

### Task 1: The conversation file

**Files:**
- Create: `crates/gitp-core/src/pr_threads.rs`
- Modify: `crates/gitp-core/src/lib.rs` (add `mod pr_threads;` in alphabetical order after `mod pick_plan;`; `pub use pr_threads::{ThreadConversation, ThreadTurn, TurnKind, TurnRole};` next to the other `pub use` lines)

**Interfaces:**
- Produces:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TurnKind { Check, Explain, Followup, ReplyDraft }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnRole { User, Claude }

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadConversation {
    pub version: u32,          // 1
    pub pr: u64,
    pub thread: u64,
    pub path: String,
    /// The Claude Code session to resume; `None` until a JSON answer gave one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    pub turns: Vec<ThreadTurn>,
}

pub const THREAD_KEEP: Duration = Duration::from_secs(60 * 24 * 60 * 60);

impl Repo {
    pub fn thread_conversation(&self, number: u64, thread: u64) -> Result<Option<ThreadConversation>>;
    pub fn save_thread_conversation(&self, c: &ThreadConversation) -> Result<()>;
    pub fn clear_thread_conversation(&self, number: u64, thread: u64) -> Result<()>;
    /// Deletes stale and damaged files; returns how many files were deleted.
    pub fn prune_thread_conversations(&self, now_millis: u64) -> Result<usize>;
}

pub(crate) fn now_millis() -> u64;
```

- The folder: `self.common_dir().join("gitp/pr-threads").join(number.to_string())`, file `format!("{thread}.json")`.

- [ ] **Step 1: Write the failing tests** at the bottom of `pr_threads.rs` in `mod tests`, with a `fn repo() -> (tempfile::TempDir, Repo)` that inits a git2 repository with one empty commit (copy the shape of `repo_with` in `gh.rs` tests, no remotes):

```rust
#[test]
fn a_conversation_is_saved_under_the_git_dir_and_loaded_back() {
    let (dir, repo) = repo();
    assert_eq!(repo.thread_conversation(3426, 1234567890).unwrap(), None);
    let c = ThreadConversation { version: 1, pr: 3426, thread: 1234567890, path: "src/retry.ts".into(),
        session: Some("9f3c".into()), turns: vec![ThreadTurn { kind: TurnKind::Check, role: TurnRole::Claude,
        at: 1_000, head: Some("a1b2".into()), text: "**Bottom line:** …".into() }] };
    repo.save_thread_conversation(&c).unwrap();
    let file = dir.path().join(".git/gitp/pr-threads/3426/1234567890.json");
    assert!(file.is_file());
    assert!(!dir.path().join("gitp").exists(), "never in the working tree");
    assert!(!file.with_extension("json.tmp").exists(), "the temp file was renamed away");
    assert_eq!(repo.thread_conversation(3426, 1234567890).unwrap(), Some(c));
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.contains("\"kind\":\"check\"") || text.contains("\"kind\": \"check\""));
    repo.clear_thread_conversation(3426, 1234567890).unwrap();
    assert!(!file.exists());
    repo.clear_thread_conversation(3426, 1234567890).unwrap(); // clearing twice is fine
}

#[test]
fn a_damaged_file_loads_as_nothing_and_is_deleted() {
    let (dir, repo) = repo();
    let file = dir.path().join(".git/gitp/pr-threads/1/2.json");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "{not json").unwrap();
    assert_eq!(repo.thread_conversation(1, 2).unwrap(), None);
    assert!(!file.exists());
}

#[test]
fn pruning_deletes_conversations_older_than_sixty_days_and_empty_folders() {
    let (dir, repo) = repo();
    let turn = |at| ThreadTurn { kind: TurnKind::Check, role: TurnRole::Claude, at, head: None, text: "x".into() };
    let conv = |pr, thread, at| ThreadConversation { version: 1, pr, thread, path: "a".into(), session: None, turns: vec![turn(1), turn(at)] };
    let now: u64 = 100 * 24 * 60 * 60 * 1000;
    let keep = THREAD_KEEP.as_millis() as u64;
    repo.save_thread_conversation(&conv(1, 10, now - keep - 1)).unwrap();   // stale: last turn 60 days + 1 ms ago
    repo.save_thread_conversation(&conv(1, 11, now - keep + 1)).unwrap();   // fresh
    repo.save_thread_conversation(&conv(2, 20, now - keep - 1)).unwrap();   // stale, folder becomes empty
    let damaged = dir.path().join(".git/gitp/pr-threads/3/30.json");
    std::fs::create_dir_all(damaged.parent().unwrap()).unwrap();
    std::fs::write(&damaged, "nope").unwrap();
    assert_eq!(repo.prune_thread_conversations(now).unwrap(), 3);
    assert!(repo.thread_conversation(1, 10).unwrap().is_none());
    assert!(repo.thread_conversation(1, 11).unwrap().is_some());
    assert!(!dir.path().join(".git/gitp/pr-threads/2").exists());
    assert!(!dir.path().join(".git/gitp/pr-threads/3").exists());
    assert_eq!(repo.prune_thread_conversations(now).unwrap(), 0, "a second pass finds nothing");
    let (_d2, empty) = repo();
    assert_eq!(empty.prune_thread_conversations(now).unwrap(), 0, "no folder yet is not an error");
}

#[test]
fn a_conversation_with_no_turns_counts_as_stale() {
    let (_dir, repo) = repo();
    repo.save_thread_conversation(&ThreadConversation { version: 1, pr: 1, thread: 1, path: "a".into(), session: None, turns: vec![] }).unwrap();
    assert_eq!(repo.prune_thread_conversations(u64::MAX).unwrap(), 1);
}
```

- [ ] **Step 2: Run the tests to see them fail**

Run (sandbox off): `source "$HOME/.cargo/env" && cargo test -p gitp-core pr_threads 2>&1 | tail -20`
Expected: compile error, `pr_threads` not found.

- [ ] **Step 3: Implement `pr_threads.rs`** with the types and the four `impl Repo` methods above, plus `now_millis()` (`SystemTime::now()` since the epoch, as `local_history::now_millis` does). `save` creates the folder, writes `<file>.tmp` with `serde_json::to_vec_pretty`, renames. `load` returns `Ok(None)` when the file is missing; on a parse error it deletes the file and returns `Ok(None)`. `prune` walks `pr-threads/*/*.json`, loads each (so a damaged one is deleted by `load`), deletes when `turns.last().map(|t| t.at)` is `None` or `< now.saturating_sub(THREAD_KEEP millis)`, then `remove_dir` on each `<pr>` folder, ignoring the not-empty error. A missing `pr-threads` folder is `Ok(0)`. Errors map to `Error::Message` with the path in the text.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cargo test -p gitp-core pr_threads 2>&1 | tail -8`
Expected: `test result: ok. 4 passed`.

- [ ] **Step 5: Commit**

```bash
git add crates/gitp-core/src/pr_threads.rs crates/gitp-core/src/lib.rs
git commit -m "feat(core): keep a Claude conversation per pull request thread under .git"
```

---

### Task 2: Fetch the pull request head when it is missing

**Files:**
- Modify: `crates/gitp-core/src/gh.rs` (next to `checkout_pull_request`, around line 929)
- Test: `gh.rs` `mod tests`

**Interfaces:**
- Consumes: `Repo::find_github_remote() -> Option<(String, GitHubRepo)>` (gh.rs:699, the remote name and the repo), `Repo::run_git_network(&[&str])` (progress.rs:85, honours the cancel flag), `Repo::resolve_commit(&str)` (repo.rs).
- Produces:

```rust
impl Repo {
    /// Make pull request `number`'s head commit `head` (40 hex) available
    /// locally: nothing when it already is, else `git fetch <remote>
    /// pull/<number>/head:refs/gitp/pr/<number>/head`.
    pub fn ensure_pull_request_head(&self, number: u64, head: &str) -> Result<()>;
}
```

- [ ] **Step 1: Write the failing test** in `gh.rs` tests, next to the review-command tests:

```rust
#[test]
fn a_pull_request_head_is_fetched_into_a_private_ref_only_when_missing() {
    // A second local repository stands in for GitHub: `origin` points at it.
    let (upstream_dir, _upstream) = github_repo();
    let upstream = git2::Repository::open(upstream_dir.path()).unwrap();
    let head = upstream.head().unwrap().peel_to_commit().unwrap();
    upstream.reference("refs/pull/7/head", head.id(), true, "pr").unwrap();
    let (dir, repo) = repo_with(&[("origin", upstream_dir.path().to_str().unwrap())]);
    let sha = head.id().to_string();
    assert!(repo.resolve_commit(&sha).is_err(), "not local yet");
    repo.ensure_pull_request_head(7, &sha).unwrap();
    assert_eq!(repo.resolve_commit("refs/gitp/pr/7/head").unwrap(), sha);
    assert_eq!(repo.resolve_commit(&sha).unwrap(), sha);
    // Already local: no fetch, so a remote that no longer exists is fine.
    git2::Repository::open(dir.path()).unwrap().remote_set_url("origin", "/nonexistent").unwrap();
    let repo = Repo::open(dir.path()).unwrap();
    repo.ensure_pull_request_head(7, &sha).unwrap();
    assert!(repo.ensure_pull_request_head(8, "0000000000000000000000000000000000000000").is_err());
}
```

The remote to fetch from: the first remote whose URL `github_repo_from_url` recognises, else `origin`. The test registers a local path on `origin`, which exercises the fallback; the GitHub case needs no network test.

- [ ] **Step 2: Run it to see it fail**

Run: `cargo test -p gitp-core a_pull_request_head_is_fetched 2>&1 | tail -8`
Expected: compile error, no method `ensure_pull_request_head`.

- [ ] **Step 3: Implement `ensure_pull_request_head`**: validate `head` is 40 hex (else `Error::Message("not a commit id: …")`); `if self.resolve_commit(head).is_ok() { return Ok(()) }`; pick the remote (first GitHub remote, else `origin`); `self.run_git_network(&["fetch", &remote, &format!("pull/{number}/head:refs/gitp/pr/{number}/head")])?`; then `resolve_commit(head)` again, erroring with `"#{number}'s head {head} is not what the fetch brought"` when still missing.

- [ ] **Step 4: Run it to see it pass**

Run: `cargo test -p gitp-core a_pull_request_head_is_fetched 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/gitp-core/src/gh.rs
git commit -m "feat(core): fetch a pull request's head into refs/gitp/pr when it is missing"
```

---

### Task 3: Run one turn of a thread command

**Files:**
- Modify: `crates/gitp-core/src/gh.rs` (next to `explain_review_finding`, around line 1534)
- Test: `gh.rs` `mod tests`

**Interfaces:**
- Consumes: Task 1's types and `Repo::thread_conversation` / `save_thread_conversation` / `now_millis`; Task 2's `ensure_pull_request_head`; `run_shell(dir, command, input, env, timeout, cancel)` (gh.rs ~1593); `EXPLAIN_TIMEOUT`; `Gh::account()` for the login; `PrReviewComment`.
- Produces:

```rust
/// One line-comment thread as the view has it, for a turn.
#[derive(Debug, Clone, Deserialize)]
pub struct ThreadInput {
    pub number: u64,
    pub head: String,
    pub author: String,          // the pull request's author login
    pub comments: Vec<PrReviewComment>,  // root first, in order
}

impl Repo {
    /// Run `command` for one turn of kind `kind` on the thread; `user_text`
    /// goes on stdin. Appends the turn(s) and returns the saved conversation.
    pub fn thread_claude_turn(
        &self,
        gh: &Gh,
        input: &ThreadInput,
        kind: TurnKind,
        user_text: &str,
        command: &str,
    ) -> Result<ThreadConversation>;
}
```

Behaviour the signature does not pin:
- The thread id is `comments[0].id`; `path`, `line`/`original_line`, `diff_hunk` come from `comments[0]`. Empty `comments` → `Error::Message("The thread has no comments.")`. Empty command → `"Set a thread command in Settings → Git first."`
- `GITP_THREAD_LINE` is `line` when `Some`, else `original_line`, else empty.
- `GITP_GH_LOGIN` is `gh.account().ok().and_then(|a| a.login).unwrap_or_default()`.
- The temp file: `tempfile::NamedTempFile` in `std::env::temp_dir()`, holding `serde_json::json!({ "path", "line", "original_line", "diff_hunk", "comments": [{author, created_at, body}...], "turns": <existing turns> })`; kept alive until the command returns.
- For `Followup`, a user turn (`role: User, kind: Followup, at, head: None, text: user_text`) is appended **before** running, and kept even when the run fails (the save happens before the run). For the other kinds nothing is appended before the run.
- Output: if `stdout.trim_start().starts_with('{')` and parses as JSON with a string `result`: when `is_error` is `true`, fail with `result`; else text = `result`, and `session_id` (string) replaces `conversation.session` when present. Otherwise text = whole stdout; `session` unchanged. Empty text → `"The thread command printed nothing."`
- The Claude turn appended: `role: Claude, kind, at: now_millis(), head: Some(input.head.clone()), text`.
- A new conversation is `ThreadConversation { version: 1, pr: input.number, thread, path, session: None, turns: vec![] }`.

- [ ] **Step 1: Write the failing tests** in `gh.rs` tests. A helper `fn thread_input(repo: &Repo) -> ThreadInput` builds one with `number: 7`, `head: <the repo's HEAD sha>` (already local, so no fetch), `author: "octocat"`, and two comments (root `id: 500`, `path: "src/retry.ts"`, `line: Some(12)`, `original_line: Some(12)`, `body: "stops early?"`, `author: "anna"`, `diff_hunk: "@@ -1 +1 @@\n-a\n+b"`, `created_at: "2026-11-04T09:00:00Z"`, `side: "RIGHT"`, `in_reply_to: None`, `url: ""`; reply `id: 501`, `in_reply_to: Some(500)`, body `"yes?"`, the rest alike).

```rust
#[test]
fn a_thread_turn_gets_the_thread_in_its_environment_and_file_and_is_saved() {
    let fake = Fake::new();
    fake.answer("auth status", "", "Logged in to github.com account me (keyring)\n", 0); // whatever makes account().login == Some("me"); else assert GITP_GH_LOGIN is "".
    let (_dir, repo) = github_repo();
    let input = thread_input(&repo);
    let cmd = "printf '%s|%s|%s|%s|%s|%s|%s|%s|' \"$GITP_PR_NUMBER\" \"$GITP_PR_URL\" \"$GITP_PR_HEAD\" \"$GITP_PR_AUTHOR\" \"$GITP_THREAD_ID\" \"$GITP_THREAD_PATH\" \"$GITP_THREAD_LINE\" \"$GITP_TURN_KIND\"; cat \"$GITP_THREAD_FILE\"";
    let c = repo.thread_claude_turn(&fake.gh(), &input, TurnKind::Check, "", cmd).unwrap();
    assert_eq!(c.turns.len(), 1);
    let t = &c.turns[0];
    assert_eq!((t.kind, t.role, t.head.as_deref()), (TurnKind::Check, TurnRole::Claude, Some(input.head.as_str())));
    assert!(t.text.starts_with(&format!("7|https://github.com/octo/hello/pull/7|{}|octocat|500|src/retry.ts|12|check|", input.head)), "{}", t.text);
    let json: serde_json::Value = serde_json::from_str(t.text.split_once("|check|").unwrap().1).unwrap();
    assert_eq!(json["comments"][1]["body"], "yes?");
    assert_eq!(json["turns"].as_array().unwrap().len(), 0, "the first turn sees no history");
    assert_eq!(c.session, None, "plain text gives no session");
    assert_eq!(repo.thread_conversation(7, 500).unwrap(), Some(c));
}

#[test]
fn a_followup_stores_the_question_sends_it_on_stdin_and_resumes_the_session() {
    let fake = Fake::new();
    let (_dir, repo) = github_repo();
    let input = thread_input(&repo);
    let json_cmd = r#"printf '{"result":"first answer","session_id":"s-1","is_error":false}'"#;
    let c = repo.thread_claude_turn(&fake.gh(), &input, TurnKind::Check, "", json_cmd).unwrap();
    assert_eq!((c.session.as_deref(), c.turns[0].text.as_str()), (Some("s-1"), "first answer"));
    let cmd = r#"q=$(cat); printf '{"result":"%s / %s / %s","session_id":"s-2"}' "$GITP_CLAUDE_SESSION" "$q" "$GITP_TURN_KIND""#;
    let c = repo.thread_claude_turn(&fake.gh(), &input, TurnKind::Followup, "why?", cmd).unwrap();
    assert_eq!(c.turns.len(), 3);
    assert_eq!((c.turns[1].role, c.turns[1].kind, c.turns[1].text.as_str(), c.turns[1].head.as_deref()), (TurnRole::User, TurnKind::Followup, "why?", None));
    assert_eq!(c.turns[2].text, "s-1 / why? / followup");
    assert_eq!(c.session.as_deref(), Some("s-2"));
    // A failed follow-up keeps the question.
    let err = repo.thread_claude_turn(&fake.gh(), &input, TurnKind::Followup, "again?", "exit 2").unwrap_err();
    assert!(message(err).contains("exit code 2"));
    let c = repo.thread_conversation(7, 500).unwrap().unwrap();
    assert_eq!((c.turns.len(), c.turns[3].text.as_str()), (4, "again?"));
}

#[test]
fn a_json_answer_that_is_an_error_fails_the_turn_and_stores_nothing() {
    let fake = Fake::new();
    let (_dir, repo) = github_repo();
    let input = thread_input(&repo);
    let err = repo.thread_claude_turn(&fake.gh(), &input, TurnKind::Explain, "",
        r#"printf '{"result":"Not logged in","is_error":true}'"#).unwrap_err();
    assert!(message(err).contains("Not logged in"));
    assert_eq!(repo.thread_conversation(7, 500).unwrap(), None);
    let err = repo.thread_claude_turn(&fake.gh(), &input, TurnKind::Explain, "", "true").unwrap_err();
    assert!(message(err).contains("printed nothing"));
    assert!(repo.thread_claude_turn(&fake.gh(), &input, TurnKind::Explain, "", "  ").is_err());
    let empty = ThreadInput { comments: vec![], ..input.clone() };
    assert!(repo.thread_claude_turn(&fake.gh(), &empty, TurnKind::Check, "", "true").is_err());
}
```

If the `Fake` gh has no easy way to answer `auth status`, drop that line and assert nothing about the login in the first test; the login's presence is covered by `Gh::account`'s own tests.

- [ ] **Step 2: Run them to see them fail**

Run: `cargo test -p gitp-core a_thread_turn a_followup_stores a_json_answer 2>&1 | tail -8` (three invocations or one with the shared prefix `thread`)
Expected: compile errors for `ThreadInput` / `thread_claude_turn`.

- [ ] **Step 3: Implement `ThreadInput` and `thread_claude_turn`** in `gh.rs` as the Interfaces block says: `ensure_pull_request_head(input.number, &input.head)?` first, then load-or-new, pre-append for `Followup` and save, write the temp file, build `env` as a `Vec<(&str, String)>`, `run_shell(self.workdir(), command, user_text.as_bytes(), &env, EXPLAIN_TIMEOUT, self.net.cancel.as_deref())?`, parse, append, save, return. Reuse `github_target()` for `GITP_PR_REPO` / `GITP_PR_URL` exactly as `generate_review_drafts` builds them.

- [ ] **Step 4: Run the tests to see them pass**, then the whole crate's gh and pr_threads tests:

Run: `cargo test -p gitp-core thread 2>&1 | tail -8` then `cargo test -p gitp-core gh:: 2>&1 | tail -5`
Expected: all PASS; no previously green test red.

- [ ] **Step 5: Commit**

```bash
git add crates/gitp-core/src/gh.rs
git commit -m "feat(core): run one Claude turn on a pull request thread and keep it"
```
