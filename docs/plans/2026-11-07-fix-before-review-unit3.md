# Fix before the review, unit 3: UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The branch Review panel (Drafts and Files), its entry points, Fix on branch drafts and on the user's own PR drafts, "Show in diff", draft cards in both Files tabs kept in sync with the Drafts tab, the Create Pull Request note, and the neutral fix prompt.

**Architecture:** `views/draft-cards.ts` is the one draft card (list and inline modes) plus `placeDraftCards` for a rendered diff; the PR view and the new `views/branch-review.ts` both use it, and both redraw from the shared store on `reviewsChanged`, so an edit in one view shows in the other. `branch-review-actions.ts` wires the panel to the commands (run, cancel, fix, load). A new view `branchreview` hosts the panel.

**Tech Stack:** TypeScript, `el()` DOM, vitest + happy-dom.

**Spec:** `docs/specs/2026-11-07-fix-before-review-design.md`.

## Global Constraints

- No innerHTML; Markdown via `renderGitHubMarkdown` where read-only.
- Entries in the branch menu: "Open Review Panel", "Run Review Skill", "Run Review Command" next to "Create Pull Request", disabled with a title when the branch is in no worktree.
- Card copy: "Fixed in <7 chars>" (click opens the commit in History); "line moved"; Fix title is the disabled reason; Fix offered on a branch and on a PR whose author is the signed-in login, never otherwise; not offered on fixed drafts; Discard allowed on fixed (keeps the record).
- Create PR sub line adds: "N review findings are not fixed or discarded." (singular "1 review finding is not fixed or discarded.")
- Default fix prompt: neutral, starts "Read $GITP_THREAD_FILE: a review thread on a pull request, or a review finding on a branch", commit subject `fix(review): <path>:<line> — <what>`.
- Branch skill line: `/review-pr-phuong $GITP_BRANCH against $GITP_BASE`, no board mode.

## Review Focus

1. Approve in the Files tab card, then switch to Drafts: shown approved (Task 1 DOM test).
2. A moved draft gets no card in the diff and no Fix in the list (Task 2).
3. Fix on someone else's PR never appears (Task 3).
4. Show in diff scrolls to the card (Task 2: `scrollIntoView` called on the card).
5. The Create PR dialog still opens when the review file can't be read (Task 4: error → no note).

---

### Task 1: The shared draft card and cards in the PR Files tab

**Files:** Create `webui/src/views/draft-cards.ts`, `webui/src/views/draft-cards.test.ts`; modify `views/pull-request.ts` (draftCard moves out; `annotatedFile` places cards; Drafts tab "Show in diff"; Fix on own PR), `styles.css`.

**Interfaces — Produces:**

```ts
export interface DraftCardOptions { where: "list" | "inline"; note: string | null;   // anchor note ("line not in this diff", "line moved")
  fix: { reason: string | null; run: () => void } | null; showInDiff: (() => void) | null;
  openCommit: (sha: string) => void; changed: (redraw: boolean) => void }
export function draftCard(d: Draft, o: DraftCardOptions): HTMLElement            // data-draft = id
export function placeDraftCards(node: HTMLElement, file: FileDiff, drafts: { d: Draft; line: number; side: "LEFT"|"RIGHT" }[], card: (d: Draft) => HTMLElement): void
```

- [ ] Tests (RED): `an_inline_card_approves_and_the_list_card_shows_it` (one Draft object, two cards; click Approve in inline → `changed(true)`; a fresh list card says "Approved ✓"); `a_fixed_card_shows_its_commit_and_no_fix`; `cards_go_under_their_lines_in_unified_and_split` (render a FileDiff with `renderFile`/`renderSplitDiff`, place a RIGHT draft at line 2 → card follows the row of new line 2).
- [ ] Run → FAIL; implement; PASS; `npx tsc --noEmit`. Commit `feat(webui): draft cards in the pull request diff`.

### Task 2: The branch Review panel

