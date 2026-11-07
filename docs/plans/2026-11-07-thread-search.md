# Thread conversation search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Search the stored Claude thread conversations of the current repo by words, PR and month, and open a hit on its thread.

**Architecture:** Each turn now also stores the PR title, the line and the thread's comments in the conversation file. Core scans `<common dir>/gitp/pr-threads/*/*.json` per search and returns at most 200 hits plus the total. A main-panel view (`views/thread-search.ts`) with pure helpers (`thread-search.ts`) debounces the box and opens a hit in the PR view, whose resolved threads now show the stored block read-only.

**Tech Stack:** Rust (gitp-core, serde), Tauri v2 command (gitp-gui), TypeScript + vitest/happy-dom.

**Spec:** docs/specs/2026-11-07-thread-search-design.md (binding: "Decisions after the builder check").

## Global Constraints

- Older conversation files load: every new field has a serde default; `thread` stays a number.
- Core returns the first 200 after sorting by last-turn time descending, plus the total; the view says "Showing 200 of N, narrow the search".
- The box debounces 200 ms. Month filter = millisecond `[from, to)` computed in the frontend in local time.
- `#123` / `pr:123` in the query is the exact PR filter; any other number is a plain token.
- Snippet: 80 chars either side of the first token's first match in the first field it matches; the match bold in the view. Dropped drafts searched, marked "dropped".
- No innerHTML; DOM via `el()`. Shared files (pull-request.ts, api.ts, prefs.ts, lib.rs, gh.rs, quick-launch-commands.ts, styles.css, README.md) get small, localized edits.

## Review Focus

1. Accented / multi-byte text around a match: the snippet must cut on char boundaries, never panic (core test `a_snippet_cuts_on_characters_not_bytes`).
2. A query that is only `#123`: lists every conversation of #123 (frontend `parseThreadQuery` test + core `an_empty_query_with_a_pr_lists_only_that_pr`).
3. Slow searches answered out of order while typing: an older answer must not replace a newer one (view test `a_late_answer_for_an_older_query_is_dropped`).
4. Regex characters in the query (`retry(`, `a.b`): highlighting is literal (helper test).
5. Files written before this change (no title/line/comments): still load, match on turns, show the number only (core tests).

---

### Task 1: Core — store title, line, comments; search

**Files:**
- Modify: `crates/gitp-core/src/pr_threads.rs` (fields, `ThreadComment`, search, tests)
- Modify: `crates/gitp-core/src/gh.rs` (`ThreadInput.title`, run_turn fills fields, literals, test)
- Modify: `crates/gitp-core/src/lib.rs` (re-exports)

**Interfaces — Produces:**
- `pub struct ThreadComment { pub author: String, pub body: String }`
- `ThreadConversation` + `title: Option<String>`, `line: Option<u32>` (`#[serde(default, skip_serializing_if = "Option::is_none")]`), `comments: Vec<ThreadComment>` (`#[serde(default, skip_serializing_if = "Vec::is_empty")]`)
- `ThreadInput` + `#[serde(default)] pub title: Option<String>`
- `pub const THREAD_SEARCH_LIMIT: usize = 200;`
- `#[serde(rename_all = "lowercase")] pub enum ReplyState { Ready, Posted }`
- `pub struct ThreadHit { pr: u64, thread: u64, path: String, line: Option<u32>, title: Option<String>, snippet: String, dropped: bool, at: u64, fixed: bool, reply_state: Option<ReplyState> }` (Serialize)
- `pub struct ThreadSearch { hits: Vec<ThreadHit>, total: usize }` (Serialize)
- `Repo::search_thread_conversations(&self, query: &str, range: Option<(u64, u64)>, pr: Option<u64>) -> Result<ThreadSearch>`

Rulings: fields searched = comment bodies, turn texts (all, dropped included), title, path, PR number; field order for the snippet is that order. Matching is per-char lowercase (index-aligned). Empty query snippet = start of the root comment, else of the last turn. Snippet whitespace collapsed to single spaces, `…` at cut ends. A conversation with no turns is skipped. `fixed` = a fix turn with a commit; `reply_state` mirrors the frontend's `threadBadges`.

