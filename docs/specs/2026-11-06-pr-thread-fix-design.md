# Fix on a pull request thread, then push and reply all

Date: 2026-11-06

Builds on `2026-11-06-pr-thread-claude-design.md` (Check, Explain simply,
Reply with Claude, the conversation under a thread).

## Goal

Answering a review comment today takes two places: Check in gitp tells you
what the reviewer wants and which option to take, then the fix happens in a
Claude Code terminal, then back in gitp for Reply with Claude. This design
keeps the whole loop in gitp, per thread, and touches GitHub once at the end:

- **Fix** on a thread: after you chose an option in a follow-up, one click
  makes the change with a test in the pull request branch's worktree, commits
  it there, and prepares the reply for that thread.
- **Push and reply all** on the pull request: once every comment is handled,
  one confirm pushes the branch and posts every prepared reply in its thread.

Nothing reaches GitHub before that last step.

## Decisions made in the conversation

By Phuong:

- **The fix runs in the worktree or checkout that already has the pull
  request's branch.** Phuong always has one: the branch was made locally and
  the pull request opened from it. gitp never makes a worktree on its own for
  a fix.
- **Fix does three things in one click**: fix, commit, prepare the reply.
- **Per thread first, GitHub last.** Threads are checked and fixed one by one;
  at the end one action pushes everything and posts every reply.

My calls (say so if any is wrong):

- **The option comes from the last follow-up.** Fix shows only once the
  conversation has a user turn after the last Check (the chosen option). The
  fix command gets that text on stdin, as Reply with Claude does.
- **Fix refuses a dirty worktree.** With uncommitted changes in the branch's
  worktree, Fix says so and stops, so Claude's commit never sweeps up
  Phuong's own edits. (Untracked files that are gitignored don't count.)
- **A failed fix leaves nothing behind.** gitp records the worktree's HEAD
  before the run. When the command fails, is cancelled, or the checks after
  it fail, gitp runs `git reset --hard <head before>` and `git clean -fd` in
  the worktree. That is exactly "undo the run", because Fix refused a dirty
  worktree: everything that changed since the start is the run's.
- **Claude commits; gitp checks the commit.** The fix command is told to make
  one commit on the current branch with a message that names the thread
  (`fix(review): <path>:<line> — <one line>`, body with the reviewer's point
  and what changed). After the run gitp verifies: HEAD moved by exactly one
  commit, the worktree is clean, the branch is still the pull request's
  branch. Anything else fails the fix and undoes it as above.
- **The reply is a reply-draft turn**, made by a second turn right after the
  commit (the existing `reply-draft` command, with the fix's summary and
  commit in the conversation), kept in the thread's conversation file and
  shown in the Reply box. The Reply button on the thread still posts it alone
  if Phuong wants to; the normal path is Push and reply all.
- **Prepared replies are the latest reply-draft turn of each thread,** as
  edited in the Reply box. The box's text is kept per thread (unit 3's
  `replyText`); Push and reply all reads the box when it is open, else the
  turn.
- **Push and reply all lists before it acts**: the commits ahead of the
  remote (`git log @{u}..`) and each thread's reply, path:line and first
  line; one confirm; then push, then the replies in order; then reload. A
  reply that fails is reported and stays prepared; the push failing stops
  before any reply is posted.
- **The fix command's tools**: the thread tools plus `Edit`, `Write`,
  `Bash(git add *)`, `Bash(git commit *)`, `Bash(git status *)`,
  `Bash(git stash list)`, and the project's test runners (`Bash(npm test*)`,
  `Bash(npx vitest *)`, `Bash(cargo test *)`, `Bash(./gradlew test*)`,
  `Bash(mvn *test*)`, `Bash(pytest *)`, `Bash(go test *)`), under
  `dontAsk`, run with the worktree as the working directory. No push, no
  `gh`, no `git checkout`/`switch`/`reset`/`rebase`.
- **Fix is a turn kind** (`fix`), 30-minute timeout, Cancel as the others.
  A Fix turn's text is Claude's summary: the files changed, the test, the
  commit id.
- **One Fix per pull request at a time.** Two fixes in one worktree would
  edit the same tree, and the undo of one would wipe the other. The job
  lock for a fix is the pull request (repo path and number), on top of the
  thread lock; while a fix runs, every other thread's Fix is disabled with
  "A fix is running on <path>:<line>". Checks and replies on other threads
  stay free.
