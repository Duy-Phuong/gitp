# Claude jobs: see, follow and stop every Claude run

Date: 2026-11-06

## Goal

gitp runs Claude Code in the background in four places: Generate Drafts and
Review with Skill on a pull request, Explain more on a finding of a saved
review, the turns on a pull request thread (Check, Explain simply, a
follow-up, Reply with Claude), and Fix on a thread. Each run is a
`/bin/sh -lc "claude -p …"` with no window. Today you can stop a run only
from the place that started it, and you can't see what it is doing until it
ends.

Phuong wants this for two reasons:

- **Catch a run that is going wrong.** It runs too long or uses too many
  tokens, and you stop it.
- **Know what is running and how it is going.** Which runs are going, in which
  repository, for how long, how many tokens so far, and the conversation
  itself: what Claude says and which tools it calls, live, and in full after
  the run ends.

The result is one list of Claude jobs inside gitp, with each job's
conversation, a Stop button, and a prompt before you quit while jobs run.

## Decisions made in the conversation

By Phuong:

- **Everything stays inside gitp.** A button that opens the session in a
  terminal (`claude --resume`) is not user friendly and is not part of this
  design.
- **Show the detail, stop it, and read it after it ends.** A running job can be
  stopped. A finished job keeps its conversation and result to read.
- **The conversation is visible**: the prompt, Claude's messages, the tool
  calls. It is not only a summary line.
- **No automatic limits.** gitp shows the time and tokens and Phuong decides
  when to stop. The time limits that already exist stay as they are (see
  Current state).
- **Quitting with jobs running asks first.** "2 Claude jobs are running. Stop
  them and quit?" Stop and quit, or Cancel.
- **Finished jobs stay for 7 days** (changed on 2026-11-06; it was today only).
- **Both ways in** (from the mockups):
  - A **"Claude" button right after "PRs"** in the History action toolbar opens
    the full jobs page in the main area, the way PRs opens the pull request
    list.
  - A **"● N Claude jobs" chip in the status bar**, visible from any tab, opens
    a bottom panel, the way the Terminal panel opens.
- **A follow-up in a PR thread continues the same session**, so it shows in the
  same conversation in the jobs view.

Claude's calls, made during the conversation and shown to Phuong, who can
change them:

- **One row per thread**, not one per turn. A new turn moves the row back to
  Running. The conversation shows every turn in order.
- **The jobs view is read-only.** You write follow-ups in the PR thread, where
  they already work.
- **The list shows jobs from every repository**, not only the open one.
- **The status-bar chip is hidden when no job runs.** The toolbar button stays,
  and its badge is hidden when no job runs.
- **"7 days" means today and the 6 days before it**, from local midnight. A
  job stays while its last turn is in that window, also across a restart.
- **gitp gives each fresh run its session id up front** and reads Claude Code's
  own transcript file live. The commands in Settings keep working (see 2).

Claude's calls, made after the builder check, not yet seen by Phuong:

- **Fix is a turn of its thread's row**, not a row of its own. One Fix is two
  runs: the fix command in the PR worktree on the thread's `fix_session`, then
  the reply command in the main checkout on `session`. Both show in the
  thread's conversation, merged by time. The row's activity reads "Fix".
- **Subagents count.** A skill review dispatches subagents. Claude Code writes
  each one to `<dir>/<session>/subagents/agent-*.jsonl`, apart from the main
  file. Their tokens go into the job's totals, so a skill review isn't
  understated. Their steps are not shown inline: the main file's Agent call and
  its result stand for them.
- **The saved index also keeps** the shell command, the size of the stdin (not
  the stdin itself, which for a review is the whole diff), and the final output
  capped at 64 KB. A finished job can then still show its result after a
  restart, or once its transcript is gone.
- **A thread row's numbers cover its turns of the kept 7 days.**
  - Time is the sum of the row's turn durations, and the running turn counts up.
  - Tokens count from the job's start.
  - The conversation still shows the whole session. Turns from before the
    job's start are marked "Earlier".
