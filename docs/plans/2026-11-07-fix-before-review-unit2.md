# Fix before the review, unit 2: GUI commands and frontend state — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tauri commands over unit 1, and the frontend state: drafts with a `fixed` status and fix record kept on disk (PR and branch), the merge on re-run, line remapping, and the branch review store.

**Architecture:** `crates/gitp-gui/src/reviews.rs` holds the new commands (jobs through `ClaudeJobs`, the fix lock through `FixJobs`, now keyed by repo and branch). `pr-reviews.ts` gains the fixed status, the fingerprint merge and a debounced disk save through an injected saver. `branch-reviews.ts` is the branch side: state per repo and branch, the base preference, remapping and hunk cutting (pure, tested).

**Tech Stack:** Rust/Tauri v2, TypeScript, vitest + happy-dom.

**Spec:** `docs/specs/2026-11-07-fix-before-review-design.md`.

## Global Constraints

- One fix at a time per repository and branch: a thread fix and a finding fix on the same branch exclude each other (`FixJobs` key `(path, branch)`), message `A fix is already running on <branch>.`
- Jobs: a branch review is `JobKind::Review` with `pr: 0` and `branch: Some(name)`, label `<label> · <branch>`; a finding fix is `JobKind::Thread`, activity `Fix`, `finding: Some("d<id>")`, `branch: Some(name)`, label `<file>:<line> · <branch or #n>`.
- Fingerprint for the merge: `path` + first 80 chars of the trimmed original body. Re-run: existing keep status and fix; new are added pending; missing pending/approved drop; fixed and discarded stay.
- Remap: LEFT lines never move; a RIGHT line maps through the reviewed-head→current-head diff of its path: unchanged lines and context lines map, a removed line is "moved"; a deleted file is "moved"; no move diff (reviewed head unreadable) → every RIGHT draft moved.
- Base preference: localStorage `gitp-review-base`, by `repo\nbranch`.
- Never run rustfmt on `lib.rs`.

## Review Focus

1. A PR draft fixed, then the app restarted: the fixed mark and fix commit come back (Task 3 restore test).
2. Typing in a draft is saved without a redraw (Task 3: the saver is called after the debounce, `reviewsChanged` listeners not).
3. A hunk insertion above the draft's line shifts it by the inserted count (Task 4).
4. A branch deleted through gitp loses its review file (Task 1).
5. The sidebar badge does not count fixed drafts as waiting (Task 3).

---

### Task 1: GUI commands

