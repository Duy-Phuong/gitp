# PR thread Claude, unit 2: Tauri commands, frontend state, default commands — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bridge between unit 1 and the UI: four Tauri commands over the core functions, the frontend state of thread conversations with running jobs, and the three default thread commands with their read-only tool list.

**Architecture:** `crates/gitp-gui/src/gh.rs` gains `gh_thread_turn` (background, per-thread cancel flag in a `ThreadJobs` map like `ReviewJobs`), `gh_thread_conversation`, `gh_thread_clear`, `gh_thread_prune`, each a thin `_impl` over unit 1. `api.ts` binds them with mocks for `vite dev`. A new `pr-threads.ts` keeps the per-thread state (`running`, `error`, `conversation`) with listeners, like `pr-reviews.ts`. `prefs.ts` gains `THREAD_TOOLS`, the three default command lines and their load/save.

**Tech Stack:** Rust + Tauri v2 commands; TypeScript, vitest.

**Spec:** `docs/specs/2026-11-06-pr-thread-claude-design.md` (sections "What the command gets", "Default commands", "Rust and frontend shape").

## Global Constraints

- The thread commands' tool list is read-only: `Read`, `Grep`, `Glob`, `Skill`, the git and `gh` lookups of `SKILL_TOOLS`, `ToolSearch`; none of `Edit(...)`, `mkdir`, `rm`, `python3`, `curl`, `ArtifactData`.
- Every default command is `claude -p "<prompt>" --model opus --effort medium --permission-mode dontAsk --allowedTools "<THREAD_TOOLS>" --output-format json ${GITP_CLAUDE_SESSION:+--resume "$GITP_CLAUDE_SESSION"}`, prompt first (an `--allowedTools` list swallows what follows it).
- The `check` prompt says: read the thread in `$GITP_THREAD_FILE` on `$GITP_PR_URL`; check the claim against the code at `$GITP_PR_HEAD` with `git show $GITP_PR_HEAD:path`, never the checkout; then bottom line, ASCII flow with the place it goes wrong, when it really happens with file:line proof, a worked example, the options in a table; fix nothing, post nothing, ask no questions, answer in Markdown.
- The `explain` prompt: same file; explain-simply shape (one bottom line, one ASCII diagram, one example with small numbers); do not judge whether the reviewer is right.
- The `followup` prompt: continue the conversation about the thread in the file; the user's message is on stdin; same rules.
- The `reply-draft` prompt: "You are @$GITP_GH_LOGIN; the pull request is by @$GITP_PR_AUTHOR. Draft the reply you post in the review thread in $GITP_THREAD_FILE, building on the conversation in it and the option on stdin when there is one. Plain, short, in the first person. Print only the reply, no heading, no explanation."
- One turn per thread at a time; a second start on the same thread fails with "A turn on this thread is already running."
- Never run `rustfmt` on `lib.rs`. `cargo` needs the sandbox off; `npm test` runs in the sandbox.

## Review Focus

1. A `followup` and a `reply-draft` are the same kind of job as a Check: the per-thread lock covers all four kinds (Task 1 tests a second start on the same thread while the first runs).
2. A turn started in one repo tab and watched from another: the job is keyed by repository path, PR and thread, never by the active repo (Task 1 takes `path` as an argument).
3. Storage that is full or blocked: `prefs.ts` load/save never throw (Task 3, as `saveReviewCommand`).
4. A thread command edited in Settings to an empty string restores the default (Task 3).
5. A mock in `vite dev` must not pretend a session: `api.ts` mocks return a conversation with `session: null` (Task 2).

---

### Task 1: The Tauri commands

