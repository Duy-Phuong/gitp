# Claude on a pull request thread: Check, Reply with Claude, Explain simply

Date: 2026-11-06

## Goal

Reviewing a pull request in gitp today has Claude in one place: "Generate
Drafts" runs a review command (or the `/review-pr-phuong` skill) over the whole
diff and loads its findings as draft comments. Everything after that — reading
what a reviewer wrote on a line, deciding whether the reviewer is right, writing
the reply — happens by hand, or by leaving gitp for a Claude Code terminal and
running `answer-pr-comments` there.

This design puts those three steps on the thread itself, in the pull request
view, so a review conversation can be handled without leaving the app:

- **Check**: what the reviewer wants, whether the problem really happens, the
  options. Then follow-up turns under the result.
- **Reply with Claude**: a drafted reply dropped into the Reply box. The user
  edits and posts.
- **Explain simply**: the thread in plain words.
- **Review with skill**: the existing skill review as a visible button in the
  pull request header, instead of a toggle in Settings.

Every conversation is kept for two months, so a Check made on Monday is still
there when the reviewer answers on Friday.

## Decisions made in the conversation

By Phuong:

- **Check runs the `answer-pr-comments` logic for one thread only**: the claim
  checked against the code, when it really happens, the options. The result
  appears inline under the thread.
- **Follow-ups**: the user can type under a Check result and Claude continues
  that conversation.
- **The conversation is stored** so it can be read later, and is **deleted
  after two months**.
- **Reply with Claude drafts a reply** from the thread and the code and puts it
  into the Reply box. The user edits it and presses Reply. **Nothing posts
  without the user.**
- Check never edits the checkout and never posts.

My calls (say so if any is wrong):

- **Explain simply is its own button**, running the `explain-simply` shape over
  the thread: bottom line, a small diagram, an example. It is a one-shot answer
  stored in the same conversation as Check, as a turn of kind `explain`.
- **Reply with Claude builds on the Check conversation** when one exists for
  the thread, so the draft reflects the option the user chose there; otherwise
  it drafts from the thread, the hunk and the file at the head commit alone.
- **Storage is a JSON file per thread in the repository's own `.git`**, under
  `.git/gitp/pr-threads/<pr number>/<root comment id>.json`. gitp already keeps
  private data in `.git` (local-history refs, undo backups), so this adds no new
  location and stays per repository. Files are not git objects: a conversation
  is a small text, and plain files are simpler to list, prune and delete than
  refs. The folder is never committed and never pushed.
- **Each turn runs `claude -p` in the background**, the way the review command
  and "Explain more" do. The first turn starts a Claude Code session and keeps
  its session id; later turns use `--resume <session id>`. When a resume fails
  (session gone, Claude Code updated), the turn runs again with the stored
  conversation sent as context, and a new session id replaces the old one.
- **The commands are shell lines in Settings** next to the review command, with
  defaults built in. The thread arrives in the environment and on stdin (see
  "What the command gets"). Anyone can replace them, as with the review command.
- **The tool list is a trimmed, read-only copy of the review skill's list**
  (`THREAD_TOOLS` in `prefs.ts`): `dontAsk`, Read, Grep, Glob, the git and `gh`
  lookups, nothing that writes. `SKILL_TOOLS` allows `Edit(review/**)`,
  `mkdir`/`rm` under `review/` and `python3`; a Check that wrote under
  `review/` while Generate Drafts runs would be picked up as the review file,
  so the thread commands get none of those. The checkout is never changed.
- **The head commit is fetched before the first turn.** A pull request opened
  in the view need not exist locally. The runner fetches `pull/N/head` into
  `refs/gitp/pr/N/head` (a private ref, like the local-history refs) when the
  head SHA is not in the repository, with the review command's cancel flag, and
  only then runs the command. The prompts read files with `git show
  $GITP_PR_HEAD:path`. A failed fetch fails the turn with the fetch's message.
- **Reply with Claude writes as the signed-in user.** The command gets
  `GITP_GH_LOGIN` (from `Gh::account`) and `GITP_PR_AUTHOR`, and the default
  prompt says "you are @login; the pull request is by @author", so the draft is
  on the right side of the conversation whether the user is the author
  answering a reviewer or a reviewer answering the author.
