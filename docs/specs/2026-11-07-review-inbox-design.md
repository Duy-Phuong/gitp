# Review inbox across pull requests

Date: 2026-11-07. Decided with Phuong in chat; "my call" marks builder defaults.

## Intent

The first screen of the morning: what needs Phuong across every repo in Open Recent, so GitHub need not be opened.

## Goals

- An "Inbox" view reachable from the pull request list header and Quick Launch ("Open Review Inbox").
- One list over every repo in Open Recent that has a GitHub remote and a signed-in account. Each row names its repo.
- Two groups. **Needs you**: review requested from you; your PRs with unresolved threads; your PRs with a failed check; your PRs approved and mergeable. **Waiting on others**: your other open PRs. Draft and closed PRs are left out.
- Row: repo, number, title, author, check dot (green/red/yellow/grey), unresolved thread count, how many of those have a prepared reply or a committed-not-pushed fix (from the local thread conversations), age of last activity.
- Sort inside a group: failed check, then review requested, then unresolved threads (most first), then last activity (newest first).
- Click opens that repo (switching the open repo as Open Recent does) on that PR.
- Refreshes every 60 seconds while visible, through the same poller as the PR view, one list call per repo.
- Repos that could not be read are listed at the bottom with the reason ("not signed in", "no GitHub remote", the gh error).

## Non-goals

- Repos not in Open Recent.
- Issues, discussions, or notifications from GitHub's inbox.
- Actions from the inbox (approve, merge): open the PR for that.

## Anti-goals

- A slow first paint: rows appear per repo as each answers; a slow repo does not block the rest.
- Opening every repo's git state: the inbox reads GitHub through gh with the repo's path for the remote, and the thread conversation files by path, without loading the repo in the main view.

## How

- Core: `inbox_pull_requests(path) -> Vec<InboxPr>` per repo: `gh pr list --json number,title,author,isDraft,reviewDecision,reviewRequests,statusCheckRollup,updatedAt,mergeable,url` plus unresolved thread count via the existing thread query (one GraphQL call per repo with both). `prepared` count from reading `<common_dir>/gitp/pr-threads/<n>/*.json` for the listed PRs.
- GUI: `inbox(paths: Vec<String>)` streams results per repo as events (`inbox-repo`), so the view fills as they come.
- Frontend: `views/inbox.ts`, `inbox.ts` (pure sort/group with tests).

## What's left to the builder

- The exact gh/GraphQL query that gives review requests and unresolved counts in one call.
- How "open that repo on that PR" is wired (existing Open Recent + PR open callbacks).
- Tests: grouping and sort (pure), per-repo streaming (DOM), error rows.
