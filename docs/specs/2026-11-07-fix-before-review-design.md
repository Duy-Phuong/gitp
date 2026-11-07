# Fix before the review, and draft cards in the diff

Date: 2026-11-07. Decided with Phuong in chat; the calls marked "my call" are the builder's defaults and can be changed.

## Intent

Today the review skill runs only on a pull request, and its findings live in the Drafts tab. Phuong reviews their own branch before opening the PR by running the skill, reading, and fixing by hand. This feature lets the review run on a local branch before any PR exists, and lets each finding be fixed in the branch's worktree with one click, the way a thread is fixed today (`docs/specs/2026-11-06-pr-thread-fix-design.md`). A fixed finding stays in the list marked fixed, with its commit, so it can be looked at again.

As a small companion change, draft comments also appear as cards on their lines in the Files tab diff, in addition to the Drafts tab. Same draft, two views.

## Goals

- Run Review Skill / Run Review Command on a local branch with no pull request. The diff is the branch against its base.
- Findings land in the same Drafts list, with the same approve/edit/discard, plus Fix.
- Fix runs in the worktree that has the branch, with the thread-fix safeguards, and makes exactly one commit.
- A fixed finding stays listed with a "fixed" mark and its commit (short sha). It can be opened again after more commits.
- Drafts show as cards under their lines in the Files tab. Editing, approving, discarding or fixing in either view updates the other.
- The Create Pull Request dialog says when the branch still has findings that are neither fixed nor discarded.

## Non-goals

- Opening the pull request, pushing, or re-running the review after fixes on its own.
- Posting anything to GitHub from a branch review. There is no PR yet.
- Fix on a PR review's drafts of someone else's PR (the author fixes).

## Anti-goals

- A fix that commits more than one commit, amends, or touches another branch. The thread-fix rules apply unchanged.
- Findings silently dropped when the branch moves. A finding whose line is no longer in the diff shows "line moved", never disappears.

## Where it lives

- Branch context menu and the branch detail view: "Run Review Skill" and "Run Review Command" entries, next to "Create Pull Request". Active only for a local branch that is checked out in some worktree and has a base.
- Results open in the same Drafts view as a PR review, but hosted on the branch: a "Review" panel on the branch, with tabs Drafts and Files (the branch diff). My call: reuse the PR view's Drafts and Files rendering with a `PrLike` source that has no number.

## The diff and the base

- Base, in order: the branch's upstream merge-base is not used (upstream is the branch itself). The base is the GitHub default branch when a GitHub remote exists, else `main`, else `master`; the user can change it in a "Against" dropdown of the panel, remembered per branch in localStorage.
- Diff = `git diff <merge-base(base, branch)>..<branch>` run in the main checkout. Empty diff → "Nothing to review: <branch> has no changes against <base>."
- The review command gets the diff on stdin as today. Env: `GITP_BRANCH`, `GITP_BASE`, `GITP_HEAD` (the branch sha). The PR env vars are unset. The review file detection (newest review file written while it ran) works as for PRs.

## Storage

Branch findings must survive a restart (a fixed mark is worth keeping). File: `<common_dir>/gitp/branch-reviews/<branch with / replaced by %2F>.json`:

```
{ "version": 1, "branch": "feat/x", "base": "main", "head": "<sha reviewed>",
  "drafts": [ { "id": 1, "path": "...", "line": 42, "side": "RIGHT", "body": "...", "severity": "minor",
                "original": "...", "status": "pending|approved|discarded|fixed",
                "fix": { "commit": "<sha>", "worktree": "/path", "at": 1730000000000 } } ] }
```

Atomic write (.tmp + rename), damaged file deleted, pruned with the thread conversations after 60 days of no change (file mtime). Deleted when the branch is deleted through gitp. PR drafts keep their current in-memory + localStorage handling; this file is only for branch reviews.

## Fix

- Button on a pending or approved draft, in both views. Disabled with a title when: a fix is running on this branch; the branch is in no worktree; the worktree is dirty.
- Runs `fix_thread`-style core logic with a new input: instead of a thread JSON, the temp file holds the finding `{path, line, side, body, severity, diff_hunk}` plus the branch diff. Env: `GITP_FIX_WORKTREE`, `GITP_FIX_BRANCH`, `GITP_FIX_HEAD_BEFORE`, `GITP_TURN_KIND=fix`, `GITP_FINDING_PATH`, `GITP_FINDING_LINE`. Stdin: the finding body. Uses the existing Fix command from Settings (same prompt and `FIX_TOOLS`).
- Same checks as the thread fix: clean tree before, exactly one new commit, no amend, branch unchanged, clean after; undo on failure, reported.
- Success: status `fixed`, `fix` filled. The draft's `body` is unchanged. Cards show "Fixed in <7 chars>" with a link that opens the commit.
- One fix at a time per branch. Fix uses no Claude session resume: each fix is a fresh run (my call: findings are independent; a session per branch would be stale after the first commit).

## Draft cards in the diff (PR and branch)

- In the Files tab, under line N of `path` on the matching side, a card: severity tag, editable body (same composer textarea), buttons Approve / Discard (toggle back with "Restore"), and Fix when on a branch. A posted draft shows read-only with "posted".
- A draft whose anchor is not in the loaded diff is not drawn in the diff; the Drafts tab shows it with "line not in diff" as today.
- The Drafts tab gets a "Show in diff" link per draft that switches to Files and scrolls to the card.
- Shared state: the existing `pr-reviews.ts` store for PRs; the branch file for branches, loaded into the same `PrReview` shape in memory.

## Create Pull Request dialog

- When the branch's review file has drafts with status pending or approved, the dialog's sub line adds: "N review findings are not fixed or discarded." The user can still create.

## Settings

- No new command. The branch review uses the Review command / Review skill; the fix uses the Fix command.

## What's left to the builder

- Exact placement of the Review panel on the branch view, and how the Files tab is fed a branch diff instead of a PR diff.
- The diff-hunk extraction for the finding temp file.
- Test plan: core (branch diff, finding fix with the same fake-command harness as the thread fix, storage round trip and prune), GUI commands, and DOM tests for cards in both views staying in sync.
