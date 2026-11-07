# Review Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One main-panel list of the pull requests that need Phuong, across every Open Recent and starred repo, filled per repo as each answers, refreshed every 60 s.

**Architecture:** gitp-core reads each repo's GitHub (two `gh pr list` + one aliased GraphQL call) and the local thread conversation files; gitp-gui runs one thread per unique GitHub repo and streams each result as an `inbox-repo` event; the webui groups and sorts (pure `inbox.ts`), draws an overlay view (`views/inbox.ts`) driven by the shared `poller.ts`.

**Tech Stack:** Rust (gitp-core, Tauri v2), TypeScript + Vite, vitest + happy-dom.

**Spec:** docs/specs/2026-11-07-review-inbox-design.md

## Global Constraints

- Groups: **Needs you** = review requested from you; your PRs with unresolved threads; your PRs with a failed check; your PRs approved and mergeable. **Waiting on others** = your other open PRs. Drafts and closed PRs left out.
- Mergeable = `mergeStateStatus == CLEAN`; UNKNOWN does not count.
- "prepared" = unresolved threads with a prepared reply or a fix commit recorded in the conversation.
- Team review requests: a second `gh pr list --search "review-requested:@me"` per repo.
- Repos = Open Recent + starred, merged by `owner/name`; the first path in the list (recent first) wins and is what a click opens.
- Sort in a group: failed check, then review requested, then unresolved (most first), then last activity (newest first).
- Refresh every 60 s while visible via `poller.ts`: `startPolling(key: string, intervalMs: number, tick: () => Promise<void> | void): () => void` and `pausePollingFor(ms: number): void`.
- Unreadable repos at the bottom with the reason ("not signed in", "no GitHub remote", the gh error).
- No innerHTML; `el()` from dom.ts. Shared files: small, local edits only.

## Review Focus

- A repo listed twice (clone + worktree of the same GitHub repo): one set of rows, the recent-list path. → core `sources_merge_paths_by_github_repo`.
- gh signed out: every repo shows "not signed in", no crash. → core `a_signed_out_gh_is_named_as_such`.
- A slow repo: the others' rows show first. → DOM `rows_appear_per_repo_as_each_answers`.
- A refresh that is still running when the next tick fires, or the view closed meanwhile: no duplicate rows, no stale overwrite. → poller `a_tick_does_not_overlap_the_previous`, DOM `an_older_refresh_does_not_overwrite_a_newer`.
- GraphQL fails but the lists succeed: rows still shown, counts unknown. → core `a_failed_thread_query_leaves_the_counts_unknown`.

---

### Task 1: core — `gh/inbox.rs` (child module of gh.rs)

**Files:** Create `crates/gitp-core/src/gh/inbox.rs`; modify `gh.rs` (`mod inbox; pub use inbox::*;`), `lib.rs` (one `pub use gh::{...}` line).

**Produces:**
- `#[derive(Serialize)] pub struct InboxPr { repo: String, path: String, number: u64, title: String, author: String, url: String, updated_at: String, checks: Option<String>, review_decision: Option<String>, merge_state: String, mine: bool, review_requested: bool, unresolved: Option<u32>, prepared: u32 }`
- `#[derive(Serialize)] pub struct InboxRepo { path: String, repo: Option<String>, prs: Vec<InboxPr>, error: Option<String> }`
- `impl Repo { pub fn inbox_pull_requests(&self, gh: &Gh) -> Result<Vec<InboxPr>> }`
- `pub fn inbox_sources(paths: &[String]) -> (Vec<(String, String)>, Vec<InboxRepo>)` — unique (path, owner/name) in input order, and error rows.
- `pub fn inbox_repo(gh: &Gh, path: &str) -> InboxRepo`

Fields asked of gh pr list: `number,title,author,isDraft,reviewDecision,statusCheckRollup,updatedAt,mergeStateStatus,url`, `--state open --limit 100`, once with `--author @me`, once with `--search review-requested:@me`. GraphQL: one `repository { p<N>: pullRequest(number: N) { number reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { databaseId } } } } } }` per listed PR. Error reasons: NOT_SIGNED_IN → "not signed in", NO_GITHUB_REMOTE → "no GitHub remote", NOT_INSTALLED → "gh is not installed", else the message.

