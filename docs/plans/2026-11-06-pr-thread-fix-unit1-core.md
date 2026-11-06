# PR thread Fix, unit 1: the core fix turn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Repo::fix_thread`: find the pull request branch's worktree, refuse a dirty or behind one, run the fix command there, verify exactly one commit, undo on failure, then draft the reply; plus the storage fields and the posted/dropped marks.

**Architecture:** `thread_claude_turn` is split: the body becomes a private `run_turn(gh, input, kind, user_text, command, place)` where `place` names the working directory, extra environment and which session id to resume. `thread_claude_turn` calls it in the main workdir; `fix_thread` calls it twice, in the worktree for the fix and in the workdir for the reply draft. Git commands in another directory go through a small `git_in(dir, args)` helper over `git_command()`.

**Tech Stack:** Rust, git2, serde_json.

**Spec:** `docs/specs/2026-11-06-pr-thread-fix-design.md`.

## Global Constraints

- `TurnKind::Fix` serialises as `fix`; `GITP_TURN_KIND=fix`.
- Extra environment for the fix: `GITP_FIX_WORKTREE`, `GITP_FIX_BRANCH`, `GITP_FIX_HEAD_BEFORE`.
- Preconditions, in this order, each its own message: no option chosen ("Send the option you want as a follow-up first."); branch checked out nowhere ("Check the pull request out first: its branch <branch> is in no worktree."); dirty worktree ("Commit or stash the changes in <path> first."); behind ("The local branch is behind GitHub: pull it first.").
- After the run: `git status --porcelain` empty, `git rev-list --count <before>..HEAD` is `1`, `git rev-parse --abbrev-ref HEAD` is the branch. Any failure: `git reset --hard <before>`, `git clean -fd`, and the error.
- Fix timeout: `FIX_TIMEOUT` = 30 minutes.
- Never run `rustfmt` on `lib.rs`.

## Review Focus

1. A fix command that commits twice is undone, not accepted (Task 2).
2. A fix command that exits non-zero after editing files leaves the worktree exactly at `<before>` with no untracked files (Task 2).
3. A dirty worktree is refused before the command runs (Task 2: the command would create a marker file; assert it is absent).
4. The reply-draft turn after a fix runs in the main workdir and resumes `session`, while the fix resumed `fix_session` (Task 2: the fake commands print `$PWD` and `$GITP_CLAUDE_SESSION`).
5. The pull request branch checked out in the **main** checkout is found too (Task 2: a repo with no linked worktree).

---

### Task 1: Storage fields and marks

**Files:** `crates/gitp-core/src/pr_threads.rs`, `crates/gitp-core/src/lib.rs` (no new export needed).

**Produces:**

```rust
pub enum TurnKind { Check, Explain, Followup, ReplyDraft, Fix }   // "fix"
pub struct ThreadTurn { …, #[serde(default, skip_serializing_if = "Option::is_none")] pub commit: Option<String>,
    pub worktree: Option<String>, pub posted: Option<String>, #[serde(default, skip_serializing_if = "std::ops::Not::not")] pub dropped: bool }
pub struct ThreadConversation { …, #[serde(default, skip_serializing_if = "Option::is_none")] pub fix_session: Option<String> }
impl Repo {
    /// Marks the latest reply-draft turn posted at `url`; Err when there is none.
    pub fn mark_reply_posted(&self, number: u64, thread: u64, url: &str) -> Result<()>;
    /// Marks the latest reply-draft turn dropped; Err when there is none.
    pub fn drop_reply(&self, number: u64, thread: u64) -> Result<()>;
}
/// The latest reply-draft turn that is neither posted nor dropped.
pub fn prepared_reply(c: &ThreadConversation) -> Option<&ThreadTurn>;
```

- [ ] Test (RED): `a_prepared_reply_is_the_latest_draft_until_posted_or_dropped`: a conversation with draft A then draft B → `prepared_reply` is B; `mark_reply_posted(.., "https://x")` → `None`, B's `posted == Some("https://x")`; a new draft C → C; `drop_reply` → `None`, C `dropped`; on a conversation with no draft both return Err. Also `a_turn_without_the_new_fields_still_loads` (parse the old JSON shape from unit 1 of the first design).
- [ ] Implement; every existing `ThreadTurn { … }` literal in gh.rs gains `commit: None, worktree: None, posted: None, dropped: false` (use a `ThreadTurn::claude(kind, head, text)` and `ThreadTurn::user(kind, text)` constructor pair to avoid repeating it) and `ThreadConversation` literals gain `fix_session: None`.
- [ ] `cargo test -p gitp-core --lib pr_threads` → PASS, then `cargo test -p gitp-core --lib` → PASS.
- [ ] Commit `feat(core): fix, posted and dropped on a thread's turns`.

