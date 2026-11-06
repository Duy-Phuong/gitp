# PR thread Fix, unit 3: Push and reply all — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One action on the pull request header that lists the commits ahead of the remote and every prepared reply, asks once, pushes the branch, posts the replies in their threads, marks them posted and reloads. Plus the Fix command field in Settings that unit 2 left out.

**Architecture:** All frontend. `pr-actions.ts` gains `pushAndReplyAll(repo, pr, edited)`: it loads every unresolved thread's conversation, collects `preparedReply` per thread (the Reply box text wins when the view passes it), builds the listing, confirms, pushes through the existing `pushBranch`, then posts each reply through `replyToReviewComment` and `markReplyPosted`, and reloads the view. The header button and the Quick Launch entry mirror Review with skill. A pure `pushAndReplyListing(ahead, commits, replies)` builds the confirm text and is unit-tested.

**Spec:** `docs/specs/2026-11-06-pr-thread-fix-design.md`, section "The header".

## Global Constraints

- The button shows only when at least one thread has a prepared reply or the branch is ahead of its upstream; it is disabled while a fix or a turn runs on the pull request.
- Ahead count and commit subjects come from the local branch: `state.refs.branches.find(b => b.name === pr.head)?.ahead`, and the subjects from a new api `branchAheadLog(branch): Promise<{ sha: string; subject: string }[]>` → Tauri `branch_ahead_log` → core `Repo::ahead_log(branch)` = `git log --format=%h%x09%s @{u}..<branch>` (empty when no upstream).
- The confirm text: "Push <branch> (<n> commits ahead of <remote>) and post <m> replies on #<number>?" then the commits (`<sha> <subject>`), a blank line, then each reply as `<path>:<line>  <first line, clipped to 80>`. With nothing to push: "Post <m> replies on #<number>?"; with nothing to post: "Push <branch> (…)?".
- Order: push first; a failed push stops before any reply. Replies in thread order (as `reviewThreads(pr)` lists them); a failed reply is reported and stays prepared; the rest go on. Then the conversation reloads.
- Nothing else posts or pushes from this unit.
- The Fix command field: one `row("Fix command", threadCommandField("fix"), "block", "<hint: runs in the branch's worktree; may edit, test and commit once; GITP_FIX_WORKTREE, GITP_FIX_BRANCH and GITP_FIX_HEAD_BEFORE are set too>")` after Follow-up command.

## Review Focus

1. A reply edited in the Reply box is what gets posted, not the stored draft (Task 2: `edited` map wins).
2. A reply that fails to post stays prepared and the others still go (Task 2 loop with try/catch per reply).
3. A failed push posts nothing (Task 2: `await pushBranch` before the loop).

---

### Task 1: Ahead log and the listing

- Core `Repo::ahead_log(&self, branch: &str) -> Result<Vec<AheadCommit>>` (`sha`, `subject`), in branch_ops.rs; `Ok(vec![])` when the branch has no upstream (`git rev-parse --abbrev-ref <branch>@{u}` fails). Test on a temp repo with a bare remote: two commits ahead → two entries newest first; no upstream → empty.
- GUI command `branch_ahead_log(name)`; api `branchAheadLog(name)` (mock: two fake commits).
- `pr-actions.ts` (or a small `pr-push-reply.ts` for the pure part): `pushAndReplyListing({ branch, remote, number, commits, replies }): string` per Global Constraints; vitest for the three shapes and the 80-char clip.
- Commit `feat: the commits ahead of a branch's upstream, and the push-and-reply listing`.

### Task 2: pushAndReplyAll, the header button, Quick Launch, Settings field

- Callback `pushAndReplyAll(pr, edited: Map<number, string>)` and handle `pushAndReplyAll()`; the view passes `replyText` entries that are non-empty.
- `pushAndReplyAll`: for every root of `reviewThreads(pr)` (unresolved), `await threadConversation(repo, number, root.id)` into the state; `replies = roots.map(r => ({ root, body: edited.get(r.id)?.trim() || preparedReply(conv)?.text })).filter(body)`; `ahead = branches.find(...)?.ahead ?? 0`; `commits = ahead ? await branchAheadLog(pr.head) : []`; if nothing → status "Nothing to push or post on #N." and return; confirm; `if (ahead) await pushBranch(pr.head, remote)` where `remote` is `githubRemoteName(state.refs.remotes, repoArg)` ?? "origin"; loop replies: `replyToReviewComment` → `markReplyPosted` (errors of the mark ignored) and drop the view's `replyText`/`replyOpen` for that thread (via a `postedReply(root.id)` callback into the view? simpler: the view clears its `replyText`/`replyOpen` for every id in `edited` after the promise resolves true); status per failure; `reportDone("Pushed … and posted … replies on #N.")`; `ui.prView?.reload()`.
- Header: `pushAndReplyButton(pr)` after `skillButton`, shown when `preparedCount(repo, number) > 0 || ahead > 0` (preparedCount over loaded threads in pr-threads.ts: `preparedReplies(repo, number): number`), disabled while `runningTurns(repo, number) > 0`.
- Quick Launch: "Pull Request: Push and Reply All".
- Settings: the Fix command row.
- Verify in the preview: with a prepared reply from the mock Fix, the button shows, the confirm lists the mock commits and the reply, Done → badge "posted", Reply box closed; a second click says nothing to do.
- Commit `feat(webui): Push and reply all on the pull request header`.