**Files:**
- Modify: `crates/gitp-gui/src/gh.rs` (next to `ReviewJobs`, ~line 203, and the `#[tauri::command]` block, ~line 495)
- Modify: `crates/gitp-gui/src/lib.rs` (`.manage(gh::ThreadJobs::default())` after the `ReviewJobs` one at line 91; the four commands in the handler list after `gh_cancel_review` at line 240)
- Test: `crates/gitp-gui/src/gh.rs` `mod tests` (the file has one; if not, add one alongside the impl functions using `tempfile` as gitp-core's tests do — check `[dev-dependencies]` of gitp-gui first and add `tempfile = "3"` if missing)

**Interfaces:**
- Consumes (unit 1): `Repo::thread_claude_turn(&Gh, &ThreadInput, TurnKind, &str, &str) -> Result<ThreadConversation>`, `Repo::thread_conversation(u64, u64)`, `Repo::clear_thread_conversation(u64, u64)`, `Repo::prune_thread_conversations(u64) -> Result<usize>`, `gitp_core::{ThreadInput, ThreadConversation, TurnKind}`, `gitp_core::pr_threads::now_millis` is crate-private: use `std::time::SystemTime` in the GUI for `prune`.
- Produces:

```rust
#[derive(Default)]
pub(crate) struct ThreadJobs(Mutex<HashMap<(String, u64, u64), Arc<AtomicBool>>>);

fn gh_thread_turn_impl(jobs: &ThreadJobs, path: String, input: ThreadInput, kind: TurnKind, user_text: String, command: String) -> Result<ThreadConversation, String>;
fn gh_thread_cancel_impl(jobs: &ThreadJobs, path: &str, number: u64, thread: u64);
fn gh_thread_conversation_impl(path: String, number: u64, thread: u64) -> Result<Option<ThreadConversation>, String>;
fn gh_thread_clear_impl(path: String, number: u64, thread: u64) -> Result<(), String>;
fn gh_thread_prune_impl(path: String) -> Result<usize, String>;

#[tauri::command(async)] gh_thread_turn(path, input, kind, user_text, command, jobs: State<ThreadJobs>)
#[tauri::command]        gh_thread_cancel(path, number, thread, jobs)
#[tauri::command(async)] gh_thread_conversation(path, number, thread)
#[tauri::command(async)] gh_thread_clear(path, number, thread)
#[tauri::command(async)] gh_thread_prune(path)
```

`gh_thread_turn_impl` mirrors `gh_generate_review_impl`: open `Repo` at `path`, key `(path, input.number, input.comments[0].id)` (an empty `comments` → `Err("The thread has no comments.")` before touching the map), refuse a running key with "A turn on this thread is already running.", set `NetworkHooks { cancel, .. }`, call `thread_claude_turn(&Gh::system(), …)`, remove the key, map the error with `to_message`.

- [ ] **Step 1: Write the failing test** in the GUI `gh.rs` tests:

```rust
#[test]
fn a_thread_turn_runs_once_per_thread_and_is_keyed_by_path() {
    let dir = tempfile::tempdir().unwrap();
    // a repo with a GitHub remote and one commit, as gitp-core's tests build it
    let git = git2::Repository::init(dir.path()).unwrap();
    let sig = git2::Signature::now("T", "t@example.com").unwrap();
    let tree = git.find_tree(git.treebuilder(None).unwrap().write().unwrap()).unwrap();
    let head = git.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap().to_string();
    git.remote("origin", "git@github.com:octo/hello.git").unwrap();
    let path = dir.path().to_string_lossy().into_owned();
    let input = |n| gitp_core::ThreadInput { number: n, head: head.clone(), author: "octocat".into(),
        comments: vec![gitp_core::PrReviewComment { id: 500, author: "anna".into(), body: "?".into(), path: "a".into(),
            line: Some(1), original_line: Some(1), side: "RIGHT".into(), created_at: String::new(), in_reply_to: None,
            url: String::new(), diff_hunk: String::new() }] };
    let jobs = ThreadJobs::default();
    // Hold the key as if a turn were running.
    jobs.0.lock().unwrap().insert((path.clone(), 7, 500), Arc::new(AtomicBool::new(false)));
    let err = gh_thread_turn_impl(&jobs, path.clone(), input(7), gitp_core::TurnKind::Check, String::new(), "echo hi".into()).unwrap_err();
    assert!(err.contains("already running"), "{err}");
    // Another thread of the same PR is free.
    let c = gh_thread_turn_impl(&jobs, path.clone(), input(8), gitp_core::TurnKind::Check, String::new(), "echo hi".into()).unwrap();
    assert_eq!(c.turns[0].text.trim(), "hi");
    assert!(!jobs.0.lock().unwrap().contains_key(&(path.clone(), 8, 500)), "the key is released");
    assert_eq!(gh_thread_conversation_impl(path.clone(), 8, 500).unwrap(), Some(c));
    gh_thread_clear_impl(path.clone(), 8, 500).unwrap();
    assert_eq!(gh_thread_conversation_impl(path.clone(), 8, 500).unwrap(), None);
    assert_eq!(gh_thread_prune_impl(path.clone()).unwrap(), 0);
    let empty = gitp_core::ThreadInput { comments: vec![], ..input(9) };
    assert!(gh_thread_turn_impl(&jobs, path, empty, gitp_core::TurnKind::Check, String::new(), "echo".into()).is_err());
}
```

`gh_thread_turn_impl` calls `Gh::system()` for the login; with no `gh` on PATH that yields an empty login, which is fine.

- [ ] **Step 2: Run it to see it fail**

Run: `cargo test -p gitp-gui --lib a_thread_turn_runs_once 2>&1 | tail -5`
Expected: compile error, `ThreadJobs` / `gh_thread_turn_impl` not found.

- [ ] **Step 3: Implement** the struct, the five `_impl` functions and the five commands in the GUI `gh.rs`; register them in `lib.rs`. `ThreadInput` and `TurnKind` are `Deserialize`, so the commands take them straight from the invoke payload (`kind` arrives as `"check"` etc., matching the kebab-case serde names).

- [ ] **Step 4: Run it to see it pass**, then the GUI crate's lib tests:

Run: `cargo test -p gitp-gui --lib a_thread_turn_runs_once 2>&1 | tail -3` then `cargo test -p gitp-gui --lib 2>&1 | tail -3`
Expected: PASS; the crate's existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add crates/gitp-gui/src/gh.rs crates/gitp-gui/src/lib.rs
git commit -m "feat(gui): Tauri commands for Claude turns on a pull request thread"
```

---

### Task 2: api.ts bindings and types

**Files:**
- Modify: `crates/gitp-gui/webui/src/types.ts` (next to `PrReviewComment`)
- Modify: `crates/gitp-gui/webui/src/api.ts` (after `explainReviewFinding`, ~line 2242)
- Test: `crates/gitp-gui/webui/src/api.test.ts` exists; add one test there only if it has a pattern for mocks, else skip (the bindings are one-liners).

**Interfaces:**
- Produces (types.ts):

```ts
export type TurnKind = "check" | "explain" | "followup" | "reply-draft";
export interface ThreadTurn { kind: TurnKind; role: "user" | "claude"; at: number; head?: string; text: string }
export interface ThreadConversation { version: number; pr: number; thread: number; path: string; session?: string; turns: ThreadTurn[] }
export interface ThreadInput { number: number; head: string; author: string; comments: PrReviewComment[] }
```

- Produces (api.ts):

```ts
export async function threadTurn(path: string, input: ThreadInput, kind: TurnKind, userText: string, command: string): Promise<ThreadConversation>;
export async function cancelThreadTurn(path: string, number: number, thread: number): Promise<void>;
export async function threadConversation(path: string, number: number, thread: number): Promise<ThreadConversation | null>;
export async function clearThreadConversation(path: string, number: number, thread: number): Promise<void>;
export async function pruneThreadConversations(path: string): Promise<number>;
```

Invoke names: `gh_thread_turn` (`{ path, input, kind, userText, command }` — Tauri maps `userText` to `user_text`), `gh_thread_cancel`, `gh_thread_conversation`, `gh_thread_clear`, `gh_thread_prune`. Mocks (`!isTauri()`): `threadTurn` waits 1500 ms and returns a conversation with one Claude turn of `kind` whose text is a short fixed Markdown sample with a table, plus (for `followup`) the user turn before it, kept in a module-level `Map` so `threadConversation` returns it and `clearThreadConversation` drops it; `pruneThreadConversations` returns 0.

- [ ] **Step 1: Add the types and bindings** (no test: pure plumbing; `npm run build`'s type check is the gate).
- [ ] **Step 2: Type-check**

Run: `cd crates/gitp-gui/webui && npx tsc --noEmit 2>&1 | tail -5`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add crates/gitp-gui/webui/src/types.ts crates/gitp-gui/webui/src/api.ts
git commit -m "feat(webui): bindings for Claude turns on a pull request thread"
```

---

### Task 3: Default thread commands in prefs.ts

**Files:**
- Modify: `crates/gitp-gui/webui/src/prefs.ts` (after `EXPLAIN_FINDING_COMMAND`, ~line 683)
- Test: `crates/gitp-gui/webui/src/prefs.test.ts`

**Interfaces:**
- Produces:

```ts
export const THREAD_TOOLS: string[];
export const DEFAULT_THREAD_COMMANDS: Record<TurnKind, string>;
export function loadThreadCommand(kind: TurnKind): string;
export function saveThreadCommand(kind: TurnKind, command: string): void;  // blank or default → remove the key
```

Storage key: `gitp-thread-command-<kind>`.

- [ ] **Step 1: Write the failing tests** in `prefs.test.ts` (follow its existing review-command tests for the localStorage setup):

```ts
describe("thread commands", () => {
  it("has a read-only tool list and resumes the session when one is set", () => {
    expect(THREAD_TOOLS).toContain("Read");
    expect(THREAD_TOOLS.some((t) => t.startsWith("Edit") || t.includes("mkdir") || t.includes("rm ") || t.includes("python3"))).toBe(false);
    for (const kind of ["check", "explain", "followup", "reply-draft"] as const) {
      const c = DEFAULT_THREAD_COMMANDS[kind];
      expect(c.startsWith('claude -p "')).toBe(true);
      expect(c).toContain("--output-format json");
      expect(c).toContain('${GITP_CLAUDE_SESSION:+--resume "$GITP_CLAUDE_SESSION"}');
      expect(c).toContain("$GITP_THREAD_FILE");
      expect(c.indexOf('"/') === -1 || c.indexOf("--allowedTools") > c.indexOf("$GITP_THREAD_FILE")).toBe(true); // prompt before the tool list
    }
    expect(DEFAULT_THREAD_COMMANDS["reply-draft"]).toContain("@$GITP_GH_LOGIN");
    expect(DEFAULT_THREAD_COMMANDS.check).toContain("git show $GITP_PR_HEAD:");
  });
  it("saves a custom command per kind and blank restores the default", () => {
    expect(loadThreadCommand("check")).toBe(DEFAULT_THREAD_COMMANDS.check);
    saveThreadCommand("check", "my-check");
    expect(loadThreadCommand("check")).toBe("my-check");
    expect(loadThreadCommand("explain")).toBe(DEFAULT_THREAD_COMMANDS.explain);
    saveThreadCommand("check", "  ");
    expect(loadThreadCommand("check")).toBe(DEFAULT_THREAD_COMMANDS.check);
    saveThreadCommand("check", DEFAULT_THREAD_COMMANDS.check);
    expect(localStorage.getItem("gitp-thread-command-check")).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd crates/gitp-gui/webui && npx vitest run src/prefs.test.ts 2>&1 | tail -8`
Expected: FAIL, `THREAD_TOOLS` is not exported.

- [ ] **Step 3: Implement** in `prefs.ts`. `THREAD_TOOLS` = `SKILL_TOOLS` minus the `Edit(...)`, `Bash(mkdir …)`, `Bash(rm …)`, `Bash(curl …)`, `Bash(python3 *)` and `ArtifactData` entries, plus `ToolSearch`; build it by filtering `SKILL_TOOLS` with a predicate so the two lists cannot drift. A `threadCommand(prompt: string)` helper builds each line from the Global Constraints template.

- [ ] **Step 4: Run them to see them pass**, then the whole frontend suite:

Run: `npx vitest run src/prefs.test.ts 2>&1 | tail -3` then `npm test 2>&1 | tail -4`
Expected: PASS; suite green.

- [ ] **Step 5: Commit**

```bash
git add crates/gitp-gui/webui/src/prefs.ts crates/gitp-gui/webui/src/prefs.test.ts
git commit -m "feat(webui): default Claude commands for a pull request thread"
```

---

### Task 4: The pr-threads.ts state module

**Files:**
- Create: `crates/gitp-gui/webui/src/pr-threads.ts`
- Test: `crates/gitp-gui/webui/src/pr-threads.test.ts`

**Interfaces:**
- Consumes: `ThreadConversation`, `TurnKind` from types.ts; nothing from api.ts (the module is pure state; the view calls the api and feeds results in, as `pr-actions.ts` does for reviews).
- Produces:

```ts
export interface ThreadState { running: TurnKind | null; error: string | null; conversation: ThreadConversation | null; loaded: boolean }
export function threadState(repo: string, number: number, thread: number): ThreadState;   // made empty on first ask
export function setConversation(repo: string, number: number, thread: number, c: ThreadConversation | null): void; // sets loaded = true, error = null
export function startTurn(repo: string, number: number, thread: number, kind: TurnKind): boolean; // false when one runs
export function finishTurn(repo: string, number: number, thread: number, result: ThreadConversation | { error: string }): void;
export function runningTurns(repo: string, number: number): number;   // for the sidebar badge
export function onThreadsChange(listener: () => void): void;
export function threadsChanged(): void;
```

Key: `${repo}\n${number}\n${thread}`. `startTurn` and `finishTurn` call `threadsChanged()`.

- [ ] **Step 1: Write the failing tests**:

```ts
import { finishTurn, onThreadsChange, runningTurns, setConversation, startTurn, threadState } from "./pr-threads";

const conv = (turns = 1) => ({ version: 1, pr: 7, thread: 500, path: "a", turns: Array.from({ length: turns }, () => ({ kind: "check" as const, role: "claude" as const, at: 1, text: "x" })) });

it("starts one turn per thread and keeps the result", () => {
  let changes = 0;
  onThreadsChange(() => changes++);
  const s = threadState("/r", 7, 500);
  expect(s).toEqual({ running: null, error: null, conversation: null, loaded: false });
  expect(startTurn("/r", 7, 500, "check")).toBe(true);
  expect(startTurn("/r", 7, 500, "explain")).toBe(false);
  expect(startTurn("/r", 7, 501, "check")).toBe(true);
  expect(runningTurns("/r", 7)).toBe(2);
  expect(runningTurns("/r", 8)).toBe(0);
  finishTurn("/r", 7, 500, conv());
  expect(threadState("/r", 7, 500)).toEqual({ running: null, error: null, conversation: conv(), loaded: true });
  finishTurn("/r", 7, 501, { error: "boom" });
  expect(threadState("/r", 7, 501).error).toBe("boom");
  expect(threadState("/r", 7, 501).running).toBeNull();
  expect(runningTurns("/r", 7)).toBe(0);
  expect(changes).toBe(5);
});

it("a loaded conversation replaces an error and nothing", () => {
  finishTurn("/r", 9, 1, { error: "old" });
  setConversation("/r", 9, 1, conv(2));
  expect(threadState("/r", 9, 1)).toEqual({ running: null, error: null, conversation: conv(2), loaded: true });
  setConversation("/r", 9, 1, null);
  expect(threadState("/r", 9, 1).conversation).toBeNull();
  expect(threadState("/r", 9, 1).loaded).toBe(true);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/pr-threads.test.ts 2>&1 | tail -5`
Expected: FAIL, cannot resolve `./pr-threads`.

- [ ] **Step 3: Implement `pr-threads.ts`** as the Interfaces block says, with a module comment in the style of `pr-reviews.ts`.

- [ ] **Step 4: Run them to see them pass**, then the suite:

Run: `npx vitest run src/pr-threads.test.ts 2>&1 | tail -3` then `npm test 2>&1 | tail -4`
Expected: PASS; suite green.

- [ ] **Step 5: Commit**

```bash
git add crates/gitp-gui/webui/src/pr-threads.ts crates/gitp-gui/webui/src/pr-threads.test.ts
git commit -m "feat(webui): per-thread state of Claude conversations"
```
