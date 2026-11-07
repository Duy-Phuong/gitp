# Thread conversation search

Date: 2026-11-07. Decided with Phuong in chat; "my call" marks builder defaults.

## Intent

Thread conversations are kept 60 days so Phuong can look back. This adds a search over them, by words, file, pull request and date.

## Goals

- A search box reachable from the pull request list header ("Search conversations") and Quick Launch.
- Words match, case-insensitively, the reviewer comments stored in the conversation, Claude's answers, the user's follow-ups and prepared replies, the file path, and the PR number (`#123` or `123`).
- Filters: a month picker (any month in the kept range) and "PR #" prefix. Empty query lists everything newest first.
- Result row: PR number and title (title from a cached list call when available, else just the number), file and line, a snippet around the first match with the match bold, the date of the last turn, badges (fixed / reply ready / posted).
- Click opens that PR on that thread with its conversation block open.
- Current repo only.

## Non-goals

- Searching GitHub itself, or threads with no stored conversation.
- An index. It reads the JSON files each search; a few hundred files is fine.

## Anti-goals

- A search that hangs the UI on a big directory: the read runs in core, returns at most 200 results, and the box debounces 200 ms.

## How

- Core: `search_thread_conversations(query: &str, month: Option<(u32, u32)>, pr: Option<u64>) -> Vec<ThreadHit { pr, thread, path, line, snippet, at, fixed, reply_state }>`, reading all conversation files, tokenising the query on whitespace, every token must match somewhere in the conversation's text fields. Snippet: 80 chars either side of the first token's first match in the first field it matches. Sorted by `at` descending.
- GUI command `searchThreadConversations`.
- Frontend: `views/thread-search.ts` with a debounced input and a results list; `thread-search.ts` pure helpers for highlighting and query parsing, with tests.

## What's left to the builder

- Whether to store the PR title in the conversation file on first turn (my call: yes, add `title: Option<String>` to the conversation, written when known; older files just lack it).
- Tests: core search (tokens, month, pr filter, snippet), DOM for debounce and click-through.

## Decisions after the builder check

- **Stored text (my call):** the conversation file gains `title`, `line` and `comments: [{author, body}]` (the whole thread as given to the turn), written on every turn so edits and replies are picked up. Older files without them match on turns only and show no line.
- **Resolved threads (my call):** the PR view renders the stored conversation block on resolved threads too, collapsed by default, read-only (no buttons but Clear); the search click expands it. A thread gone from GitHub opens the PR with a "thread no longer on GitHub" note and the stored conversation shown at the top of the Conversation tab.
- **Date (my call):** the last turn's time. The month filter is sent as a millisecond `[from, to)` range computed in the frontend in local time.
- **Title (my call):** the stored `title` only; older files show the number.
- **Query (my call):** `#123` or `pr:123` in the query is parsed out as the exact PR filter; any other number is a plain token. No separate PR box.
- **Where (my call):** a main-panel view like the PR list, Esc or Back returns to the previous view; a click calls `showPullRequest`.
- **Cap (my call):** core returns the first 200 after sorting plus the total; the view says "Showing 200 of N, narrow the search".
- **Turns (my call):** every turn with text is searched, dropped drafts included, marked "dropped" in the snippet row.
