# Claude drafts, unit 2: GUI commands, api and settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The frontend can start, cancel and await both drafts, with editable default commands in Settings → Git.

**Architecture:** `crates/gitp-gui/src/drafts.rs` keeps one cancel flag per (repo path, draft kind) in a managed `DraftRuns` state and hands it to the core through `NetworkHooks.cancel`. `api.ts` wraps the commands with vite mocks. `prefs.ts` gains `DEFAULT_DRAFT_COMMANDS` like `DEFAULT_THREAD_COMMANDS`; Settings gets two rows. A small pure module `claude-drafts.ts` holds the confirm rule shared by unit 3.

**Tech Stack:** Rust/Tauri v2; TypeScript, vitest + happy-dom.

**Spec:** `docs/specs/2026-11-07-claude-drafts-design.md`.

## Global Constraints

- Default commands: `claude -p "<prompt>" --model opus --effort medium --permission-mode dontAsk --allowedTools "Read Grep Glob Bash(git log *) Bash(git diff *) Bash(git show *)" --output-format json` + `SESSION_ID_ARG`; no `--resume`. The prompt comes before `--allowedTools`.
- The PR prompt asks for a description ending in a "Checks" list (a task list of what to verify) and to follow the template in the file named by GITP_PR_TEMPLATE_FILE when set — written without `$` so an unset variable does not leave a hole.
- localStorage keys `gitp-draft-command-commit-message`, `gitp-draft-command-pr-draft`; blank or the default forgets the key.
- Settings rows "Commit message command" and "Pull request draft command" right after "Fix command"; `withClaudeChoice` applies to both at run time.
- One draft of each kind per repository at a time: a second start fails with `A draft is already running.`
- Never run rustfmt on `lib.rs`.

## Review Focus

1. Cancel on a repository with no running draft is a no-op, never a panic (Task 1).
2. A finished or failed run frees its slot so Try again can start (Task 1).
3. The mock in the browser preview can be cancelled and then rejects with `operation cancelled` (Task 2).
4. A stored custom command survives; blank restores the default (Task 2).
5. Confirm rule: whitespace-only text never asks; text equal to a pre-fill never asks (Task 2).

---

### Task 1: GUI commands

**Files:** Create `crates/gitp-gui/src/drafts.rs`; modify `crates/gitp-gui/src/lib.rs` (mod, `.manage(drafts::DraftRuns::default())`, three commands).

**Interfaces — Produces:**
- `#[serde(rename_all = "snake_case")] pub(crate) enum DraftKind { CommitMessage, PullRequest }`
- `draft_commit_message(path: String, command: String, amend: bool, runs) -> Result<CommitDraft, String>` (async)
- `draft_pull_request(path: String, branch: String, base: String, command: String, runs) -> Result<PrDraft, String>` (async)
- `draft_cancel(path: String, kind: DraftKind, runs)`

- [ ] **Step 1: Failing tests** on the `_impl` functions: `a_commit_draft_runs_in_the_repo` (fake command prints a message), `cancel_stops_a_running_draft` (thread runs `sleep 5`; cancel → `operation cancelled` within 2 s), `a_second_draft_of_the_same_kind_is_refused_and_the_slot_frees`, `cancel_with_nothing_running_is_a_no_op`.
- [ ] **Step 2: Run** `cargo test -p gitp-gui drafts` — fail.
- [ ] **Step 3: Implement.** Begin/end around the core call; the slot is removed whatever the outcome.
- [ ] **Step 4: Run** — pass.
- [ ] **Step 5: Commit** `feat(gui): commands to draft a commit message and a pull request`.

### Task 2: api, prefs, the confirm rule and Settings rows

**Files:** Modify `webui/src/api.ts`, `webui/src/types.ts`, `webui/src/prefs.ts`, `webui/src/views/settings-dialog.ts`; create `webui/src/claude-drafts.ts`, `webui/src/claude-drafts.test.ts`; tests in `prefs.test.ts`.

**Interfaces — Produces:**
- types: `CommitDraft {subject: string; body: string}`, `DraftRunKind = "commit_message" | "pull_request"`.
- api: `draftCommitMessage(path, command, amend): Promise<CommitDraft>`, `draftPullRequest(path, branch, base, command): Promise<PrDraft>`, `cancelDraft(path, kind: DraftRunKind): Promise<void>`.
- prefs: `DraftCommandKind = "commit-message" | "pr-draft"`, `DRAFT_TOOLS`, `DEFAULT_DRAFT_COMMANDS`, `loadDraftCommand(kind)`, `saveDraftCommand(kind, command)`.
- claude-drafts: `needsConfirm(current: string, prefilled: (string | null | undefined)[]): boolean`; `DRAFT_THINKING = "Claude is thinking…"`.

- [ ] **Step 1: Failing tests**: prefs — both defaults contain every `DRAFT_TOOLS` entry, `--output-format json`, no `--resume`, prompt before `--allowedTools`, the PR one mentions `Checks` and `GITP_PR_TEMPLATE_FILE` but not `$GITP_PR_TEMPLATE_FILE`; save/load/blank restores. claude-drafts — empty/whitespace → false; equal to a pre-fill (trimmed) → false; other text → true. api mock — `draftCommitMessage` resolves a draft; cancelled while pending rejects `operation cancelled`.
- [ ] **Step 2: Run** `npx vitest run src/prefs.test.ts src/claude-drafts.test.ts src/api.test.ts` — fail.
- [ ] **Step 3: Implement**; Settings: refactor `threadCommandField` body into `commandField(load, save, fallback)` and add the two rows with a hint naming stdin/env; extend the Claude model hint with "the commit message and pull request drafts".
- [ ] **Step 4: Run** vitest + `npx tsc --noEmit` — pass.
- [ ] **Step 5: Commit** `feat(webui): draft commands in Settings, api and the confirm rule`.
