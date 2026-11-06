# PR thread Fix, unit 2: the Fix button and turn in the app — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix on a thread from the app: the Tauri command with a per-pull-request fix lock, the default fix command and its Settings field, the Fix button in the block with its disabled reasons, the Fix turn and the "reply ready" badge with Drop.

**Architecture:** Mirrors unit 2 and 3 of the first design. `gh_thread_fix` wraps `Repo::fix_thread` under the thread lock plus a `FixJobs` lock keyed by repo path and PR. `prefs.ts` gains `FIX_TOOLS` and a `fix` entry in `DEFAULT_THREAD_COMMANDS`. `pr-threads.ts` gains the pure helpers; `thread-claude.ts` the Fix button, the Fix turn and the badge; `pr-actions.ts` `runFix` and the posted mark on the existing reply.

**Spec:** `docs/specs/2026-11-06-pr-thread-fix-design.md`.

## Global Constraints

- `FIX_TOOLS` = `THREAD_TOOLS` plus `Edit`, `Write`, `Bash(git add *)`, `Bash(git commit *)`, `Bash(git status *)`, `Bash(git stash list)`, `Bash(npm test*)`, `Bash(npx vitest *)`, `Bash(cargo test *)`, `Bash(./gradlew test*)`, `Bash(mvn *test*)`, `Bash(pytest *)`, `Bash(go test *)`; never `git push`, `gh`, `git checkout`, `git switch`, `git reset`, `git rebase`.
- The default `fix` prompt is the one in the spec ("What the fix command gets").
- Fix is disabled with these tooltips, in this order: no option ("Send the option you want as a follow-up first"), branch nowhere ("Check the pull request out first"), another fix running on the PR ("A fix is running on <path>:<line>"); the dirty/behind checks are core's, on click.
- One fix per pull request at a time (`FixJobs`), one turn per thread (`ThreadJobs`).
- Badges on the thread's actions row: "fixed · reply ready" when the conversation has a Fix turn with a commit and a prepared reply; "reply ready" when only the reply; "posted" when the latest draft is posted. A Drop link beside "reply ready".

## Review Focus

1. A fix that fails must leave the thread with the error and Try again, and no "reply ready" badge (Task 4).
2. Fix must be disabled on every other thread of the PR while one fix runs, and enabled again when it ends or fails (Task 3 test of `fixDisabledReason`).
3. The thread's own Reply button marks the draft posted, so Push and reply all (unit 3) never reposts (Task 4: `reply` callback calls `markReplyPosted` on success).

---

### Task 1: Types, Tauri commands, api bindings

**Files:** `webui/src/types.ts`, `crates/gitp-gui/src/gh.rs`, `crates/gitp-gui/src/lib.rs`, `webui/src/api.ts`.

- types: `TurnKind` adds `"fix"`; `ThreadTurn` adds `commit?`, `worktree?`, `posted?`, `dropped?`; `ThreadConversation` adds `fix_session?`.
- GUI: `FixJobs(Mutex<HashMap<(String, u64), ()>>)` managed in lib.rs; `gh_thread_fix(path, input, branch, fixCommand, replyCommand)` takes the thread lock as `gh_thread_turn_impl` does and the PR fix lock ("A fix is already running on #N."), calls `repo.fix_thread`; `gh_thread_mark_posted(path, number, thread, url)`, `gh_thread_drop_reply(path, number, thread)`; `gh_thread_cancel` also stops a fix (same thread key).
- api: `threadFix`, `markReplyPosted`, `dropReply`; mocks: `threadFix` waits 2 s, appends a Fix turn (`commit: "a1b2c3d…"`, `worktree: "/Users/you/…"`, text "**Changed** src/retry.ts …") and a reply-draft turn; `markReplyPosted` sets `posted` on the mock's latest draft; `dropReply` sets `dropped`.
- Test: GUI `gh.rs`: `a_fix_is_refused_while_another_runs_on_the_pull_request` (hold the FixJobs key, call `gh_thread_fix_impl`, expect "already running on #"; release; a thread with no comments errs before touching the lock). `npx tsc --noEmit` clean.
- Commit `feat(gui): Tauri commands and bindings for Fix on a thread`.

