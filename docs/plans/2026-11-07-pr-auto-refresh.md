# Pull request view refreshing on its own Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The PR view and the sidebar's PR list refresh themselves from GitHub while the window is focused.

**Architecture:** Core asks GitHub for a cheap signature of a pull request in one GraphQL call; the GUI exposes it; a shared `poller.ts` runs focus-aware timers; the PR view compares signatures and reloads/redraws (keeping typed text, scroll, open line composers) with a 10 s notice; `pr-actions.ts` polls the list.

**Tech Stack:** Rust (gitp-core, Tauri v2 command), TypeScript + vitest/happy-dom.

**Spec:** docs/specs/2026-11-07-pr-auto-refresh-design.md (incl. "Decisions after the builder check").

## Global Constraints

- PR view polls every 30 s; list every 60 s, whenever a signed-in GitHub repo is open (from `pr-actions.ts`).
- Polling pauses while the window is unfocused or the document hidden; immediate poll on refocus.
- A poll that finds nothing must not redraw, flash or move the scroll.
- A rate-limit failure pauses all polling for 10 minutes and shows "GitHub rate limit, polling paused".
- Notice: `el("div", {class: "pr-refresh-notice"})`, text "Updated: …" joined by " · ", removed after 10 s or on click; only `updatedAt` moved → "Updated".
- The user's own actions (view `load`) refresh the stored signature quietly: no notice.
- Redraw from a poll is deferred while a text box in the view has focus; runs when it loses focus.
- Shared files: small, localized edits. No innerHTML.
- `poller.ts` API exactly: `startPolling(key: string, intervalMs: number, tick: () => Promise<void> | void): () => void`, `pausePollingFor(ms: number): void`.

## Review Focus

- Signature check order differs between polls (GitHub reorders contexts) → no refresh: checks are sorted by name in core.
- PR with no checks (`statusCheckRollup: null`) or no commits → signature still parses.
- A tick still in flight when the next fires → no overlapping calls (poller skips).
- A stale stop function from a replaced `startPolling` must not stop the replacement.
- A line composer whose line left the diff after a push keeps its text in an orphan box with Discard.

---

### Task 1: Core signature

**Files:** Create `crates/gitp-core/src/gh/signature.rs` (child module of gh.rs, uses its private helpers); Modify `crates/gitp-core/src/gh.rs` (`mod signature; pub use signature::PrSignature;`), `crates/gitp-core/src/lib.rs` (re-export).

**Interfaces — Produces:** `Repo::pull_request_signature(&self, gh: &Gh, number: u64) -> Result<PrSignature>`; `PrSignature { head: String, updated_at: String, threads: Vec<(String, bool)>, checks: Vec<(String, String)> }` (Serialize; checks sorted by name, state as `RawCheck::state`).

One `gh api graphql` call: `pullRequest(number) { headRefOid updatedAt reviewThreads(first:100){nodes{id isResolved}} commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}} }`.

- [ ] Tests (RED then GREEN): `signature_is_one_graphql_call_and_reads_head_threads_and_checks`, `signature_without_checks_or_commits_has_none`, `signature_rate_limit_says_rate_limit`.
- [ ] `cargo test -p gitp-core signature` green; commit.

### Task 2: GUI command + api wrapper

**Files:** Modify `crates/gitp-gui/src/gh.rs` (`gh_pull_request_signature(number) -> Result<PrSignature, String>`), `crates/gitp-gui/src/lib.rs` (register, one line), `webui/src/types.ts` (`PrSignature`), `webui/src/api.ts` (`fetchPullRequestSignature(number): Promise<PrSignature>`; mock derives from the mock detail).

- [ ] `cargo build -p gitp-gui` + `npx tsc --noEmit` green; commit (folded with Task 3 if convenient).

### Task 3: poller.ts

**Files:** Create `webui/src/poller.ts`, `webui/src/poller.test.ts`.

- [ ] Tests (fake timers, happy-dom): `ticks every interval while focused`, `pauses while the window is blurred and polls at once on focus`, `pauses while the document is hidden`, `a new start with the same key replaces the old`, `a stale stop does not stop the replacement`, `does not start a tick while the last is still running`, `pausePollingFor skips ticks of every key until it ends`.
- [ ] Commit.

### Task 4: pr-refresh.ts (pure + notice)

**Files:** Create `webui/src/pr-refresh.ts`, `webui/src/pr-refresh.test.ts`.

**Produces:** `signatureChanged(a: PrSignature | null, b: PrSignature): boolean`; `refreshNotice(old: PullRequestDetail, now: PullRequestDetail): string`; `isRateLimit(err: unknown): boolean`; `RATE_LIMIT_NOTICE = "GitHub rate limit, polling paused"`; `PR_VIEW_POLL_MS = 30_000`, `PR_LIST_POLL_MS = 60_000`, `RATE_LIMIT_PAUSE_MS = 600_000`.

- [ ] Tests: `same signature is no change`, `null baseline is no change`, `head/updatedAt/thread/check change is a change`, `notice counts new commits, comments (issue + line + review bodies), resolved threads, checks finished`, `only updatedAt moved says Updated`, `isRateLimit matches the core message`.
- [ ] Commit.

### Task 5: PR view polls and redraws

**Files:** Modify `webui/src/views/pull-request.ts` (optional `fetchSignature` callback; start/stop polling in show/reset; tick; deferred redraw; notice; line composers kept by `lineKey`, orphan box with Discard); `webui/src/pr-actions.ts` (`fetchSignature: fetchPullRequestSignature`); `styles.css` (notice + orphan box). Test: `webui/src/views/pull-request.test.ts`.

- [ ] Tests: `a poll with no change does not redraw`, `a changed poll redraws keeping the Reply box text and scroll, and shows the notice`, `the notice goes after 10 seconds or on click`, `a redraw waits while a text box has focus`, `an open line composer survives a redraw`, `a composer whose line left the diff shows in the orphan box with Discard`, `the user's own reload sets the signature quietly`, `a rate-limit failure pauses polling and says so`.
- [ ] Commit.

### Task 6: List polling

**Files:** Modify `webui/src/pr-actions.ts` (`startPolling("pr-list", 60000, pollPullRequestList)` after a signed-in load, stop otherwise; tick re-lists quietly, re-renders only when the list changed; rate limit → `pausePollingFor`).

- [ ] Logic covered by a small pure helper test in `pr-refresh.test.ts`: `listChanged(a, b)`.
- [ ] Commit; README line on auto-refresh.