**Files:** Create `crates/gitp-gui/src/reviews.rs`; modify `crates/gitp-gui/src/lib.rs` (mod, register), `claude_jobs.rs` (`branch: Option<String>` on `Job`/`NewJob`, `#[serde(default)]`; `same` compares it; `stop_branch(kind, repo, branch)`), `gh.rs` (`FixJobs` keyed `(String, String)`; `gh_thread_fix_impl` locks `(path, branch)`; `gh_thread_prune_impl` adds `prune_stored_reviews`), `branches.rs` (a deleted branch's review file goes).

**Interfaces — Produces (commands, camelCase args from TS):**

```
review_default_base(path) -> String
branch_review_load(path, branch, base) -> BranchReviewData { review: Option<StoredReview>, head: String, base: String,
    files: Vec<FileDiff>, moves: Option<Vec<FileDiff>>, worktree: Option<String>, dirty: bool }
stored_review_load(path, key: ReviewKey) -> Option<StoredReview>
stored_review_save(path, review: StoredReview)
stored_review_delete(path, key: ReviewKey)
branch_generate_review(path, branch, base, command, label) -> GeneratedBranchReview   // job
branch_cancel_review(path, branch)
review_draft_fix(path, key: ReviewKey, id: u64, input: FindingInput, fixCommand) -> StoredReview   // job + FixJobs
review_draft_fix_cancel(path, branch)
```

`moves` is `Some(vec![])` when there is no review or its head equals the current head.

- [ ] Tests (RED) in `reviews.rs`: `a_branch_review_loads_its_diff_moves_and_worktree` (temp repo, feature with a commit, a stored review at the old head, one more commit → `moves` lists the changed file, `worktree` = the main checkout, `dirty` false then true with an untracked file); `a_finding_fix_is_refused_while_a_fix_runs_on_the_branch` (lock held → "already running on feature"; released after a failing run); `deleting_a_branch_deletes_its_review` (in `branches.rs` tests, via the existing harness).
- [ ] Run `cargo test -p gitp-gui reviews` → FAIL; implement; run `cargo test -p gitp-gui` → PASS (update the thread-fix lock test's message). Commit `feat(gui): commands for branch reviews and draft fixes`.

### Task 2: API wrappers and types

**Files:** `webui/src/types.ts`, `webui/src/api.ts`.

- [ ] Types: `ReviewFix {commit, worktree, at}`, `StoredDraft`, `StoredReview`, `ReviewKey = {branch: string} | {pr: number}`, `BranchReviewData`, `GeneratedBranchReview`, `FindingInput`; `ClaudeJob.branch?: string | null`.
- [ ] Wrappers with the same names camelCased (`reviewDefaultBase`, `branchReviewLoad`, `storedReviewLoad`, `storedReviewSave`, `storedReviewDelete`, `branchGenerateReview`, `branchCancelReview`, `reviewDraftFix`, `reviewDraftFixCancel`); browser mocks: a mock diff of two files, a review text with two findings after 3 s, a fix that returns the review with the draft fixed at `a1b2c3d…`.
- [ ] `npx tsc --noEmit` → clean. Commit with Task 3.

### Task 3: Drafts with fixed status, merge and disk persistence

**Files:** `webui/src/pr-reviews.ts`, `webui/src/pr-reviews.test.ts`.

**Interfaces — Produces:**

```ts
Draft.status: "pending" | "approved" | "discarded" | "fixed";  Draft.fix?: ReviewFix | null
PrReview.head?: string; PrReview.base?: string
export function fingerprintOf(d: {path: string; original?: string; body: string}): string
export function mergeDrafts(existing: Draft[], found: DraftComment[]): Draft[]
export function toStored(r: PrReview, key: ReviewKey): StoredReview
export function fromStored(r: PrReview, s: StoredReview): void
export function setReviewSaver(s: {save(repo: string, r: StoredReview): Promise<void>; remove(repo: string, key: ReviewKey): Promise<void>}): void
export function saveSoon(): void          // debounced 400 ms flush of every changed review
export function flushSaves(): Promise<void>
export function branchReviewOf(repo: string, branch: string): PrReview   // same map, key `repo\nbranch:<name>`
export const isOpen = (d: Draft) => d.status === "pending" || d.status === "approved"
```

`reviewsChanged()` also calls `saveSoon()`. A review with no drafts is removed (file deleted) once it had been saved. `reviewBadge` counts `isOpen` drafts.

- [ ] Tests (RED): `merging_keeps_status_and_fix_and_drops_missing_open_drafts`; `a_fixed_draft_is_saved_and_read_back` (fake saver; `fromStored` gives back status and fix); `typing_saves_without_telling_the_listeners` (fake timers); `the_badge_leaves_out_fixed_drafts`; `clearing_removes_the_saved_file`.
- [ ] Run `npx vitest run src/pr-reviews.test.ts` → FAIL; implement; PASS. Commit `feat(webui): drafts keep a fixed mark on disk`.

### Task 4: The branch review state

**Files:** Create `webui/src/branch-reviews.ts`, `webui/src/branch-reviews.test.ts`.

**Interfaces — Produces:**

```ts
export interface BranchReviewState { branch: string; base: string; data: BranchReviewData | null; loading: boolean;
  running: boolean; error: string | null; fixing: number | null }
export function branchState(repo: string, branch: string): BranchReviewState
export function loadReviewBase(repo: string, branch: string): string | null
export function saveReviewBase(repo: string, branch: string, base: string): void
export function remapLine(line: number, file: FileDiff | undefined): number | null   // null = moved; undefined file = unchanged
export type Placed = { path: string; line: number; side: "LEFT"|"RIGHT"; moved: boolean }
export function placeDraft(d: Draft, moves: FileDiff[] | null): Placed
export function hunkAround(files: FileDiff[], path: string, line: number, side: "LEFT"|"RIGHT"): string   // "@@ … @@\n+…" or ""
export function fixDisabledReason(s: BranchReviewState, d: Draft, placed: Placed): string | null
```

`fixDisabledReason` order: status not pending/approved → "Fixed already" / "Discarded"; moved → "The line moved since the review: run it again"; `s.fixing !== null` → "A fix is running on <branch>"; no worktree → "Check <branch> out first"; dirty → "Commit or stash the changes in <worktree> first".

- [ ] Tests (RED): `remapping_shifts_past_an_insertion_and_marks_a_removed_line` (hunk `@@ -3,2 +3,5 @@` adding 3 lines: line 1 → 1, line 10 → 13, removed line 4 → null, context line → its new number); `a_left_line_never_moves_and_a_deleted_file_moves_everything`; `no_move_diff_moves_every_right_draft`; `the_hunk_around_a_line_is_cut_from_the_diff`; `fix_is_refused_with_its_reason_in_order`; `the_base_is_remembered_per_branch`.
- [ ] Run → FAIL; implement; PASS. Commit `feat(webui): branch review state, remapping and the base`.
