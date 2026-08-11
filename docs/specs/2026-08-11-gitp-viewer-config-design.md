# gitp — v1 Design: Repo Viewer + Config Editor

**Date:** 2026-08-11
**Status:** Approved (design), pending implementation plan
**Milestone:** v1 (first buildable slice)

## Summary

`gitp` is a personal daily-driver git tool meant to replace GitKraken, built as a
**desktop GUI** on top of a **shared git-engine core**. The two headline wins over
existing tools are **log/history visualization** and **editing git config through
the UI**. For everything else, the GUI includes an **embedded terminal** so any
git command can be run by hand right next to the visuals.

This spec covers **v1 only**: high-quality read-only visuals (log + config editing)
via `gitp-core`, plus an embedded terminal. `gitp` performs no write operations of
its own in v1 (staging, committing, branching, merge/rebase, push/pull, remotes,
conflict resolution) — those are done in the embedded terminal, and dedicated UI
for them is **deferred** to later milestones.

## Goals

- Open a repo and browse its history through a high-quality commit-graph log.
- Inspect any commit: message, metadata, changed files, per-file diff.
- View and edit git config (local + global) through a friendly UI, with a raw
  fallback and validation.
- Provide an embedded terminal so any git command can be run by hand in-app.
- macOS-first, but keep the stack cross-platform for later.

## Non-Goals (v1)

`gitp` provides no *dedicated UI* for the following in v1 — they are done in the
embedded terminal instead:

- Staging / unstaging / committing.
- Branch/tag creation, merge, rebase, cherry-pick.
- Push / pull / fetch, remotes, and any network auth.
- Conflict resolution.

Also out of scope:

- A separate/scriptable `gitp` CLI (the embedded terminal runs plain `git`).
- Cross-platform packaging/distribution (possible later, not targeted now).

## Tech Stack

- **Language:** Rust.
- **GUI:** Tauri (Rust backend commands + web frontend in HTML/TS).
- **Embedded terminal:** a PTY (`portable-pty`) spawned by the Tauri backend,
  rendered with `xterm.js` in the web frontend.
- **Git access:** `git2` (libgit2 bindings) — mature and complete for v1 reads
  *and* config writes. If large-repo log traversal ever becomes a bottleneck, the
  history-walk internals can be swapped to `gix` behind the core boundary as a
  localized change.

## Architecture

Cargo workspace with three crates:

```
gitp/
├─ crates/
│  ├─ gitp-core/   # all git logic: repo, log graph, diffs, config. No UI.
│  └─ gitp-gui/    # Tauri app: backend commands → gitp-core; web frontend + terminal
└─ docs/specs/
```

**Core rule:** all read/visualization git knowledge lives in `gitp-core`. The
Tauri backend is a thin adapter — it translates UI intent into `gitp-core` calls
and serializes results to the web frontend. The embedded terminal is a separate
path: it runs the real `git` binary through a PTY, so it is independent of
`gitp-core` and always as capable as the user's own git install.

### `gitp-core` public API (shape)

Frontend-agnostic; returns plain data structures, never UI or CLI concerns.

- `Repo::open(path) -> Result<Repo>`
- `repo.log(LogOptions) -> Result<Vec<CommitRow>>`
  - `CommitRow` carries **pre-computed graph-lane data** (lane index, parent/child
    lane links, colour bucket) so frontends only *render* the graph and never
    compute topology themselves.
  - `LogOptions`: max count, author filter, oneline/full, start ref.
- `repo.commit_detail(oid) -> Result<CommitDetail>`
  - metadata (author, committer, dates, parents, full message) + `Vec<FileDiff>`.
  - `FileDiff`: path(s), change kind (add/modify/delete/rename), hunks with line
    tags for syntax highlighting and unified/side-by-side rendering.
- `config::read(scope) -> Result<ConfigModel>` where `scope ∈ { Local, Global }`.
  - `ConfigModel` records, per entry, which scope it originated from.
- `config::write(scope, changes) -> Result<()>` with validation before persist.

**Graph-lane computation lives in core**, so the GUI and a future
`gitp log --graph` render identically.

## Features (v1)

### GUI

1. **Open a repo** — folder picker + a recent-repos list.
2. **Commit-graph log** (headline view):
   - coloured branch lanes,
   - commit rows: summary, author, relative date, short SHA,
   - refs/tags shown as pills,
   - smooth scroll over large history.
3. **Commit detail** — click a commit to see message, metadata, changed-files
   list, and per-file diff (syntax-highlighted; unified/side-by-side toggle).
4. **Config editor** — view/edit **local** (`.git/config`) and **global**
   (`~/.gitconfig`) as friendly key/value forms *plus* a raw-text fallback;
   validate before save; clearly distinguish which scope a value comes from.
5. **Embedded terminal** — a shell panel (PTY) rooted at the open repo, for
   running any git command by hand. After a command that mutates the repo, the
   log/status/config views refresh so the visuals stay in sync (initially via a
   manual refresh action; auto-refresh-on-focus is a nice-to-have).

## Data Flow

**Visualization path (log, commit detail, config):**

1. A GUI event parses user intent and invokes a `#[tauri::command]`.
2. The command calls a `gitp-core` function.
3. `gitp-core` performs the git operation via `git2` and returns plain data.
4. Tauri serializes the result to the web frontend, which renders it.

**Terminal path:** the frontend's xterm.js panel is wired to a PTY spawned by the
Tauri backend (`portable-pty`), rooted at the open repo. Keystrokes stream to the
PTY; output streams back. This path does not go through `gitp-core` — it runs the
real `git` binary. After a mutating command, the user refreshes the visualization
views (manual action in v1) so the graph/config reflect the new state.

## Error Handling

- `gitp-core` uses `thiserror` to return typed errors; **no `unwrap` on core paths**.
- **GUI** surfaces `gitp-core` errors as non-blocking toasts.
- **Terminal** errors are just the git binary's own stderr, shown inline in the
  terminal — `gitp` does not intercept or reformat them.

## Testing

- **Core** unit/integration tests run against **hermetic temp fixture repos** built
  in-test via `git2`. Coverage:
  - log ordering and graph-lane assignment,
  - diff correctness (add/modify/delete/rename, hunk boundaries),
  - config read/write round-trips across Local/Global scopes and the raw fallback.
- **GUI** logic kept thin enough that correctness is covered by core tests; the
  Tauri command layer is a pass-through. The terminal is exercised manually (PTY
  wiring is integration-tested at a smoke level: spawn, echo, resize).

## Platform

macOS-first (development machine). Tauri + `git2` are cross-platform, so
Linux/Windows remain achievable later at low cost; no mac-only APIs in v1.

## Future Milestones (not in v1)

- **v2:** dedicated UI for working-tree status, stage/unstage, and commit (until
  then these are done in the embedded terminal).
- **Later:** UI for branch/tag ops, merge/rebase, push/pull/fetch, remotes + auth,
  conflict resolution.
