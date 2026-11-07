# Claude drafts, unit 3: the buttons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Draft with Claude" in the commit box and in the Create Pull Request dialog, with thinking/Cancel/Try again and the confirm-before-replace rule; Quick Launch "Draft Commit Message with Claude".

**Architecture:** `changes.ts` keeps the draft state in its controller (it re-renders the commit box) and gets two callbacks, wired in `main.ts`. `form-dialog.ts` gains an optional per-field action button with a status line and an `onClose`; the PR draft behaviour lives in a new `pr-draft-action.ts` so it can be tested with the dialog alone.

**Tech Stack:** TypeScript, `el()` from dom.ts (no innerHTML), vitest + happy-dom.

**Spec:** `docs/specs/2026-11-07-claude-drafts-design.md`.

## Global Constraints

- Commit box: button `Draft with Claude` in `.commit-controls` before Commit; disabled with title `Stage something first` when nothing is staged and Amend is off; while running its text is `Cancel` and the fields stay editable; a status line under the controls says `Claude is thinking…`; a failure shows the error there with `Try again`; a cancel shows nothing.
- Commit result: first line → Subject, rest → Description. Replaced without asking when the box is empty, the template, a gitp pre-fill (merge message) or Claude's last draft unchanged; otherwise (typed text, Amend's HEAD message) `confirm` first.
- PR dialog: button `Draft with Claude` next to the Description label; uses the Into value as base. Title filled only when empty or equal to the pre-filled title (or Claude's last title); description asks unless empty, the pre-filled description or Claude's last one. Closing the dialog cancels a running draft. The dialog stays open.
- Repo switch (`reset`) cancels a running commit draft and drops its result.
- Quick Launch: `Draft Commit Message with Claude` shows Local Changes and starts the draft (status `Stage something first.` when it can't).

## Review Focus

1. The user types into Subject while the draft runs, then the draft lands → asks (Task 1).
2. A draft that returns after a repo switch must not fill the new repo's box (Task 1).
3. Cancel then Try again starts a fresh run (Task 1).
4. The PR dialog closed while drafting: the result is dropped and the run cancelled (Task 2).
5. Changing Into after a draft and drafting again uses the new base (Task 2).

---

### Task 1: Commit box

**Files:** Modify `webui/src/views/changes.ts`, `webui/src/main.ts`, `webui/src/quick-launch-commands.ts`, `webui/src/styles.css`; test `webui/src/views/changes-draft.test.ts`.

**Interfaces:** Consumes unit 2's `draftCommitMessage`, `cancelDraft`, `loadDraftCommand`, `withClaudeChoice`, `needsConfirm`, `DRAFT_THINKING`, `isCancelled`. Produces `ChangesCallbacks.draftMessage(amend: boolean): Promise<CommitDraft>`, `ChangesCallbacks.cancelDraft(): void`, `ChangesHandle.draftMessage(): void`.

- [ ] **Step 1: Failing DOM tests** with stub callbacks: disabled with nothing staged; fills an empty box without confirm; asks when typed text differs and keeps it on No; Cancel calls `cancelDraft` and leaves no error; failure shows error and Try again runs again; `reset()` during a run drops the result; Amend message asks.
- [ ] **Step 2: Run** `npx vitest run src/views/changes-draft.test.ts` — fail.
- [ ] **Step 3: Implement**; wire `main.ts` (path captured at start for cancel) and Quick Launch.
- [ ] **Step 4: Run** vitest + tsc — pass.
- [ ] **Step 5: Commit** `feat(webui): Draft with Claude in the commit box`.

### Task 2: Create Pull Request dialog

**Files:** Modify `webui/src/views/form-dialog.ts`, `webui/src/pr-actions.ts`; create `webui/src/pr-draft-action.ts`; tests `webui/src/views/form-dialog.test.ts`, `webui/src/pr-draft-action.test.ts`.

**Interfaces — Produces:**
- `FormField.action?: FieldAction`; `FieldAction { label: string; run: (form: FormAccess) => void }`; `FormAccess { value(i: number): string; set(i: number, v: string): void; button: HTMLButtonElement; status: HTMLElement; isOpen(): boolean }`; `FormOptions.onClose?: () => void` (called once on any close).
- `prDraftAction(deps: { prefilled: PrDraft; fields: { base: number; title: number; body: number }; draft(base: string): Promise<PrDraft>; cancel(): void; confirm(message: string): Promise<boolean> }): { action: FieldAction; close(): void }`.

- [ ] **Step 1: Failing tests**: form-dialog renders the action button inside the field's row and `set` changes the value, `onClose` fires on Cancel and on submit; prDraftAction fills a pre-filled dialog without asking, keeps a typed title, asks before replacing a typed description, Cancel → `cancel()` and clear status, error → Try again, closed dialog drops the result.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement**; in `createPullRequestDialog` add the action to Description and `onClose: close`.
- [ ] **Step 4: Run** vitest + tsc — pass.
- [ ] **Step 5: Commit** `feat(webui): Draft with Claude in the Create Pull Request dialog`; README update in this commit.