- **The local branch must contain the pull request's head.** Before the
  run, `git merge-base --is-ancestor <pr.head_oid> HEAD` in the worktree;
  when it fails, Fix refuses with "The local branch is behind GitHub: pull
  it first". A branch ahead of the remote is fine; Push and reply all lists
  what it pushes. The Fix turn's `head` is the new commit, so earlier turns
  on the thread show "older commit": the code did move.
- **The fix keeps its own Claude session.** Claude Code sessions belong to
  the directory they were started in, and the fix runs in the worktree while
  the other turns run in the main checkout. The conversation file gets a
  second id, `fix_session`, resumed by later fixes on the thread; `session`
  stays for the turns in the main checkout. The thread file carries the
  whole conversation either way, so each side sees the other's turns.
- **A reply posted alone is marked posted.** The thread's own Reply button
  marks the latest reply-draft turn `posted` on success, so Push and reply
  all never posts it again. A prepared reply that is not wanted after all
  gets a **Drop** link beside the "reply ready" badge, which marks the turn
  `dropped`; Clear stays for forgetting the whole conversation.

## Non-goals

- No worktree creation from Fix. "Check Out in New Worktree…" exists in the
  header for that.
- No fix on a thread whose option was not chosen; no auto-choice.
- No posting of a single reply from Fix, no push from Fix.
- No rebase, no conflict handling: a push rejected for a stale branch is
  reported as it is today.
- No "fix all" across threads in one run.

## Anti-goals

- A fix that commits Phuong's own uncommitted work.
- A fix left half done in the worktree with no commit and no undo.
- A push or a posted reply before the one confirm of Push and reply all.
- A fix that runs in the wrong checkout (the main checkout on another
  branch, say) because the pull request's branch was found nowhere.

## The pull request view

### The thread

After a Check and a follow-up that chose an option, the block's bottom row
gains **Fix** beside Clear and Send:

```
│ 🧑 you                                                                        │
│ Restore `>`                                                                   │
│ 🤖 Claude · Follow-up                                                         │
│ Yes: `>` keeps the documented count …                                         │
│                                                                               │
│ [ Ask a follow-up…                                       ] [Send] [Fix]       │
│                                                                      [Clear] │
```

While it runs: "Claude is fixing (restore `>`)…" with Cancel, the thread's
buttons disabled. When done:

```
│ 🤖 Claude · Fix · 1 minute ago                                                │
│ **Changed** src/retry.ts, src/retry.test.ts (test `retries three times`).     │
│ **Commit** a1b2c3d on feature/identity-retry: fix(review): src/retry.ts:12 …  │
│ ─ Reply ready ─────────────────────────────────────────────────────────────── │
│ Good catch — restored `>` so the documented three tries stay, in a1b2c3d.     │
```

and the Reply box opens with the draft (unit 3's rule: a confirm when the
box already holds text). The thread shows a `pr-badge` **fixed · reply
ready**. A thread with only a reply draft and no fix shows **reply ready**.