**Files:** Create `webui/src/views/branch-review.ts`, `webui/src/views/branch-review.test.ts`, `webui/src/branch-review-actions.ts`; modify `index.html` (`#branch-review-view`), `app-state.ts` (`View` + `"branchreview"`), `shell.ts` (`showView`, `showBranchReview(branch)`), `main.ts` (setup), `claude-jobs.ts` (a branch job opens the panel).

**Interfaces — Produces:**

```ts
export interface BranchReviewCallbacks { repoPath(): string; bases(): string[]; load(branch: string, base: string): Promise<void>;
  run(branch: string, base: string, skill: boolean): void; cancel(branch: string): void; fix(branch: string, d: Draft): void;
  openCommit(sha: string): void; clear(branch: string): Promise<void> }
export function setupBranchReviewView(host: HTMLElement, cb: BranchReviewCallbacks): { show(branch: string): void; redraw(): void }
```

Header: branch, Against select (bases, the chosen one selected), Run Review Skill, Run Review Command (or "Reviewing… Cancel" while running), "Reviewed at <7> · now <7>" when the head moved, Clear. Tabs Drafts (n) and Files (n). Empty diff → "Nothing to review: <branch> has no changes against <base>."

- [ ] Tests (RED): `the_panel_lists_drafts_and_places_cards_in_the_files_tab` (state with data + review, two drafts, one moved → Drafts lists both with "line moved" on one; Files has one `.pr-draft` inline); `fix_is_disabled_with_its_reason_while_a_fix_runs`; `show_in_diff_switches_to_files_and_scrolls_to_the_card`; `changing_against_saves_the_base_and_reloads`.
- [ ] Run → FAIL; implement; PASS. Commit `feat(webui): the branch Review panel`.

### Task 3: Actions: menu entries, runs, fixes, PR own-draft fix

**Files:** `webui/src/branch-review-actions.ts`, `ref-actions.ts`, `pr-actions.ts` (PR saver wiring, restore from disk first, `fixPrDraft`), `views/pull-request.ts` (Fix callback), `quick-launch-commands.ts` (Review Branch entries), `main.ts` (`setReviewSaver`).

- `runBranchReview(repo, branch, base, skill)`: `branchGenerateReview` with `withClaudeChoice(skill ? BRANCH_SKILL_REVIEW_COMMAND : loadReviewCommand())`; parse; `mergeDrafts`; head/base from the result; save; reload the data.
- `fixBranchDraft` / `fixPrDraft`: `flushSaves()`, `reviewDraftFix(repo, key, d.id, input, withClaudeChoice(loadThreadCommand("fix")))`, `fromStored`, `reviewsChanged()`, refresh refs (`loadSidebar`); errors toast as the thread fix.
- Own PR: `state.prs.account?.login === pr.author`.

- [ ] Test (RED) in `branch-review.test.ts` or `views/draft-cards.test.ts`: `fix_appears_only_on_your_own_pull_request` (PR drafts tab rendered through the card options builder `prFixOption(login, pr)` → null for another author).
- [ ] Run → FAIL; implement; PASS. Commit `feat(webui): run, fix and open branch reviews`.

### Task 4: Create Pull Request note and the neutral fix prompt

**Files:** `pr-actions.ts` (`createPullRequestDialog`), `prefs.ts` (`DEFAULT_THREAD_COMMANDS.fix`, `BRANCH_SKILL_REVIEW_COMMAND`), `prefs.test.ts`, `branch-reviews.ts` (`openFindingsNote(n)`), README.

- [ ] Tests (RED): `the_fix_prompt_is_neutral` (contains "a review finding on a branch" and `fix(review): <path>:<line>`); `the_branch_skill_line_names_branch_and_base`; `the_create_pr_note_counts_open_findings` (`openFindingsNote(0)` → "", 1 → singular, 3 → plural).
- [ ] Run → FAIL; implement; PASS. Commit `feat(webui): neutral fix prompt and the open findings note`.