- **The option a reply draft builds on is the last user follow-up turn**, sent
  on stdin verbatim; empty when there is none. No picker: the thread JSON holds
  the whole conversation, so the model sees the chosen option either way.
- **Pruning** happens when a pull request view opens: every file under
  `.git/gitp/pr-threads/` whose last turn is older than 60 days is deleted,
  across all pull requests of that repository. The age is the time of the last
  turn, so a conversation that is still in use stays.
- **The Review with skill button** runs `SKILL_REVIEW_COMMAND` exactly as the
  Settings toggle does today; the toggle stays, the button only makes the
  choice visible per run. One review per pull request at a time, as now.

## Non-goals

- No fixing of code from a Check. The skill's "fix it with a test" phase stays
  in the terminal; gitp shows the options and the user decides where to act.
- No posting by Claude: not replies, not resolves, not reviews.
- No conversation across threads. Each thread has its own conversation; a
  question about two threads is asked in the terminal.
- No sync of these conversations to GitHub, the review board or any server.
- No streaming of the answer while it is written. The thread shows a spinner
  and the full answer when it arrives, as the review command does today.

## Anti-goals

Things that would make this a failure even if it works:

- A click on Check, Explain or Reply with Claude that posts anything to
  GitHub. The three are read-only toward GitHub, always.
- A Reply with Claude that posts the draft, or a Reply box that posts on
  arrival of the draft. The draft is text in a box; posting is the Reply
  button, pressed by the user.
- A conversation that leaks into git: committed, pushed, or shown in any
  branch or log view.
- A lost conversation: a Check made this week that is gone next week because
  the window closed, the tab switched, or gitp restarted.

## The pull request view

### The thread

Each line-comment thread in the Conversation and Files tabs shows, under its
comments and next to Reply… and Resolve:

```
┌ src/retry.ts:12 ─────────────────────────────────────────────────┐
│ -  if (n > 3) return;                                            │
│ +  if (n >= 3) return;                                           │
│                                                                   │
│ 🧑 anna  2 days ago                                               │
│ This now stops one retry early, is that intended?                │
│                                                                   │
│ [Resolve] [Reply…]      [Check] [Explain simply] [Reply with Claude] │
└───────────────────────────────────────────────────────────────────┘
```

A resolved thread shows only Resolve/Unresolve and Reply…, as today; the Claude
buttons come back when it is unresolved.

While a run is going, the button that started it shows a spinner and the other
two are disabled for that thread. A run on one thread never blocks another
thread. The buttons on an outdated thread (`line === null`) still work; the
command gets `original_line` and the hunk the comment was made on.

### The conversation under the thread

The first Check or Explain adds a conversation block under the comments, above
the action row:

```
│ ── Claude ────────────────────────────────────────────── Checked 2 days ago ─┐
│ **Bottom line:** the reviewer is right for n = 3, and it is a real change.   │
│                                                                               │
│   caller ──▶ retry(n) ──▶ n >= 3 ? stop ◄── one try fewer than before         │
│                                                                               │
│ **When it happens:** every call with n = 3 (src/upload.ts:40, src/sync.ts:77).│
│                                                                               │
│ | Option                       | Effect                        |             │
│ | Keep `>=`, update the docs   | 3 means 3 tries               |             │
│ | Restore `>`                  | no behaviour change           |             │
│ | No change                    | upload.ts gets 2 retries      |             │
│                                                                               │
│ 🧑 you                                                                        │
│ Restore `>`? the docs say 3 retries                                           │
│                                                                               │
│ 🤖 Claude                                                                     │
│ Yes: `>` keeps the documented count …                                         │
│                                                                               │
│ [ Ask a follow-up…                                            ] [Send]        │
│                                                                      [Clear] │
└───────────────────────────────────────────────────────────────────────────────┘
```

- Markdown is rendered the way comment bodies are, with the same code and table
  styles; ASCII diagrams are `pre` blocks.
- Every Claude turn is labelled with its kind (Check, Explain, Follow-up) and
  time; user turns show "you".
- The block is collapsed to one line ("Claude · 3 turns · Checked 2 days ago ▸")
  when the thread is drawn with a saved conversation, and opens on click, so a
  pull request with twenty checked threads stays readable.