- **gitp keeps the transcripts of only the last 3 jobs opened in memory**, and
  of every running job. A job opened again reads its transcript again. With a
  week of jobs, clicking through old ones would otherwise keep adding up: a
  big review's transcript can be tens of MB.
- **Thinking shows only as a folded "Thinking" line.** Claude Code keeps its
  text empty.
- **Stop and quit waits for each job's call to return**, not only for the
  kill. A stopped Fix then finishes putting its worktree back first.

## Non-goals

- Starting a Claude run from the jobs view, or typing to Claude there.
- Opening a run in a terminal or in the Claude app.
- Token or cost budgets that stop a run by themselves.
- Jobs older than 7 days, and a search over old jobs.
- Claude runs started outside gitp (a terminal, the Claude app).
- Finding and killing runs left over after gitp crashed (see 4).

## Anti-goals

These would make the feature a failure even if it works:

- **A token count that is wrong.** Claude Code writes one transcript line per
  content block, and every line of one API message repeats that message's
  `usage`. A reader that adds them all counts the same message 2 to 4 times.
- **The UI freezing on a long run.** A review can run for an hour and read
  large files. The view must not reload the whole transcript every second.
- **A Stop that leaves `claude` running.** Stop must end the whole process
  group, the way Cancel does today.
- **A saved custom command that stops working.** Commands in Settings that
  don't use the new session id must still run as before.
- **Quit without the prompt** when a job runs: ⌘Q, the window's close button,
  and the menu all ask.

## Current state

All references are on `main` at f7fee9f.

| Job | Entry (gitp-gui `src/gh.rs`) | Registry today | Runs in | Time limit (core `src/gh.rs`) | Session |
|---|---|---|---|---|---|
| Generate Drafts, Review with Skill | `gh_generate_review_impl` → `generate_review_drafts` | `ReviewJobs`, by (repo, PR), cancel flag | repo workdir | `REVIEW_TIMEOUT`, 60 min | fresh each run |
| Explain more on a finding | `explain_review_finding_impl` → `explain_review_finding` | **none: no Cancel** | repo workdir | `EXPLAIN_TIMEOUT`, 20 min | fresh each run |
| Thread turn: Check, Explain, Follow-up, Reply | `gh_thread_turn_impl` → `thread_claude_turn` / `run_turn` | `ThreadJobs`, by (repo, PR, thread), cancel flag | repo workdir | per turn | `--resume` the thread's `session` |
| Fix on a thread | `gh_thread_fix_impl` | `ThreadJobs` and `FixJobs` (repo, PR) | the PR branch's worktree | `FIX_TIMEOUT`, 30 min | `--resume` the thread's `fix_session` |

- Every job goes through `run_shell` (core `gh.rs`). It starts its own process
  group (`process_group(0)`) and kills the group on a cancel or a timeout.
- The default commands are in `webui/src/prefs.ts`: `DEFAULT_REVIEW_COMMAND`,
  `SKILL_REVIEW_COMMAND`, `EXPLAIN_FINDING_COMMAND`, `DEFAULT_THREAD_COMMANDS`
  and the fix command. The thread commands already contain
  `${GITP_CLAUDE_SESSION:+--resume "$GITP_CLAUDE_SESSION"}`. A user can
  replace any of them in Settings.
- `run_turn` retries once as a fresh run when Claude Code has forgotten the
  kept session, and it saves the session id from the JSON answer
  (`claude_answer`).
- `gitp-gui/src/lib.rs` has no handler for the app quitting. A running job's
  process group is not a child group of the app, so it keeps running after a
  quit.
- The UI: the History action toolbar is in `webui/index.html` (`#prs-btn`
  opens `showPullRequestList`). The views are `#…-view` sections that
  `shell.ts` switches between with `state.view`. The status bar is
  `#statusbar`. The Terminal panel (`setupTerminalPanel`) is the model for a
  bottom panel. Without Tauri, `api.ts` falls back to mock data for `vite dev`.

### What Claude Code writes (checked on this machine)

- A `claude -p` run writes its transcript to
  `~/.claude/projects/<dir>/<session-id>.jsonl` while it runs, unless
  `--no-session-persistence` is given. `<dir>` is the run's working directory
  with every `/` and `.` turned into `-`, for example
  `-Users-phuong-Documents-developer-private-source-mideal`.