- [ ] Tests (RED): `run_turn` test `a_turn_stores_the_title_line_and_comments` (title "Retry fix", line 12, comments anna/"stops early?","yes?"); in pr_threads: `an_old_file_without_title_line_comments_loads`, `every_token_must_match_somewhere_case_insensitively`, `the_pr_number_and_path_match_as_words`, `range_and_pr_filters`, `an_empty_query_with_a_pr_lists_only_that_pr`, `hits_are_newest_first_and_capped_with_the_total`, `the_snippet_is_80_chars_either_side_of_the_first_match`, `a_snippet_cuts_on_characters_not_bytes`, `a_match_in_a_dropped_draft_is_marked`, `badges_fixed_ready_posted`, `no_folder_is_no_hits`.
- [ ] `cargo test -p gitp-core pr_threads` fails; implement; passes; `cargo test -p gitp-core thread` passes.
- [ ] Commit `feat(core): search the stored thread conversations`.

### Task 2: GUI command + frontend helpers

**Files:**
- Modify: `crates/gitp-gui/src/gh.rs` (+`gh_thread_search`), `crates/gitp-gui/src/lib.rs` (register)
- Modify: `webui/src/types.ts`, `webui/src/api.ts` (+`searchThreadConversations`), `webui/src/pr-actions.ts` (`title: pr.title` in the two inputs)
- Create: `webui/src/thread-search.ts`, `webui/src/thread-search.test.ts`

**Interfaces — Produces:**
- Tauri `gh_thread_search(path: String, query: String, from: Option<u64>, to: Option<u64>, pr: Option<u64>) -> Result<ThreadSearch, String>`
- `searchThreadConversations(path: string, query: string, range: [number, number] | null, pr: number | null): Promise<ThreadSearch>`
- `parseThreadQuery(q: string): { text: string; pr: number | null }`
- `highlightParts(snippet: string, text: string): { text: string; bold: boolean }[]`
- `monthRange(year: number, month: number /*1-12*/): [number, number]`
- `keptMonths(now: Date, keepDays = 60): { year: number; month: number; label: string }[]` newest first
- `searchStatus(shown: number, total: number): string`
- `storedThread(c: ThreadConversation): Thread` (a thread rebuilt from a stored conversation, for one gone from GitHub)

- [ ] Tests (RED) in thread-search.test.ts for each helper: `#123` and `pr:45` parsed out, last wins, `123` stays a token; highlight case-insensitive, overlapping merged, `retry(` literal; monthRange local midnight bounds incl. December; keptMonths spans 3 months on 2026-11-07; searchStatus "Showing 200 of 340, narrow the search" / "1 conversation" / "No conversations".
- [ ] Implement, vitest + tsc green, cargo build green; commit `feat(webui): thread search command and helpers`.

### Task 3: UI — search view, PR view hooks, entry points

**Files:**
- Create: `webui/src/views/thread-search.ts`, `webui/src/views/thread-search.test.ts`
- Modify: `views/thread-claude.ts` (`readOnly?: boolean`: no composer/Fix/Send, only Clear) + test
- Modify: `views/pull-request.ts` (handle `focusThread(id)`; `data-thread` on thread nodes; resolved thread shows stored block collapsed read-only; gone thread note + block at top; scroll to focus)
- Modify: `app-state.ts` (View `"threadsearch"`, `ui.threadSearchView`), `index.html` (section), `shell.ts` (`showView` toggle), `main.ts` (setup), `pr-actions.ts` (`showThreadSearch()`, `openThreadHit(hit)`), `views/pr-list.ts` (header button "Search conversations"), `quick-launch-commands.ts` ("Search Conversations"), `styles.css`

**Interfaces — Produces:**
- `setupThreadSearchView(host, cb: { search(query: string, range: [number, number] | null, pr: number | null): Promise<ThreadSearch>; open(hit: ThreadHit): void; back(): void; reportError(title: string, err: unknown): void }): { show(): void }`
- PullRequestHandle + `focusThread(thread: number): void`

- [ ] Tests (RED): `typing_searches_once_after_200_ms`, `a_late_answer_for_an_older_query_is_dropped`, `a_row_shows_pr_title_file_line_snippet_bold_date_badges`, `a_dropped_snippet_is_marked`, `clicking_a_row_opens_the_hit`, `escape_and_back_return`, `the_month_picker_sends_a_millisecond_range`, `over_the_cap_says_narrow_the_search`; thread-claude `a_read_only_block_offers_only_clear`.
- [ ] Implement; full vitest + tsc green; commit `feat(webui): search thread conversations`.
- [ ] README: mention the search in the PR thread section.