- **Clear** deletes the file after a confirm. There is no edit of past turns.
- The follow-up box sends on Cmd/Ctrl+Enter, like the other composers.

### Reply with Claude

Opens the Reply box if it is closed and fills it with the draft, replacing
whatever was in the box after a confirm when the box was not empty. The Reply
button stays the only way to post. The draft is also stored as a turn of kind
`reply-draft` in the conversation, so the user can see what Claude proposed
after the box was edited.

### The pull request header

Next to "Generate Drafts", a **Review with skill** button with the same green
dot for new commits. It runs `SKILL_REVIEW_COMMAND` and loads the drafts like
Generate Drafts does. The Settings toggle "Use Review Skill" stays and still
decides what Generate Drafts runs; the button is a shortcut for one run with the
skill regardless of the toggle.

## What the command gets

The three commands are run with `run_shell` like the review command, in the
repository's working directory, with:

| Environment | Value |
|---|---|
| `GITP_PR_NUMBER`, `GITP_PR_REPO`, `GITP_PR_URL` | as for the review command |
| `GITP_PR_HEAD` | the head commit's SHA, fetched into `refs/gitp/pr/N/head` when missing |
| `GITP_GH_LOGIN`, `GITP_PR_AUTHOR` | the signed-in `gh` login and the pull request's author |
| `GITP_THREAD_ID` | the root comment's id (the id to reply to) |
| `GITP_THREAD_PATH`, `GITP_THREAD_LINE` | the file and the line (the original line when outdated) |
| `GITP_THREAD_FILE` | path of a temp file holding the thread as JSON (below) |
| `GITP_CLAUDE_SESSION` | the stored session id, empty on the first turn |
| `GITP_TURN_KIND` | `check`, `explain`, `followup` or `reply-draft` |

Stdin carries the user's text: empty for Check and Explain, the follow-up
question for a follow-up, and for `reply-draft` the last user follow-up turn
verbatim, when any, else empty.

The thread JSON file holds: `path`, `line`, `original_line`, `diff_hunk`, the
comments (`author`, `created_at`, `body`) in order, and the whole stored
conversation so far (`turns`), so a command that cannot resume still has the
history.

Stdout is the answer in Markdown. When the command is `claude -p
--output-format json`, gitp reads `result` and `session_id` from the JSON;
otherwise the whole stdout is the answer and no session is kept.

### Default commands

Three shell lines in `prefs.ts`, next to `SKILL_REVIEW_COMMAND`, each a
`claude -p` with `--model opus --effort medium --permission-mode dontAsk
--allowedTools "<SKILL_TOOLS>" --output-format json`, and `--resume
$GITP_CLAUDE_SESSION` when the variable is set (the shell line tests it: the
defaults are `sh -c` lines already). The prompt of each:

- **check**: "Read the review thread in $GITP_THREAD_FILE on pull request
  $GITP_PR_URL. Do phase 2 steps 1 and 2 of the answer-pr-comments skill for
  this one thread: check the claim against the code at commit $GITP_PR_HEAD
  (use `git show $GITP_PR_HEAD:path`, never the checkout), then explain it
  simply: bottom line, an ASCII flow with the place where it goes wrong, when it
  really happens with proof as file:line, a worked example, and the options in
  a table. Do not fix anything, do not post anything, ask no questions. Answer
  in Markdown."
- **explain**: "Read the review thread in $GITP_THREAD_FILE … Explain it in the
  shape of the explain-simply skill: one bottom line, one ASCII diagram, one
  example with small numbers. Do not judge whether the reviewer is right."
- **followup**: "Continue the conversation about the review thread in
  $GITP_THREAD_FILE. The user's message is on stdin. Same rules: read the code
  at $GITP_PR_HEAD, fix nothing, post nothing."
- **reply-draft**: "You are @$GITP_GH_LOGIN; the pull request is by
  @$GITP_PR_AUTHOR. Draft the reply you post in the review thread in
  $GITP_THREAD_FILE, building on the conversation in it and the option on
  stdin when there is one. Plain, short, in the first person. Print only the
  reply, no heading, no explanation."

Settings → Git shows the three lines under the review command, each with a
Reset to default, and the same note on the environment variables.