- `--session-id <uuid>` sets the id of a new session. `--resume <id>` keeps the
  same id and adds to the same file. `--fork-session` is what would make a new
  id.
- The lines gitp needs, one JSON object per line:
  - `type: "user"` with `message.content` as a string: the prompt, or the text
    typed for a follow-up.
  - `type: "assistant"` with `message.content` blocks of type `text`,
    `thinking` or `tool_use` (`name`, `input`), and `message.id` and
    `message.usage` (`input_tokens`, `cache_creation_input_tokens`,
    `cache_read_input_tokens`, `output_tokens`). The same `message.id` appears
    on several lines.
  - `type: "user"` with `tool_result` blocks: the tool output. The line's
    `toolUseResult` has more detail.
  - Each line has `timestamp` and `sessionId`.
  - There are many other types (`attachment`, `api-request`, `cost-state`,
    `queue-operation` and more). The reader skips any type it doesn't know.

## Design

### 1. One job registry (gitp-gui)

A new `ClaudeJobs` state takes over from `ReviewJobs` and `ThreadJobs`, and
Explain more joins it. Each job has:

- `id`: gitp's own id.
- `kind`: review, explain-finding or thread. A Fix is a turn of a thread job.
  The review's label says whether it was Generate Drafts or Review with Skill.
- `label`: for example "Review with Skill · #3426", "Explain more · finding 3 ·
  #3401", or "Check · OrderService.java:88 · #3426".
- `repo`: the path, and a name for display.
- `pr`, plus `thread` for thread and fix jobs, plus `finding` for Explain more.
- `state`: running, done, failed, stopped or interrupted.
- `started`, `ended`, the error text on a failure, and the cancel flag.
- `sessions`: the Claude session ids it ran, with the directory each ran in.

The rules stay the same:

- One review per (repo, PR).
- One turn per thread at a time.
- The fix lock per (repo, PR) stays as `FixJobs`.

The existing Cancel buttons and the new Stop button set the same flag, so the
messages ("Claude's turn on … cancelled") don't change.

**A thread is one job across its turns.** The job's key is (repo, PR, thread).
A new turn on a thread finds the thread's job while the list keeps it (its
last turn in the last 7 days), adds a turn and sets the job back to running.
A thread job's `sessions` can hold two ids: the conversation session and the
fix session. A thread whose last turn has left the 7 days starts a new job. Its
conversation still shows the earlier turns from the session file, which is
fine.

Explain more now gets a cancel flag through `set_network_hooks`, like the
others, and so it also gets a Stop.

### 2. The session id up front

To read a fresh run's transcript live, gitp must know the session id when the
run starts. The current answer gives the id only at the end.

- For every run, gitp makes a new UUID and sets `GITP_CLAUDE_NEW_SESSION` to it.
- The default commands use it on a fresh run with `--session-id`. A resumed
  run keeps `--resume "$GITP_CLAUDE_SESSION"`, and because the id stays the
  same, gitp already knows it.
- The retry in `run_turn` (a forgotten session, run again fresh) needs its own
  new UUID.
- In `SKILL_REVIEW_COMMAND` and `EXPLAIN_FINDING_COMMAND`, the flag must come
  **before** `--allowedTools`, which takes every word after it. The test in
  `prefs.test.ts` guards this and must cover the new flag.
