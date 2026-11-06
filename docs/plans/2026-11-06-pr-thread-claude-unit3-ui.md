# PR thread Claude, unit 3: the thread UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Check, Explain simply and Reply with Claude on every line-comment thread of the pull request view, with the conversation block under the thread, follow-ups, Clear, and pruning on open.

**Architecture:** The thread's turn logic lives in `pr-actions.ts` as `runThreadTurn` (like `runReview`): it wires `pr-threads.ts` state, `api.ts` and the prefs commands, and survives tab switches. `views/pull-request.ts` gets four new callbacks and renders from the state: `threadNode` gains the buttons and a `conversationNode`. `main.ts` redraws on `onThreadsChange` as it does for reviews, and the sidebar badge counts running turns. Markdown comes through `renderGitHubMarkdown` (no innerHTML, as the file's header rule says).

**Tech Stack:** TypeScript, vanilla DOM via `el`, vitest for the pure helpers.

**Spec:** `docs/specs/2026-11-06-pr-thread-claude-design.md` (sections "The thread", "The conversation under the thread", "Reply with Claude", "Storage" pruning).

## Global Constraints

- Nothing posts to GitHub from Check, Explain or Reply with Claude. Reply with Claude only fills the Reply box.
- The three buttons are hidden on a resolved thread; while a turn runs the button that started it shows "…" and the other two are disabled; Clear is disabled while a turn runs (the reviewer of unit 1 flagged the race).
- A saved conversation is drawn collapsed to one line, "Claude · N turns · <kind> <relative time> ▸", and opens on click; a turn that just finished draws it open.
- Claude turns are labelled by kind: "Check", "Explain", "Follow-up", "Reply draft"; user turns "you".
- When a Claude turn's `head` differs from `pr.head_oid`, the block shows a `pr-badge` "older commit" with the label's title "Checked against <short sha>; the pull request has moved on".
- Markdown of a turn renders through `renderGitHubMarkdown`.
- The follow-up composer sends on Cmd/Ctrl+Enter (`submitOnCmdEnter`).
- Reply with Claude: with a non-empty Reply box, confirm before replacing (the app's confirm dialog, see `confirmDialog` in pr-actions / dialogs). The draft becomes a `reply-draft` turn in the conversation (core does that) and is shown there too.
- `pruneThreadConversations` runs once per pull request view open (in `show`), errors reported through `reportError` only when the preview is not mock.
- Reply with Claude's stdin: the text of the last user turn of the conversation, or "".

## Review Focus

1. A resolved thread shows no Claude buttons and no conversation block (Task 2 test: `threadClaudeActions(resolved=true)` returns nothing).
2. The Files tab draws threads with `withCode=false`; the block must render there too and not break the diff line layout (Task 2 uses the same `threadNode`).
3. A turn finishing after the user switched to another pull request must not draw into the wrong view: `finishTurn` keys by repo, number and thread; the view redraws from the state of its own number (Task 1).
4. An error from a turn is shown under the thread, not only in a toast, with a "Try again" that reruns the same kind (Task 2).
5. A thread whose root comment is outdated (`line === null`) still gets the buttons (Task 2 test with `line: null`).

---

### Task 1: Thread turns in pr-actions.ts

**Files:**
- Modify: `crates/gitp-gui/webui/src/pr-actions.ts` (next to `runReview`, ~line 525; the callbacks object, ~line 504)
- Modify: `crates/gitp-gui/webui/src/views/pull-request.ts` (`PullRequestCallbacks` only, in this task)
- Modify: `crates/gitp-gui/webui/src/main.ts` (`onThreadsChange`, ~line 542; the sidebar badge)
- Modify: `crates/gitp-gui/webui/src/pr-reviews.ts` `reviewBadge` → also "thinking…" when `runningTurns(repo, number) > 0` and no review runs (import from pr-threads)
- Test: `crates/gitp-gui/webui/src/pr-reviews.test.ts` (exists? if yes add a case; else `pr-threads.test.ts` gets a `lastUserText` test)

**Interfaces:**
- Consumes: `threadTurn`, `cancelThreadTurn`, `threadConversation`, `clearThreadConversation`, `pruneThreadConversations` (api.ts); `startTurn`, `finishTurn`, `setConversation`, `threadState`, `runningTurns`, `onThreadsChange` (pr-threads.ts); `loadThreadCommand` (prefs.ts); `setStatus`, `toast`, `isCancelled`, `showErrorDialog` as `runReview` uses them.
- Produces, in `PullRequestCallbacks`:

```ts
// Runs a Claude turn on the thread in the background; the view redraws from pr-threads state.
threadTurn: (pr: PullRequestDetail, thread: Thread, kind: TurnKind, userText: string) => void;
cancelThreadTurn: (pr: PullRequestDetail, thread: Thread) => void;
// Loads the saved conversation into the state once (no-op when `loaded`).
loadThreadConversation: (pr: PullRequestDetail, thread: Thread) => void;
clearThreadConversation: (pr: PullRequestDetail, thread: Thread) => Promise<void>;  // after the user confirms
pruneThreadConversations: () => void;
```

- Produces, in pr-threads.ts: `export function lastUserText(c: ThreadConversation | null): string` (the last `role === "user"` turn's text, else "").

`runThreadTurn(repo, pr, thread, kind, userText)`: `if (!startTurn(repo, pr.number, thread.root.id, kind)) return;` build `ThreadInput { number: pr.number, head: pr.head_oid, author: pr.author, comments: [thread.root, ...thread.replies] }`; `const text = kind === "reply-draft" ? lastUserText(threadState(...).conversation) : userText`; `await threadTurn(repo, input, kind, text, loadThreadCommand(kind))` → `finishTurn(..., conversation)`; on error `finishTurn(..., { error: isCancelled(err) ? "Cancelled." : String(err) })` and a toast as `runReview` does (no toast on cancel). `setStatus` lines: "Checking the thread on src/x.ts:12 of #7 in the background…" and "Claude answered on #7 src/x.ts:12.".

- [ ] **Step 1: Write the failing test** for `lastUserText` in `pr-threads.test.ts`:

```ts
it("the last user turn is what a reply draft builds on", () => {
  expect(lastUserText(null)).toBe("");
  const c = conv(1);
  c.turns.push({ kind: "followup", role: "user", at: 2, text: "restore >" }, { kind: "followup", role: "claude", at: 3, text: "ok" });
  expect(lastUserText(c)).toBe("restore >");
  expect(lastUserText(conv(1))).toBe("");
});
```

- [ ] **Step 2: Run it to see it fail** — `npx vitest run src/pr-threads.test.ts` → FAIL, `lastUserText` is not exported.
- [ ] **Step 3: Implement** `lastUserText`, `runThreadTurn`, the five callbacks, `onThreadsChange(() => { renderSidebarNow(); ui.prView?.redraw(); })` in main.ts, and the badge case in `reviewBadge` (`{ text: "thinking…", kind: "running" }` when turns run and no review runs).
- [ ] **Step 4: Run** `npx vitest run src/pr-threads.test.ts` → PASS; `npx tsc --noEmit` → clean (the view's callbacks type now requires the five, so `pr-actions.ts` must provide them, and `sidebar-render.test.ts` or other callers of `PullRequestCallbacks` may need the new fields: give test doubles `vi.fn()`s).
- [ ] **Step 5: Commit** `git add -A crates/gitp-gui/webui/src && git commit -m "feat(webui): run Claude turns on a pull request thread in the background"`

---

### Task 2: The thread's buttons and conversation block

**Files:**
- Create: `crates/gitp-gui/webui/src/views/thread-claude.ts` — the pure helpers and the block renderer, so `pull-request.ts` stays readable
- Modify: `crates/gitp-gui/webui/src/views/pull-request.ts` (`threadNode`, ~line 324; `show`, for the prune)
- Modify: `crates/gitp-gui/webui/src/styles.css` (after `.pr-thread-actions`, ~line 5509)
- Test: `crates/gitp-gui/webui/src/views/thread-claude.test.ts`

**Interfaces:**
- Produces (thread-claude.ts):

```ts
export type ClaudeAction = "check" | "explain" | "reply-draft";
export interface ClaudeButton { action: ClaudeAction; label: string; disabled: boolean; running: boolean }
// The buttons a thread shows: none when resolved; the running one marked, the others disabled while one runs.
export function threadClaudeButtons(resolved: boolean, running: TurnKind | null): ClaudeButton[];
export const TURN_LABELS: Record<TurnKind, string>; // Check / Explain / Follow-up / Reply draft
// The collapsed line: "Claude · 3 turns · Check 2 days ago"
export function conversationSummary(c: ThreadConversation, nowSecs: number): string;
// Draws the block: turns, "older commit" badges, the follow-up composer, Clear, the error with Try again.
export function conversationNode(opts: {
  state: ThreadState; head: string; open: boolean;
  onFollowup: (text: string) => void; onClear: () => void; onRetry: (kind: TurnKind) => void; onCancel: () => void;
  onToggle: () => void;
}): HTMLElement;
```

Labels: "Check", "Explain simply", "Reply with Claude"; a running button's label gets "…" appended (`running: true`).

In `pull-request.ts` `threadNode`: after the comment cards and before the actions row, when `!resolved`: `cb.loadThreadConversation(pr, thread)` (idempotent), then `const ts = threadState(cb.repoPath(), pr.number, root.id)`; if `ts.conversation || ts.running || ts.error` append `conversationNode(...)`. In the actions row, after Reply…, the `threadClaudeButtons(...)` as `smallButton`s: `check`/`explain` → `cb.threadTurn(pr, thread, action, "")`; `reply-draft` → `cb.threadTurn(pr, thread, "reply-draft", "")` and, once the state's conversation gains a `reply-draft` turn newer than the click, the Reply box is opened (if closed) and filled with that turn's text, after the confirm when it had text. Simplest wiring: keep a `pendingReplyDraft: Set<string>` of thread keys in the view; `redraw` checks each key's conversation's last turn, and when it is a `reply-draft` Claude turn, opens the box with it and removes the key. Open-state of blocks: `const openBlocks = new Set<number>()` of thread ids in the view, toggled by `onToggle`; a finished turn adds its thread id (in `redraw`, when `running` went from set to null — track `lastRunning: Map<number, TurnKind | null>`).

Prune: in `show(number)`, once per view instance per repo, `cb.pruneThreadConversations()`.

- [ ] **Step 1: Write the failing tests** (`thread-claude.test.ts`):

```ts
it("a resolved thread has no Claude buttons", () => expect(threadClaudeButtons(true, null)).toEqual([]));
it("three buttons, the running one marked and the others disabled", () => {
  const idle = threadClaudeButtons(false, null);
  expect(idle.map((b) => [b.action, b.label, b.disabled])).toEqual([["check", "Check", false], ["explain", "Explain simply", false], ["reply-draft", "Reply with Claude", false]]);
  const busy = threadClaudeButtons(false, "explain");
  expect(busy.map((b) => [b.running, b.disabled, b.label])).toEqual([[false, true, "Check"], [true, true, "Explain simply…"], [false, true, "Reply with Claude"]]);
  expect(threadClaudeButtons(false, "followup").every((b) => b.disabled)).toBe(true);
});
it("summarises a conversation by its last Claude turn", () => {
  const c = { version: 1, pr: 7, thread: 1, path: "a", turns: [
    { kind: "check" as const, role: "claude" as const, at: 1_000_000, text: "x" },
    { kind: "followup" as const, role: "user" as const, at: 2_000_000, text: "y" },
    { kind: "followup" as const, role: "claude" as const, at: 3_000_000, text: "z" } ] };
  expect(conversationSummary(c, 3_000 + 90)).toBe("Claude · 3 turns · Follow-up 1 minute ago");
  expect(conversationSummary({ ...c, turns: c.turns.slice(0, 1) }, 1_000 + 5)).toBe("Claude · 1 turn · Check just now");
});
it("the block marks turns made against an older commit and offers Try again on an error", () => {
  const node = conversationNode({ state: { running: null, error: "boom", loaded: true, conversation: { version: 1, pr: 7, thread: 1, path: "a", turns: [{ kind: "check", role: "claude", at: 1, head: "aaaa", text: "**x**" }] } }, head: "bbbb", open: true,
    onFollowup() {}, onClear() {}, onRetry() {}, onCancel() {}, onToggle() {} });
  expect(node.querySelector(".pr-badge")?.textContent).toBe("older commit");
  expect(node.querySelector(".pr-thread-claude-error")?.textContent).toContain("boom");
  expect([...node.querySelectorAll("button")].map((b) => b.textContent)).toContain("Try again");
  expect(node.querySelector(".github-markdown strong")?.textContent).toBe("x");
});
```

Check how other view tests build DOM (`grep -l "document" src/views/*.test.ts`; vitest may need `// @vitest-environment jsdom` at the top of the file, as the existing ones do or don't — follow them; if none renders DOM, add `jsdom` only if it is already a devDependency, else keep the DOM test to `textContent` checks under `happy-dom`/`jsdom` present in package.json; if neither is installed, drop the fourth test's DOM assertions and test only the pure helpers — say so in the ledger).

- [ ] **Step 2: Run them to see them fail** — `npx vitest run src/views/thread-claude.test.ts` → FAIL, module missing.
- [ ] **Step 3: Implement** `thread-claude.ts`, the `threadNode` changes, the prune in `show`, and the CSS: `.pr-thread-claude` (a left border in the accent colour, margin like `.pr-thread-hunk`), `.pr-thread-claude-head` (the collapsed line, cursor pointer), `.pr-thread-claude-turn` with `.user`/`.claude`, `.pr-thread-claude-error`, the follow-up composer reusing `.pr-composer`.
- [ ] **Step 4: Run** the file's tests → PASS; `npm test` → green; `npx tsc --noEmit` → clean.
- [ ] **Step 5: Verify in the browser**: `npx vite --port 5174` unsandboxed from the worktree's webui (see memory: launch.json is protected), open the preview, open the mock repo's pull request, open a thread, click Check, see the spinner then the block with the mock table; click Reply with Claude and see the Reply box filled; type a follow-up; Clear. Screenshot for the user. Fix what is wrong, re-run tests.
- [ ] **Step 6: Commit** `git add -A crates/gitp-gui/webui/src && git commit -m "feat(webui): Check, Explain simply and Reply with Claude on a pull request thread"`