Tests (fake gh script dispatching on `review-requested:@me` / `graphql`):
- [ ] `inbox_lists_mine_and_review_requested_without_drafts` — 3 gh calls; flags, merge_state, unresolved; draft gone; `--author @me` / `--search review-requested:@me`; fields include mergeStateStatus.
- [ ] `prepared_counts_unresolved_threads_with_a_ready_reply_or_a_fix_commit` — 4 conversations (ready reply, fix commit, resolved+ready, posted reply) → prepared 2.
- [ ] `a_failed_thread_query_leaves_the_counts_unknown` — unresolved None, prepared 0, Ok.
- [ ] `sources_merge_paths_by_github_repo_first_path_wins` — plus "no GitHub remote" and a non-repo path as error rows.
- [ ] `a_signed_out_gh_is_named_as_such` — error "not signed in".
- [ ] Run `cargo test -p gitp-core inbox`; RED then GREEN; commit.

### Task 2: GUI command — `crates/gitp-gui/src/inbox.rs`

**Produces:** `#[tauri::command] async fn inbox(paths: Vec<String>, id: u32, app: AppHandle) -> Result<(), String>`; `fn inbox_impl(gh: &Gh, paths: &[String], emit: impl Fn(InboxRepo) + Send + Sync)` — error rows emitted at once, one scoped thread per source; event `inbox-repo` payload `{ id, result: InboxRepo }`. Registered in lib.rs (`mod inbox;`, `inbox::inbox,`).

- [ ] `inbox_emits_one_result_per_unique_repo` — two paths to one GitHub repo + one gitlab repo, gh not installed → 2 results, both with errors; returns after all.
- [ ] `cargo test -p gitp-gui inbox`; commit.

### Task 3: webui pure — `poller.ts`, `inbox.ts`, `inbox-api.ts`, types

**Produces:**
- `poller.ts`: `startPolling`, `pausePollingFor` (exact API above). No tick on start; ticks every interval; none while a tick is pending; paused while blurred or hidden, immediate tick on focus/visible; same key replaces.
- `inbox.ts`: `type InboxPr`, `type InboxRepo` (mirror Rust); `needsYou(pr): boolean`; `inboxReasons(pr): string[]`; `sortInbox(prs): InboxPr[]`; `groupInbox(prs): { needs: InboxPr[]; waiting: InboxPr[] }`; `inboxPaths(recent: string[], starred: string[]): string[]`.
- `inbox-api.ts`: `loadInbox(paths: string[], onRepo: (r: InboxRepo) => void): Promise<void>` (Tauri: listen `inbox-repo` by id, invoke `inbox`; preview: mock repos with delays).

Tests: `poller.test.ts` (interval, blur/hidden pause, refocus tick, replace by key, stop, pausePollingFor, no overlap); `inbox.test.ts` (each needs-you reason; approved but BEHIND/UNKNOWN waits; sort order; paths dedupe recent-first). RED/GREEN; commit.

### Task 4: webui view and wiring

**Files:** Create `views/inbox.ts`, `views/inbox.test.ts`, `inbox-actions.ts`. Modify (one-liners): `index.html` (`#inbox-view` section), `main.ts` (setup), `shell.ts` showView hides it, `views/welcome.ts` (+`inbox` callback button), `views/pr-list.ts` (optional `inbox` callback button), `quick-launch-commands.ts` ("Open Review Inbox" in both lists), `styles.css` (inbox block), README Tools row.

**Produces:** `setupInbox(host, cb: InboxCallbacks): InboxHandle` with `InboxCallbacks { paths(): string[]; load(paths, onRepo): Promise<void>; open(path: string, number: number): void; close(): void; now?(): number }`, `InboxHandle { show(): void; hide(): void; isShowing(): boolean }`; `openReviewInbox(): void` in inbox-actions.ts; click → close, `openRecentRepo(path)` when not active, then `showPullRequest(number)`.

Tests (DOM):
- [ ] `rows_appear_per_repo_as_each_answers`; `groups_needs_you_first_then_waiting`; `a_row_shows_repo_number_title_author_dot_counts_and_age`; `unreadable_repos_are_listed_at_the_bottom_with_the_reason`; `a_click_opens_that_repo_on_that_pr`; `an_older_refresh_does_not_overwrite_a_newer`; `hide_stops_the_polling`.
- [ ] `npx vitest run`, `npx tsc --noEmit`; commit.