- **A command that doesn't use the variable** (an older saved default, or a
  user's own command) still runs. Its job shows the time, Stop, and "No live
  conversation: this command doesn't pass `--session-id
  "$GITP_CLAUDE_NEW_SESSION"`". When it ends with a JSON answer that has a
  `session_id`, gitp links that session, and the conversation shows after the
  run.
- **How the default commands say "new id when not resuming"** in shell is the
  builder's call. Two possibilities are a second `${…}` form, or gitp setting
  one ready-made variable such as `GITP_CLAUDE_SESSION_ARGS`. Saved commands
  equal to an old default must keep working. Settings may offer to update
  them.

### 3. Reading the transcript (gitp-core or gitp-gui)

- **Finding the file.** Look for `~/.claude/projects/*/<session-id>.jsonl`. A
  glob on the session id is enough, so gitp doesn't need to copy Claude Code's
  directory naming. Until the file exists (the first seconds of a run), the job
  shows "Starting…".
- **Reading incrementally.** Read from the last byte offset, and parse only
  complete lines. A partial last line waits for the next read.
- **Events for the UI**, in file order:
  - the prompt or the user's text
  - Claude's text
  - thinking
  - a tool call: name, a one-line summary of the input (the Bash command, the
    Read path, the Grep pattern, the Skill name), the full input, and a link to
    its result
  - a tool result: ok or error, and the output
  - the end of a turn
- **Tokens.** Count each `message.id` once. The headline is the sum of all four
  usage fields. The detail line shows input (with the cache share) and output.
  A thread job shows the running turn's tokens and the total for the thread.
- **Sizes.** An event that goes to the UI carries at most a fixed size of tool
  output, about 4 KB. The UI then shows "… N more lines · show all". "Show all"
  asks for that one result in full.
- **A thread with a conversation session and a fix session**: merge both files
  by timestamp.
- **A missing file** (Claude Code removed old sessions, or the run used
  `--no-session-persistence`): "The conversation is no longer available." The
  row and its result stay.

How the frontend gets updates is the builder's call. A simple way: poll a
`claude_jobs()` command every second or two while any job runs, and poll
`claude_job_events(id, after)` only while that job's conversation is open. A
Tauri event pushed from the job thread would also work.

### 4. The week's list across a restart

- gitp saves the jobs index (everything in section 1 except the cancel flag) as
  a small JSON file in the app's data directory each time a job changes. It
  does not copy any transcript: the conversation is always read from Claude
  Code's file.
- At start, gitp loads the jobs whose last turn is in the last 7 days and
  drops the rest. A job that leaves the window while gitp runs leaves the list
  and the file too.
- A job saved as running from a previous launch shows as **interrupted**.
  gitp doesn't try to find or kill its process: after a normal quit the prompt
  in 5 already stopped it, and after a crash this is a non-goal.

### 5. Quitting with jobs running

- Catch every way to quit: ⌘Q, the app menu, and closing the last window. In
  Tauri v2 these are `RunEvent::ExitRequested` and the window's
  `CloseRequested`. If no job runs, quit as today.
- If jobs run, stop the quit and show the dialog: "2 Claude jobs are running.
  Stop them and quit?" with **Stop and quit** and **Cancel**. The dialog lists
  the jobs' labels when there are three or fewer.
- Stop and quit: set every cancel flag, wait until each `run_shell` has killed
  its group (a few seconds at most), save the index, then exit.

### 6. The views (webui)

**The toolbar button.**

- "Claude" goes right after "PRs" in the History action toolbar, with an icon
  in the toolbar's style (the mockup used a sparkle).
- A badge shows the number of running jobs, like `#pull-badge`, and is hidden
  at 0.
- It opens a new `#claude-view` in the main area. That view has a "Claude jobs"
  header, a line like "2 running · 3 finished today · 9 earlier this week", and
  "← Back to history".

**The status-bar chip.**

- "● N Claude jobs" goes at the right of `#statusbar`, shown only while a job
  runs.
- It opens a bottom panel like the Terminal panel, with "Open full page ⤢" and
  ✕.
- "Open full page" switches to `#claude-view` with the same job selected.

**The same list and conversation in both places.**

- **The list**, on the left. "Running" comes first, then one section per day
  of the jobs' last turns: "Today", "Yesterday", then dates like "Wed, 4 Nov".
  Newest first. Times outside today show their day too.
  Each row has:
  - a state dot: running blue and pulsing, done green, failed red, stopped and
    interrupted grey
  - the label, with the repo name when it isn't the open repository
  - the time it ran or is running, counting up while it runs
  - the tokens so far
- **The conversation**, on the right:
  - **Header**: the label. **Stop** while it runs. **Open thread ↗** or **Open
    review ↗** opens the PR view at the thread or review (and switches repo if
    needed).
  - **Meta line**: the repo, when it started (and ended), how long it ran, and
    the tokens (in, cache, out).
  - **The prompt gitp sent**, folded to three lines. "Show the full command"
    shows the shell line and the stdin it got.
  - **Claude's messages in full**, as Markdown with the renderer the PR view
    already uses. Each has its time and tokens.
  - **Tool calls** as one row each: the name, the input summary, and ✓, ✗ or
    "running…". Click a row to open its input and output.
  - **Thinking**, folded: "▸ Thinking (146 tokens)".
  - **For a thread**: each turn begins with what was sent: the first prompt, or
    the text typed in the thread.
  - **The end**: the final answer highlighted, or the error, or "Stopped by you
    at 10:47", or "Interrupted: gitp quit while this ran".
- **Following the run.** New events come in at the bottom. The view scrolls
  with them only while you are at the bottom, so reading higher up is never
  disturbed.

**The mock.** `api.ts` has mock jobs and mock events, so the views can be
built and checked with `vite dev` in the browser.

### 7. Tests

- **Core / reader**:
  - A fixture transcript with repeated `message.id` lines gives the right
    token total.
  - A partial last line is held back until it is complete.
  - Unknown line types are skipped.
  - Two session files merge by timestamp.
  - A missing file gives the "no longer available" state.
- **gitp-gui registry**:
  - A second review of the same PR is refused, as today.
  - A second turn on a thread updates the same job.
  - Stop sets the flag the run sees, and the job ends as stopped.
  - Explain more can be stopped.
  - The index round-trips, and yesterday's jobs are dropped.
  - A job saved as running loads as interrupted.
- **Commands**:
  - The defaults pass `--session-id "$GITP_CLAUDE_NEW_SESSION"` on a fresh run
    and `--resume` on a kept one.
  - The flag sits before `--allowedTools`.
  - A command without the variable still runs, and its job has no live
    conversation.
- **Webui**:
  - The list orders and labels rows correctly.
  - The badge and the chip are hidden at 0.
  - Following the run stops when you scroll up.
  - Show all asks for the full result.
- **Quit**: a unit test of the decision. No job running means quit now. Jobs
  running means ask; then Stop means cancel all and quit, and Cancel means
  keep running.

## As built

- **Reader** in gitp-core: `claude_transcript.rs`. **Registry** in gitp-gui:
  `claude_jobs.rs`. **UI**: `claude-jobs.ts`, `views/claude-jobs.ts` and
  `claude-jobs-model.ts`.
- **Session id.** `run_shell` sets `GITP_CLAUDE_NEW_SESSION`, empty on a
  resume. It reports the session through a new `NetworkHooks::on_claude_run`.
  The default commands add
  `${GITP_CLAUDE_NEW_SESSION:+--session-id "$GITP_CLAUDE_NEW_SESSION"}`. Saved
  commands equal to a default were never stored (`save…` drops them), so
  they pick up the change by themselves.
- **Polling.** The frontend polls `claude_jobs` every 1.5 s. It reads
  `claude_job_events` only for the job on screen: while it runs, and once
  more after each change of state.
- **Open thread ↗ / Open pull request ↗** switches to the job's repository
  when it is open in a tab, then opens the pull request view. It does not
  scroll to the thread.
- **The panel and the Terminal panel** can be open at the same time, stacked.
- **Tool input and output** in an event are cut at 4 KB.
- **Quit** is caught on `RunEvent::ExitRequested` and on the window's
  `CloseRequested`. It has not been checked in the native app: the GUI can't
  be run from the build sandbox.

## Left to the builder

- Where the transcript reader lives: gitp-core, next to `run_shell`, or
  gitp-gui.
- Polling or pushed events, and how often.
- The exact shell form of "new id when not resuming" in the default commands,
  and whether Settings offers to update an old saved default.
- The icon, and the exact colours (use the theme's tokens in `styles.css`).
- Whether the bottom panel and the Terminal panel can be open at the same time,
  or share the space with tabs.
- The size of the output that goes in an event.
- Whether "Open thread ↗" switches repo by itself or asks first.
