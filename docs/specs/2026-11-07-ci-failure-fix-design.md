# CI failure to fix

Date: 2026-11-07. Decided with Phuong in chat; "my call" marks builder defaults.

## Intent

When a check on a pull request goes red, Phuong copies the log into Claude, asks what broke, and lets it fix. This feature does that from the Checks tab: Check on a failed check pulls the failed job's log, runs the same Check turn a thread gets, shows the result inline, allows follow-ups, and offers Fix in the branch's worktree. The fix is committed but not pushed; Push and reply all sends it with the other fixes.

## Goals

- Each failed check in the Checks tab has Check, and once a conversation exists, the same conversation block as a thread: Explain simply, follow-up, Fix, Clear, Try again, Cancel.
- The log is fetched through gh, reduced to the failed steps, cut to the last part, and given to Claude.
- Conversations are stored and pruned like thread conversations, keyed by check name.
- Fix uses the thread fix machinery unchanged. The card shows "fixed in <sha>, not pushed yet" until the head moves past the commit.
- Push and reply all includes these commits in its listing (they are on the branch anyway) and needs no reply for them.

## Non-goals

- Pushing after the fix (Phuong: wait).
- Re-running the check on GitHub.
- Checks that are not GitHub Actions jobs (external statuses): they get Check with only the check name, state and URL as input, no log.

## Anti-goals

- Feeding a multi-megabyte log into the prompt. Hard cap below.
- A Fix that runs without a chosen option. The same rule as threads: the last user follow-up is the option.

## Getting the log

- `gh run view <run id> --job <job id> --log-failed --repo <repo>` when the check is a GitHub Actions check run. The run and job ids come from the check's `detailsUrl` (`/actions/runs/<run>/job/<job>`); the Checks data gains `details_url` from `statusCheckRollup` if not there yet.
- Keep the output; if longer than 64 KB, keep the last 64 KB and prefix "… earlier lines cut …". The full log is written to the temp dir next to the thread file and its path is given as `GITP_CI_LOG_FILE`, so Claude can read more.
- A check with no run URL, or `gh run view` failing: the Check still runs with what is known and says the log could not be read.

## The turn

- Reuses `run_turn` with a new `TurnKind::Check` on a `ThreadInput`-like `CheckInput { number, head, check_name, state, url, log_excerpt }`. The temp JSON file holds that instead of comments. Env adds `GITP_CHECK_NAME`, `GITP_CHECK_URL`, `GITP_CI_LOG_FILE`; `GITP_THREAD_ID` is `check:<name>`.
- Default command: a new "CI check command" in Settings → Git, same shape as the Check command, with a prompt that asks for: the failing step, the first real error, whether the code or the pipeline is at fault, and the options. Tools: `THREAD_TOOLS`.
- Follow-up, explain, fix and reply-draft: reply-draft is skipped for checks (nothing to reply to). The fix ends after the commit.

## Storage

`<common_dir>/gitp/pr-threads/<pr>/check-<sanitized name>.json`, same `ThreadConversation` shape with `thread` = `check:<name>`, same prune and clear. The conversation is tied to the PR number; a new run of the same check keeps the conversation and the Check button says "Check again" when the head or the run id changed since the last Check.

## UI

- Checks tab: each failed row gets the thread buttons; the conversation block renders under the row with `conversationNode`. Badges: "fixed" while the commit is on the branch and not pushed; the badge clears once the head on GitHub contains it.
- The Fix button's disabled reasons are the thread ones (worktree, dirty, behind GitHub, running).

## Settings

- "CI check command" row next to the thread commands, with the same blank-restores-default rule.

## What's left to the builder

- Parsing the Actions URL and the shape of `statusCheckRollup` for the job URL.
- Where the "contains the commit" check runs (one `merge-base --is-ancestor` against the fetched PR head).
- Tests: log cut, URL parse, check turn with the fake command, fix on a check, conversation storage key, DOM for the Checks tab block.

## Decisions after the builder check

- **Commands (my call):** one new setting, "CI check command", used for the Check turn on a check. Explain, follow-up and Fix reuse the thread commands; their default prompts become neutral ("the review thread or CI failure in $GITP_THREAD_FILE"), and the fix prompt's commit subject reads `fix(ci): <check> — <what>` when `GITP_CHECK_NAME` is set, else the thread form.
- **Key (my call):** workflow name plus job name when both are known (`<workflow> / <job>`), else the check name. `PrCheck` gains `workflow: Option<String>` from `statusCheckRollup.workflowName`. The file name is the key hashed to 16 hex characters, with the key kept inside the file, so no collisions.
- **Storage (my call):** `ThreadConversation.thread` becomes a string in version 2; files of version 1 load by converting the number to its text; `path` becomes optional. New optional fields `run_id` (per check turn) and `title`. `run_turn` and `fix_thread` are generalised over a `TurnSubject { Thread(ThreadInput) | Check(CheckInput) }`; the fix on a check skips the reply-draft. The frontend key becomes a string.
- **Rows (my call):** the block renders on any check row that has a conversation, failed or not; a conversation whose check is gone from the rollup is listed under "Earlier checks" at the bottom of the tab with the block, so nothing is orphaned. The "fixed" badge clears when the fetched PR head contains the commit, on any row.
- **Log (my call):** fetched once per Check turn and kept as `<common_dir>/gitp/pr-threads/<pr>/<file>.log`, overwritten on the next Check, pruned with the conversation. Follow-ups and Fix get `GITP_CI_LOG_FILE` pointing at it.