Fix is disabled with a tooltip when: no option was chosen ("Send the option
you want as a follow-up first"), the branch is checked out nowhere ("Check
the pull request out first"), another fix runs on the pull request ("A fix
is running on <path>:<line>"), the worktree is dirty ("Commit or stash the
changes in <path> first"), or the local branch is behind the pull request's
head ("The local branch is behind GitHub: pull it first"). The dirty and
behind checks happen on click, not on render.

### The header

**Push and reply all** appears next to Review with skill once at least one
thread has a prepared reply or the branch is ahead of its remote. Click:

```
Push feature/identity-retry (2 commits ahead of origin) and post 3 replies on #42?

  a1b2c3d fix(review): src/retry.ts:12 — restore `>`
  d4e5f6a fix(review): src/upload.ts:40 — cap at 30 s

  src/retry.ts:12   Good catch — restored `>` so the documented…
  src/upload.ts:40  Done: capped at 30 s in d4e5f6a.
  src/sync.ts:77    Not needed here: the sync path reads n from…

[Cancel] [Push and reply]
```

The same confirm dialog style as Post a review. Then: push (the existing
push with progress and Cancel), then each reply through the existing reply
call, then the conversation reloads; the posted threads' reply-draft turns
are marked posted (a `posted` field on the turn with the comment URL), the
badge goes, the Reply boxes close. Quick Launch gets "Pull Request: Push and
Reply All".

## What the fix command gets

Run like the thread turns (`run_shell`), but with the **worktree of the
pull request's branch** as the working directory, found by
`Repo::worktrees()` (`branch == pr.head`), the main checkout included.

| Environment | Value |
|---|---|
| everything a thread turn gets | `GITP_PR_*`, `GITP_THREAD_*`, `GITP_GH_LOGIN`, `GITP_CLAUDE_SESSION`, `GITP_TURN_KIND=fix` |
| `GITP_FIX_WORKTREE` | the worktree's absolute path |
| `GITP_FIX_BRANCH` | the pull request's branch |
| `GITP_FIX_HEAD_BEFORE` | HEAD before the run |

Stdin: the chosen option (the last user turn). Stdout: the summary in
Markdown, or `claude`'s JSON as the other turns.

Default `fix` prompt (one more line in Settings → Git, "Fix command"):
"Read the review thread in $GITP_THREAD_FILE on pull request $GITP_PR_URL;
the conversation in it ends with the option the user chose, which is also on
stdin. You are in the worktree of the pull request's branch; the tree is
clean. Make the smallest change that answers the comment, matching the style
around it. Add or update a test and run the project's test command for it.
Then commit exactly once on the current branch, with
`fix(review): <path>:<line> — <one line>` as the subject and a body that
names the reviewer's point and what changed. Do not push, do not post, do
not touch other branches. Print a short summary: the files changed, the
test, the commit id."

After the run gitp checks, in the worktree: `git status --porcelain` empty;
`git rev-parse HEAD` is one commit after `GITP_FIX_HEAD_BEFORE`
(`git rev-list --count <before>..HEAD` is 1); `git rev-parse
--abbrev-ref HEAD` is the branch. Any check failing: `git reset --hard
<before>` and `git clean -fd` in the worktree, and the turn fails with the
check's message. The fix turn stores `commit` (the new id) and `worktree`.

Then the reply draft: the `reply-draft` command as today, stdin the chosen
option, the conversation now holding the Fix turn, so the draft can name
the commit.

## Storage

The thread's conversation file gains, on a turn:

```json
{ "kind": "fix", "role": "claude", "at": …, "head": "…", "text": "**Changed** …",
  "commit": "a1b2c3d…", "worktree": "/Users/you/…/mideal-feature-identity-retry" }
{ "kind": "reply-draft", "role": "claude", "at": …, "text": "Good catch — …",
  "posted": "https://github.com/…#discussion_r123" }
```

`commit`, `worktree`, `posted` and `dropped` (a boolean on a reply-draft
turn) are optional and absent elsewhere; `fix_session` sits beside
`session` at the top. A thread counts as "reply ready" when its last
reply-draft turn has neither `posted` nor `dropped`.

## Rust and frontend shape

Core:

- `gh.rs`: `TurnKind::Fix`; `thread_claude_turn` takes an optional working
  directory and the extra environment; a new `fix_thread(gh, input,
  user_text, fix_command, reply_command) -> Result<ThreadConversation>` that
  finds the worktree, refuses a dirty one, records HEAD, runs the fix turn,
  verifies, undoes on failure, then runs the reply-draft turn.
  `run_git` in a given worktree exists (`worktree_ops`). Tests with a fake
  command that commits, one that commits twice, one that leaves the tree
  dirty, one that exits non-zero, on a temp repository with a linked worktree.
- `pr_threads.rs`: the optional fields and `fix_session`;
  `mark_reply_posted(number, thread, url)`, `drop_reply(number, thread)`.
- `gh.rs`: `push_and_reply(gh, branch, replies: &[(thread id, body)])`
  is two existing calls in sequence from the GUI; no new core function
  beyond `mark_reply_posted`.

GUI:

- Commands `gh_thread_fix`, `gh_thread_mark_posted`, `gh_thread_drop_reply`;
  `ThreadJobs` covers the fix (thread key) plus a per-pull-request fix lock.
  The existing `reply` callback calls `gh_thread_mark_posted` on success.
- `prefs.ts`: `FIX_TOOLS`, the `fix` default command, load/save.
- `pr-threads.ts`: `hasChosenOption(c)`, `preparedReply(c)`,
  `preparedReplies(repo, number)` over the loaded threads.
- `views/thread-claude.ts`: the Fix button, the Fix turn rendering, the
  badges.
- `pr-actions.ts`: `runFix` (one turn, the two-step is in core), `pushAndReplyAll`
  with the confirm listing; the header button and Quick Launch entry.
- Settings: the Fix command field.

Unit split for planning: (1) core fix turn with verification and undo;
(2) GUI command, prefs, state, Fix button and turn rendering; (3) Push and
reply all with the listing and posted marks.

## What is left to the builder

- The exact wording of the confirm listing and the badges.
- How the Reply box shows "reply ready" versus "posted" (a badge is enough).
- Whether the fix command also gets `Bash(git diff *)`-style read lookups it
  already has from the thread tools (yes, by construction).
- The 30-minute fix timeout constant's name and home.