The `answer-pr-comments` and `explain-simply` skills live in the user's
`~/.claude/skills`; the default prompts name them by their shape rather than
invoking them with `/answer-pr-comments`, because the skill runs a four-phase
loop with stops for the user, and only steps 1 and 2 of its phase 2 are wanted.
A user with a different skill set replaces the lines in Settings.

## Storage

`.git/gitp/pr-threads/<pr number>/<root comment id>.json`:

```json
{
  "version": 1,
  "pr": 3426,
  "thread": 1234567890,
  "path": "src/retry.ts",
  "session": "9f3c…",
  "turns": [
    { "kind": "check",       "role": "claude", "at": "2026-11-04T09:12:00Z", "head": "a1b2c3…", "text": "**Bottom line:** …" },
    { "kind": "followup",    "role": "user",   "at": "2026-11-04T09:20:00Z", "text": "Restore `>`?" },
    { "kind": "followup",    "role": "claude", "at": "2026-11-04T09:21:00Z", "head": "a1b2c3…", "text": "Yes: …" },
    { "kind": "reply-draft", "role": "claude", "at": "2026-11-06T08:00:00Z", "head": "a1b2c3…", "text": "Good catch — …" }
  ]
}
```

- `head` on a Claude turn is the commit the answer was made against. When the
  pull request's head has moved since, the block shows "Checked against an
  older commit" with a Check again link, the way the drafts tab points out new
  commits.
- Writes are whole-file, atomic (write to a temp name, rename), done in Rust.
- Pruning: on opening a pull request view, delete every file whose last turn
  is older than 60 days, then every empty `<pr number>` folder. A read error
  (a damaged file) deletes that file too, with a line in the activity log.
- The `.git` folder of a worktree is a file pointing at the main `.git`;
  `gitp` resolves it through libgit2's `commondir`, so a conversation started in
  a worktree tab is the same one in the main tab.

## Rust and frontend shape

Core (`gitp-core`):

- `pr_threads.rs`: the JSON type, `load(number, thread)`, `save`, `delete`,
  `prune(now)`, keyed on the repository's common dir. Unit-tested on a temp
  repository: save then load, prune by last-turn age, damaged file deleted.
- `gh.rs`: `thread_claude_turn(number, thread, kind, user_text, command)`:
  fetches the head when it is missing, builds the temp JSON file and the
  environment, runs the command through `run_shell`
  with the review command's cancel flag and a 20-minute timeout, parses the
  JSON output when the command is a `claude -p --output-format json` (detected
  by the output starting with `{`), appends the turn and saves. Tested with a
  fake command (a `printf` of fixed JSON, as the review command tests do).

GUI (`gitp-gui`):

- Commands `gh_thread_turn`, `gh_thread_conversation`, `gh_thread_clear`,
  `gh_thread_prune`, mirroring the review command's background jobs
  (`ReviewJobs` keyed by repository, pull request and thread), with cancel.
- `pr-threads.ts`: in-memory state per thread (`running`, `error`,
  `conversation`), with listeners, like `pr-reviews.ts`, so switching tabs while
  a Check runs keeps it, and the badge on the sidebar counts running thread
  turns together with running reviews.
- `views/pull-request.ts`: `threadNode` gains the three buttons, the
  conversation block, the follow-up composer, and the Reply with Claude fill.
  Keep the function small: the block is its own function, `conversationNode`.
- `views/settings-dialog.ts`: the three command fields.
- `prefs.ts`: `THREAD_TOOLS`, the three default commands and their load/save,
  like the review command.

Tests, as the project does them: frontend unit tests for the storage shape
mapping and the Reply box fill (`pull-request.test.ts` exists? if not, test the
pure helpers), Rust tests for storage and the command runner.

## What is left to the builder

- Exact styling of the conversation block and the three buttons; follow the
  thread's existing classes (`pr-thread-actions`, `pr-badge`) and the drafts
  tab's colours.
- Whether the Files tab's inline threads show the full block or only the
  collapsed line with "open in Conversation"; either is fine, the collapsed line
  is enough.
- The detection of a resumable session vs. a plain command: the output check is
  the simplest; a Settings checkbox is not wanted.
- The wording of the confirm on Clear and on replacing a non-empty Reply box.
