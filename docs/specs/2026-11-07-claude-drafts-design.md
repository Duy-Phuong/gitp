# Commit message and pull request drafts with Claude

Date: 2026-11-07. Decided with Phuong in chat; "my call" marks builder defaults.

## Intent

Phuong lets Claude Code create pull requests with a description and then checks them. This moves that into gitp: a "Draft with Claude" button in the commit composer and in the Create Pull Request dialog fills the text, Phuong edits and presses Commit or Create. Nothing is committed or created on its own.

## Goals

- Commit composer: Draft with Claude reads the staged diff (or the files about to be committed) and the last 20 subjects of the branch, and drops a message in the box: a subject in the repo's style and a short body.
- Create Pull Request dialog: Draft with Claude reads the commits ahead of the chosen base and their diff, and fills the Title and Description. It follows the repo's pull request template when one exists, and the description ends with a "Checks" list of what to verify (Phuong's "+ check").
- Both ask before replacing text the user typed, and show "thinking…" with a Cancel while running. A failure shows under the box with Try again.
- Both commands are editable in Settings → Git: "Commit message command" and "Pull request draft command".

## Non-goals

- Committing, pushing or creating on Claude's behalf.
- Rewriting an existing commit's message.
- Running the review before creating the PR: that is the fix-before-review feature; this dialog only mentions unresolved findings.

## Anti-goals

- A draft that lands over what the user typed without asking.
- A draft that takes longer than the user's patience without a way out: both have Cancel, timeout 5 minutes.

## Inputs to the commands

Commit message: stdin = `git diff --cached` (if nothing is staged: the diff of the selected changes the composer will commit; if that is empty, the button is disabled with "Stage something first"). Env: `GITP_BRANCH`, `GITP_RECENT_SUBJECTS` is not an env var; the subjects go in a temp file given as `GITP_LOG_FILE` (my call: env values stay short). Output: plain text, first line the subject, blank line, body. Trailing whitespace trimmed. Output over 2000 characters is cut.

Pull request: stdin = `git log --format=... base..branch` followed by `git diff base...branch`, cut to 400 KB from the end of the diff with a note. Env: `GITP_BRANCH`, `GITP_BASE`, `GITP_PR_TEMPLATE_FILE` when a template exists. Output: JSON `{"title": "...", "body": "..."}`; a non-JSON output is used as body with the first line as title (my call: tolerate a plain answer).

Both commands run with `claude -p --model opus --effort medium --permission-mode dontAsk --allowedTools "<read-only tools>" --output-format json`, as the thread commands, through `threadCommand`, and in the main checkout. No session resume.

## UI

- Commit composer: a small "Draft with Claude" button in the composer's toolbar row, left of the preview toggle. While running the button turns into "Cancel"; the box stays editable.
- Create Pull Request dialog: a "Draft with Claude" button next to the Description label. The title is filled only when empty or equal to the default branch-name title; the description asks before replacing non-empty text. The dialog stays open during the run. The form dialog gains an optional per-field action button for this.

## Settings

Two rows under the thread commands. Blank restores the default.

## What's left to the builder

- Which tools go in the allow list (read-only: Read, Grep, Glob, Bash(git log *), Bash(git diff *), Bash(git show *)).
- The form-dialog extension for a field action button.
- Tests: core (diff/log inputs, output parse incl. non-JSON, cut), GUI commands, DOM tests for the confirm-before-replace and cancel.
