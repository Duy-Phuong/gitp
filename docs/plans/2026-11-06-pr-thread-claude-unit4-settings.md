# PR thread Claude, unit 4: Settings fields and the Review with skill button — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The three thread commands editable in Settings → Git, and a "Review with skill" button in the pull request header that runs the skill review regardless of the Review command preset.

**Architecture:** `runReview` in `pr-actions.ts` takes the command as a parameter; the header gets a second button next to Generate Drafts, and Quick Launch a matching entry. Settings gets one `threadCommandField(kind)` per kind under the Review command row, each a textarea with a Reset to default link, saved on change through `saveThreadCommand`.

**Tech Stack:** TypeScript, vanilla DOM.

**Spec:** `docs/specs/2026-11-06-pr-thread-claude-design.md` (sections "The pull request header", "Default commands": the Settings paragraph).

## Global Constraints

- The Review command preset toggle in Settings stays as it is; the new button is a shortcut for one run with `SKILL_REVIEW_COMMAND`.
- One review per pull request at a time still: the button is a no-op while a review runs (as `runReview` already guards).
- Each thread command field: label "Check command" / "Explain simply command" / "Reply with Claude command" / "Follow-up command"; blank restores the default; a "Reset to default" link visible only when the value is custom.
- The shared hint under the fields: "Each runs as a shell line with the thread as JSON in $GITP_THREAD_FILE and the user's text on stdin. GITP_PR_NUMBER, GITP_PR_REPO, GITP_PR_URL, GITP_PR_HEAD, GITP_PR_AUTHOR, GITP_GH_LOGIN, GITP_THREAD_ID, GITP_THREAD_PATH, GITP_THREAD_LINE, GITP_CLAUDE_SESSION and GITP_TURN_KIND are set. Its stdout is the answer: plain Markdown, or claude's --output-format json."

## Review Focus

1. A thread command edited to whitespace resets to the default and the field shows the default again (Task 2 relies on `saveThreadCommand` from unit 2, tested there).
2. Review with skill while a review already runs does nothing and says so in the status (Task 1).

---

### Task 1: Review with skill in the header and Quick Launch

**Files:**
- Modify: `crates/gitp-gui/webui/src/pr-actions.ts` (`runReview` ~line 608; the callbacks ~line 511; Quick Launch entry ~line 468)
- Modify: `crates/gitp-gui/webui/src/views/pull-request.ts` (`PullRequestCallbacks`, `PullRequestHandle`, `generateButton` ~line 654 and its caller)

**Interfaces:**
- `runReview(repo, number, head, command = loadReviewCommand())`.
- Callback `generateDraftsWithSkill: (pr: PullRequestDetail) => void` → `runReview(state.repoPath, pr.number, pr.head_oid, SKILL_REVIEW_COMMAND)`.
- Handle `generateDraftsWithSkill: () => void` for Quick Launch; entry label "Pull Request: Review with Skill", detail "run the /review-pr-phuong skill over the open pull request".
- Header: after Generate Drafts, a `btn small ghost` "Review with skill", title "Run the /review-pr-phuong Claude Code skill in the background, whatever the Review command preset; its review page becomes the drafts", same `pr-has-news` dot as Generate Drafts.
- In `runReview`, when `r.running` is already true: `setStatus(\`A review of #${number} is already running.\`)` before returning.

- [ ] **Step 1: Implement** the above. No unit test: the button and Quick Launch entry are wiring over `runReview`, whose behaviour unit tests do not cover today either.
- [ ] **Step 2: Type-check and run the suite** — `npx tsc --noEmit` clean; `npm test` green.
- [ ] **Step 3: Verify in the preview** (vite on port 5179 from the worktree): the button shows next to Generate Drafts and clicking it marks the pull request "reviewing…" in the sidebar.
- [ ] **Step 4: Commit** `git commit -m "feat(webui): Review with skill on the pull request header"`

---

### Task 2: The thread command fields in Settings

**Files:**
- Modify: `crates/gitp-gui/webui/src/views/settings-dialog.ts` (after the "Review command" row ~line 346; a `threadCommandField(kind)` next to `reviewCommandField` ~line 621)
- Modify: `crates/gitp-gui/webui/src/styles.css` only if `.settings-command` needs a smaller `rows` variant (it should not).

**Interfaces:**
- `threadCommandField(kind: TurnKind): HTMLElement`: a `textarea.settings-select.settings-command` with `rows: 3`, value `loadThreadCommand(kind)`; on `change`, `saveThreadCommand(kind, area.value)` then reload the value; a `linkButton("Reset to default", …)` shown when `area.value !== DEFAULT_THREAD_COMMANDS[kind]`, which saves "" and reloads.
- Rows: one `row(label, threadCommandField(kind), "block", hint?)` per kind in the order check, explain, reply-draft, followup; the hint from Global Constraints on the first row only.

- [ ] **Step 1: Implement** the field and the four rows.
- [ ] **Step 2: Type-check and run the suite** — `npx tsc --noEmit` clean; `npm test` green.
- [ ] **Step 3: Verify in the preview**: open Settings → Git, see the four fields with the defaults, edit one, reopen Settings, see it kept and the Reset link; reset it.
- [ ] **Step 4: Commit** `git commit -m "feat(webui): the thread commands in Settings"`
