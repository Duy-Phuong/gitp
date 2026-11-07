# Claude drafts, unit 1: core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** gitp-core can run a commit-message command over the staged diff and a pull-request draft command over a branch's commits and diff, and parse what they print into a subject/description or a title/description.

**Architecture:** A new module `crates/gitp-core/src/drafts.rs` with two `Repo` methods. Both build stdin and env, run the command through the existing `run_shell` (login shell, process group, `NetworkHooks.cancel`, timeout) in the open repository's working directory, read a `claude -p --output-format json` answer through `claude_answer`, and parse it. No session resume, no Claude job.

**Tech Stack:** Rust, the git CLI through `git_in` / a raw-stdout variant, serde_json.

**Spec:** `docs/specs/2026-11-07-claude-drafts-design.md` (its "Decisions after the builder check" win).

## Global Constraints

- `DRAFT_TIMEOUT` = 5 minutes; `DRAFT_DIFF_LIMIT` = 400 KB (400 * 1024 bytes); `COMMIT_MESSAGE_LIMIT` = 2000 characters.
- Commit message stdin: `git diff --cached`; Amend: HEAD's diff plus what is staged (`git diff --cached HEAD^`, or against the empty tree for a root commit). Empty → `Stage something first.` and the command never runs.
- Commit env: `GITP_BRANCH` (short branch name, `HEAD` when detached); `GITP_LOG_FILE` = a temp file with the last 20 subjects (`git log -20 --format=%s`), removed after the run.
- Commit output: first line → subject, rest (leading blank lines dropped) → body; trailing whitespace trimmed; output over 2000 characters cut.
- PR stdin: `git log base..branch` (hash, subject, body per commit) then `git diff base...branch`, the diff cut to 400 KB from its end with a note. Base rev = `refs/remotes/<GitHub remote>/<base>` when it exists, else `<base>`.
- PR env: `GITP_BRANCH`, `GITP_BASE`, `GITP_PR_TEMPLATE_FILE` (absolute path) only when one of `PR_TEMPLATES` exists.
- PR output: JSON `{"title","body"}` (also inside a ```json fence); anything else: first line (leading `#`s stripped) → title, rest → body.
- Errors of `run_shell` that say "The review command" say "The commit message command" / "The pull request draft command" instead.
- Never run rustfmt on `lib.rs`.

## Review Focus

1. A diff larger than 400 KB with multi-byte characters near the cut must not panic (Task 1: cut at a line boundary, test with `é` lines).
2. Cancel while the command runs returns `operation cancelled`, not a failure (Task 1: cancel flag already up, `sleep 5` command returns `Error::Cancelled` fast).
3. A Claude JSON answer with `is_error: true` fails with its text, not a draft of the error JSON (Task 1 and Task 2).
4. Amend on a repository with a single (root) commit still works (Task 1).
5. A branch with no commits ahead of the base refuses without running the command (Task 2).

---

### Task 1: Commit message draft

**Files:** Create `crates/gitp-core/src/drafts.rs`; modify `crates/gitp-core/src/lib.rs` (`mod drafts;`, `pub use drafts::{CommitDraft, DRAFT_TIMEOUT};`), `crates/gitp-core/src/gh.rs` (`PR_TEMPLATES` → `pub(crate)`).

**Interfaces — Produces:**
- `#[derive(Debug, Clone, PartialEq, Eq, Serialize)] pub struct CommitDraft { pub subject: String, pub body: String }`
- `impl Repo { pub fn draft_commit_message(&self, command: &str, amend: bool) -> Result<CommitDraft> }`
- `fn cut_diff(text: &str, limit: usize) -> String` (private; Task 2 reuses it)
- `fn draft_text(stdout: &str) -> Result<String>`: `claude_answer`'s text, trimmed.

- [ ] **Step 1: Write failing tests** in `drafts.rs`: `a_commit_draft_reads_the_staged_diff_and_the_log` (stdin has `+new`, `GITP_BRANCH=main`, the log file lists the two subjects newest first, the file is gone after; printed `"feat: x\n\nwhy  \n"` → `CommitDraft{subject:"feat: x", body:"why"}`), `nothing_staged_is_refused_without_running` (`Stage something first.`, no marker file), `an_amend_reads_heads_diff_and_the_staged_one` (both changes on stdin; also on a root commit), `a_claude_json_answer_is_read_and_its_error_fails`, `a_long_message_is_cut_at_2000_characters`, `a_large_diff_is_cut_with_a_note` (600 KB of `é` lines → ≤ 400 KB + note, valid UTF-8, ends with the note), `a_cancelled_draft_says_cancelled`, `a_failing_command_names_the_commit_message_command`.
- [ ] **Step 2: Run** `cargo test -p gitp-core drafts` — fails (module missing).
- [ ] **Step 3: Implement** with `run_shell(self.workdir(), …, DRAFT_TIMEOUT, &self.net)`; temp log file named like `fix_finding`'s (`gitp-log-<pid>-<millis>.txt`), removed whether the run succeeds or not.
- [ ] **Step 4: Run** `cargo test -p gitp-core drafts` — pass.
- [ ] **Step 5: Commit** `feat(core): draft a commit message with a command`.

### Task 2: Pull request draft

**Files:** Modify `crates/gitp-core/src/drafts.rs`; `gh.rs` (`find_github_remote` → `pub(crate)`).

**Interfaces — Produces:** `impl Repo { pub fn draft_pull_request(&self, command: &str, base: &str, branch: &str) -> Result<PrDraft> }` (`PrDraft` is the existing `{title, body}`); `fn pr_draft_from(text: &str) -> Result<PrDraft>`.

- [ ] **Step 1: Write failing tests**: `a_pr_draft_reads_the_log_then_the_diff_with_the_env` (two commits ahead; both subjects come before `diff --git`; `GITP_BASE=main`, `GITP_BRANCH=feature`; no template → `GITP_PR_TEMPLATE_FILE` unset; JSON printed → its title/body), `a_template_is_named_in_the_env`, `the_github_remotes_base_is_used_when_fetched` (origin = github URL, `refs/remotes/origin/main` one commit behind local main → that commit is in the log), `no_commits_ahead_is_refused_without_running`, `a_plain_or_fenced_answer_is_read` (pure tests of `pr_draft_from`: plain `# T\n\nB` → `T`/`B`; fenced JSON → parsed; empty → error).
- [ ] **Step 2: Run** `cargo test -p gitp-core drafts` — new tests fail.
- [ ] **Step 3: Implement.** Log format `--format=commit %h%n%s%n%n%b`; diff with the `DIFF` flags of `branch_review.rs` (make it `pub(crate)`); stdin = log + `\n` + `cut_diff(diff)`.
- [ ] **Step 4: Run** `cargo test -p gitp-core drafts` — pass.
- [ ] **Step 5: Commit** `feat(core): draft a pull request with a command`.
