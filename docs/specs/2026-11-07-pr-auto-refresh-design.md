# Pull request view refreshing on its own

Date: 2026-11-07. Decided with Phuong in chat; "my call" marks builder defaults.

## Intent

The PR view goes stale when a push lands from another session, a reviewer comments, or CI finishes. Phuong wants the view to refresh itself rather than a badge to click.

## Goals

- While a pull request view is open and the window is focused, gitp polls GitHub every 30 seconds (my call) with the cheapest call that returns head sha, updatedAt, the thread count/resolution, and the check rollup.
- When something changed, the full detail is reloaded and the view redraws, keeping scroll position, open tabs, open conversation blocks, and any text typed in a Reply box, follow-up or the bottom composer (the existing redraw rules).
- A one-line notice at the top for 10 seconds: "Updated: new commits · 2 new comments · checks finished", whichever apply.
- The PR list polls the same way at 60 seconds while it is the visible view, updating rows in place.
- Polling pauses when the window loses focus or the app is hidden, and resumes with an immediate poll on focus.

## Non-goals

- Live updates through webhooks or GraphQL subscriptions.
- Refreshing the Files tab diff while the user is in the middle of a line selection or a draft card edit: the redraw waits until the edit box loses focus, then applies.

## Anti-goals

- Noise: a poll that finds nothing must not redraw, flash, or move the scroll.
- Hidden rate-limit trouble: a 403 rate-limit answer stops polling for 10 minutes and shows "GitHub rate limit, polling paused" in the notice line.

## How

- Core: `pull_request_signature(number) -> PrSignature { head, updated_at, threads: Vec<(id, resolved)>, checks: Vec<(name, state)> }` via one `gh pr view --json headRefOid,updatedAt,reviewThreads,statusCheckRollup` (reviewThreads through the GraphQL call already used for threads, kept to ids and resolution).
- GUI: a `pollSignature` command; the view keeps the last signature and compares.
- Frontend: a `poller.ts` module with `startPolling(key, intervalMs, tick)` that handles focus/visibility and one timer per key; the PR view and the PR list each register. A running thread turn or fix on this PR does not stop polling; a redraw during a turn keeps the running line.
- The notice line is `el("div", {class: "pr-refresh-notice"})`, removed after 10 seconds or on click.

## Performance

One call per 30 s per open PR view, one per 60 s for the list; about 180 calls an hour against GitHub's 5000. Each call runs in the background thread as fetches do. No polling while unfocused.

## What's left to the builder

- Whether `gh pr view` with those fields is one API call or two; if two, use the GraphQL query already in `gh.rs` for threads with the extra fields.
- Tests: signature compare (pure), poller focus/visibility behaviour (DOM test with fake timers), redraw keeping typed text (extend existing tests).