### Task 2: `fix_thread`

**Files:** `crates/gitp-core/src/gh.rs`.

**Produces:**

```rust
pub const FIX_TIMEOUT: Duration = Duration::from_secs(30 * 60);
struct TurnPlace<'a> { dir: &'a Path, extra_env: Vec<(&'static str, String)>, timeout: Duration, fix_session: bool }
fn run_turn(&self, gh, input, kind, user_text, command, place: TurnPlace) -> Result<ThreadConversation>  // the old body, generalised
pub fn thread_claude_turn(…)  // = run_turn in self.workdir(), EXPLAIN_TIMEOUT, fix_session: false
pub fn fix_thread(&self, gh: &Gh, input: &ThreadInput, branch: &str, fix_command: &str, reply_command: &str) -> Result<ThreadConversation>
pub(crate) fn git_in(dir: &Path, args: &[&str]) -> Result<String>  // git_command(), GIT_TERMINAL_PROMPT=0, trimmed combined output, Err on non-zero
```

`fix_thread`: `user_text` is the last user turn of the saved conversation (`Err` when none); the worktree is the first `self.worktrees()?` entry with `branch == Some(branch)`; `git_in(dir, ["status","--porcelain"])` must be empty; `git_in(dir, ["merge-base","--is-ancestor", &input.head, "HEAD"])` must succeed; `before = git_in(dir, ["rev-parse","HEAD"])`; `run_turn(.., Fix, user_text, fix_command, TurnPlace{dir, extra_env: [WORKTREE, BRANCH, HEAD_BEFORE], FIX_TIMEOUT, fix_session: true})`; on `Err` or any failed check → `undo(dir, before)` (`reset --hard before`, `clean -fd`) and return the error; on success set the Fix turn's `commit` (the new HEAD) and `worktree`, and its `head` to the new HEAD, save; then `run_turn(.., ReplyDraft, user_text, reply_command, main place)`.

- [ ] Tests (RED), in `gh.rs` tests, on a temp repo with a GitHub remote whose branch `feature` is checked out in a linked worktree (`git worktree add`), with one prior Check turn and a user follow-up "restore >" saved, head = the repo's HEAD:
  - `a_fix_runs_in_the_branch_worktree_commits_once_and_drafts_the_reply`: fix command `printf '{"result":"fixed in %s","session_id":"fs"}' "$PWD"; echo x > fixed.txt; git add fixed.txt; git commit -qm "fix(review): a:1 — x"` — wait, the JSON is printed before the commit; fine, stdout is the answer. Reply command `printf '{"result":"reply from %s session=%s","session_id":"rs"}' "$PWD" "$GITP_CLAUDE_SESSION"`. Assert: turns end with Fix then ReplyDraft; Fix `commit` is the worktree HEAD after, `worktree` is the path, text contains the worktree path; ReplyDraft text contains the main workdir path and `session=` the old main session (`None` → empty); `fix_session == Some("fs")`, `session == Some("rs")`; the env `GITP_FIX_HEAD_BEFORE` equalled the earlier HEAD (print it in the fix command too).
  - `a_fix_that_commits_twice_or_leaves_the_tree_dirty_is_undone`: a command that commits twice → Err containing "one commit"; HEAD back at before, `fixed.txt` gone; a command that writes a file and exits 0 without committing → Err, file gone; a command that exits 3 → Err with "exit code 3", tree clean at before.
  - `a_fix_refuses_a_dirty_worktree_a_missing_one_and_a_branch_behind`: dirty (an untracked file) → Err "Commit or stash", marker file the command would create absent; branch "nowhere" → Err "in no worktree"; head set to a commit not in the branch (make one on another branch) → Err "behind".
  - `a_fix_finds_the_branch_in_the_main_checkout`: a repo whose main checkout is on `feature`, no linked worktree → the fix commit lands on the main checkout.
  - `a_fix_needs_a_chosen_option`: no user turn → Err "follow-up first".
- [ ] Implement.
- [ ] `cargo test -p gitp-core --lib` → PASS; `cargo clippy -p gitp-core --lib --tests` clean of new warnings.
- [ ] Commit `feat(core): fix a review thread in the pull request's worktree and draft the reply`.