### Task 2: The fix command in prefs and Settings

**Files:** `webui/src/prefs.ts`, `webui/src/prefs.test.ts`, `webui/src/views/settings-dialog.ts`.

- `FIX_TOOLS`, `DEFAULT_THREAD_COMMANDS.fix` built by a `fixCommand(prompt)` that is `threadCommand` with `FIX_TOOLS`; `loadThreadCommand("fix")` works by construction. A "Fix command" row in Settings → Git after Follow-up command.
- Test (RED): in the thread-commands describe: `FIX_TOOLS` contains `Edit`, `Write`, `Bash(git commit *)`, `Bash(cargo test *)` and none of `push|gh |checkout|switch|git reset|rebase`; the `fix` default contains `--allowedTools "` + `Edit` and `$GITP_FIX_HEAD_BEFORE`-free (the prompt doesn't need it) but `commit exactly once`.
- Commit `feat(webui): the fix command`.

### Task 3: State helpers and the block

**Files:** `webui/src/pr-threads.ts` (+test), `webui/src/views/thread-claude.ts` (+test), `webui/src/styles.css`.

- pr-threads: `hasChosenOption(c)`: a user turn after the last Check-or-Fix Claude turn… simpler and what the spec says: the last user turn exists and comes after the last `check` turn; `preparedReply(c): ThreadTurn | null` (latest reply-draft, not posted, not dropped); `lastFix(c): ThreadTurn | null` (latest Fix turn with a commit); `fixRunningOn(repo, number): number | null` (the thread id whose `running === "fix"`); `fixDisabledReason(c, branchCheckedOut: boolean, fixRunningElsewhere: string | null): string | null`.
- thread-claude: `ConversationOptions` gains `fix: { disabled: string | null }`, `onFix`, `onDrop`; the composer row gets a Fix button (disabled with the reason as title); a Fix turn renders its text plus a line "Commit <7 chars> in <worktree basename>"; the running line says "Claude is fixing…" for `running === "fix"`. New `threadBadges(c): string[]` → `["fixed", "reply ready"]` / `["reply ready"]` / `["posted"]` / `[]`.
- Tests (RED): helpers over small conversations; `conversationNode` with a Fix turn shows the commit line; Fix button disabled with the given reason.
- Commit `feat(webui): the Fix button, the Fix turn and the reply-ready badge`.

### Task 4: Wiring in pr-actions and the view

**Files:** `webui/src/pr-actions.ts`, `webui/src/views/pull-request.ts`, `webui/src/main.ts` if needed.

- Callbacks: `fixThread(pr, thread)`, `dropReply(pr, thread)`, and `branchCheckedOut(branch): Promise<boolean>` is avoided: the view passes `pr.head` and pr-actions checks `state.worktrees`? Simpler: the disabled reason "Check the pull request out first" comes from core on click (it already refuses), so the view only knows the first and third reasons. Ruling recorded in the ledger.
- `runFix(repo, pr, thread)`: `startTurn(.., "fix")`; `threadFix(repo, input, pr.head, loadThreadCommand("fix"), loadThreadCommand("reply-draft"))`; `finishTurn`; status lines "Fixing <path>:<line> of #N in the background…" / "Fixed <path>:<line> of #N: commit <7>; reply ready."; on error as `runThreadTurn`.
- The existing `reply` callback: on success `markReplyPosted(repo, pr.number, root.id, url)` when the conversation has a prepared reply (ignore errors), then reload the conversation.
- The view: `onFix`, `onDrop` (confirm "Drop the prepared reply?"), badges appended to the actions row from `threadBadges`, the reply-draft landing rule unchanged (a Fix produces a newer reply-draft turn, so `pendingReplyDraft` is set on Fix click too).
- Verify in the preview: Check → follow-up → Fix → block shows the Fix turn, Reply box filled, badge "fixed · reply ready"; a second thread's Fix disabled meanwhile; Drop clears the badge.
- Commit `feat(webui): Fix on a pull request thread`.
