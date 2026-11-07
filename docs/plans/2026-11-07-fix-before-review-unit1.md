# Fix before the review, unit 1: core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** gitp-core can diff a local branch against its base, run a review command on it in the branch's worktree, keep branch and pull request review drafts on disk, and fix one finding in the branch's worktree with the thread-fix checks.

**Architecture:** A new module `review_store.rs` holds the stored review (one JSON shape for a branch and a pull request), its load/save/delete/prune and the default base. `gh.rs` gains `branch_diff`, `generate_branch_review` and `fix_finding`; the verification and undo of `fix_thread` move into a shared `run_verified_fix` so both fixes keep one set of rules. Line remapping is pure hunk arithmetic and lives in the frontend (unit 2), fed by the move diff this unit returns.

**Tech Stack:** Rust, git2, serde_json, the git CLI through `git_in`.

**Spec:** `docs/specs/2026-11-07-fix-before-review-design.md` (the "Decisions after the builder check" section wins over the earlier text).

## Global Constraints

- Branch file: `<common_dir>/gitp/branch-reviews/<branch with % → %25, / → %2F>.json`; PR file: `<common_dir>/gitp/pr-reviews/<number>.json`. Same shape: `{version: 1, branch?, pr?, base, head, drafts: [{id, path, line, side, body, severity, original, status, topic?, fix?: {commit, worktree, at}}]}`; status `pending|approved|discarded|fixed`.
- Atomic write (`.json.tmp` + rename); a file that does not parse is deleted and reads as none; pruned when the file mtime is older than `THREAD_KEEP` (60 days).
- Base: `origin/HEAD`'s target name without a network call, else `main`, else `master`; the rev is `origin/<name>` when that ref exists, else `<name>`.
- Diff = `git diff <merge-base(base, branch)> <branch>`. Empty → `Nothing to review: <branch> has no changes against <base>.`
- Branch review env: `GITP_BRANCH`, `GITP_BASE`, `GITP_HEAD`; no `GITP_PR_*`. Runs in the worktree that has the branch; the review file is looked for in that worktree's `review/`.
- Finding fix: temp file in `GITP_THREAD_FILE` = `{"kind":"finding", path, line, side, body, severity, diff_hunk, branch, base}`; env `GITP_FIX_WORKTREE`, `GITP_FIX_BRANCH`, `GITP_FIX_HEAD_BEFORE`, `GITP_TURN_KIND=fix`, `GITP_FINDING_PATH`, `GITP_FINDING_LINE`, `GITP_BRANCH`, `GITP_BASE`; stdin = the finding body; fresh session every run (`GITP_CLAUDE_SESSION` empty); `FIX_TIMEOUT`.
- Thread-fix checks unchanged: clean tree before, exactly one commit whose parent is HEAD-before, still on the branch, clean after; undo (`checkout -f branch`, `reset --hard before`, `clean -fd`) on any failure.
- Never run rustfmt on `lib.rs`.

## Review Focus

1. A branch name with `/` (`feat/x`) and one with `%` never share a file (Task 1: `feat/x` vs `feat%2Fx`).
2. A fix of a finding whose command commits twice or leaves the tree dirty is undone, exactly as for a thread (Task 3).
3. A fix on a branch that sits in no worktree, or a dirty one, refuses before the command runs (Task 3: marker file absent).
4. A review of a branch with no changes against the base says so and never runs the command (Task 2).
5. The fix record is written to the stored review even when the frontend saved edits to other drafts while the fix ran (Task 3: load-modify-save at the end).

---

### Task 1: The stored review and the base

**Files:** Create `crates/gitp-core/src/review_store.rs`; modify `crates/gitp-core/src/lib.rs` (mod + `pub use`).

**Interfaces — Produces:**

```rust
pub struct ReviewFix { pub commit: String, pub worktree: String, pub at: u64 }
pub enum DraftStatus { Pending, Approved, Discarded, Fixed }       // lowercase
pub struct StoredDraft { pub id: u64, pub path: String, pub line: u32, pub side: String, pub body: String,
    pub severity: Option<String>, pub original: String, pub status: DraftStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub topic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub fix: Option<ReviewFix> }
pub struct StoredReview { pub version: u32, #[serde(default, skip_serializing_if="Option::is_none")] pub branch: Option<String>,
    #[serde(default, skip_serializing_if="Option::is_none")] pub pr: Option<u64>, #[serde(default)] pub base: String,
    #[serde(default)] pub head: String, pub drafts: Vec<StoredDraft> }
#[serde(rename_all = "lowercase")] pub enum ReviewKey { Branch(String), Pr(u64) }   // {"branch":"x"} / {"pr":7}
impl StoredReview { pub fn key(&self) -> Result<ReviewKey> }  // Err when neither or both
impl Repo {
    pub fn stored_review(&self, key: &ReviewKey) -> Result<Option<StoredReview>>;
    pub fn save_stored_review(&self, r: &StoredReview) -> Result<()>;
    pub fn delete_stored_review(&self, key: &ReviewKey) -> Result<()>;   // nothing to delete is fine
    pub fn prune_stored_reviews(&self, now_millis: u64) -> Result<usize>;
    pub fn default_review_base(&self) -> Result<String>;
}
```

- [ ] Tests (RED) in `review_store.rs`: `a_review_round_trips_by_branch_and_by_number` (save branch `feat/x` and pr 7, read both back equal; files at `branch-reviews/feat%2Fx.json` and `pr-reviews/7.json`; `feat%2Fx` is another file); `a_damaged_review_is_deleted_and_reads_as_none`; `old_reviews_are_pruned_by_mtime` (set mtime 61 days back with `File::set_modified`, prune at now → 1, a fresh one stays); `a_key_needs_exactly_one_of_branch_and_pr`; `the_base_comes_from_origin_head_then_main_then_master` (repo with `refs/remotes/origin/HEAD → origin/develop` and `origin/develop` → `origin/develop`; without origin/HEAD but a local `main` → `main`; only `master` → `master`; only `origin/main` and no origin/HEAD → `origin/main`).
- [ ] Run `cargo test -p gitp-core --lib review_store` → FAIL (module missing).
- [ ] Implement; reuse `pr_threads`' atomic-write pattern; prune walks both folders.
- [ ] Run → PASS. Commit `feat(core): branch and pull request review drafts on disk`.

### Task 2: The branch diff and the branch review

**Files:** `crates/gitp-core/src/gh.rs`.

**Interfaces — Produces:**

```rust
pub struct BranchDiff { pub base: String, pub head: String, pub merge_base: String, pub text: String, pub files: Vec<FileDiff> }
pub struct GeneratedBranchReview { pub text: String, pub file: Option<String>, pub head: String, pub base: String }
impl Repo {
    pub fn branch_diff(&self, branch: &str, base: &str) -> Result<BranchDiff>;
    /// `git diff from to` as files; Ok(None) when `from` can't be read.
    pub fn diff_between(&self, from: &str, to: &str) -> Result<Option<Vec<FileDiff>>>;
    pub fn branch_worktree(&self, branch: &str) -> Result<Option<PathBuf>>;
    pub fn generate_branch_review(&self, branch: &str, base: &str, command: &str) -> Result<GeneratedBranchReview>;
}
```

- `branch_diff` runs `git -c core.quotepath=false diff --no-color --no-ext-diff <mb> <branch>` (raw stdout, untrimmed) in the workdir, files via `parse_pr_diff`.
- `generate_branch_review`: empty command → the PR message; no worktree → `<branch> is checked out in no worktree: check it out first.`; empty diff → the spec's sentence; `run_shell(worktree, command, diff, env, REVIEW_TIMEOUT)`; review file via `review_file_written_since(worktree, started)`; else stdout, empty → "The review command printed nothing."

- [ ] Tests (RED): `a_branch_diff_runs_from_the_merge_base` (main + feature with one commit; main moves after the fork; diff lists only the feature file, `merge_base` is the fork point); `a_branch_review_runs_in_the_worktree_with_the_branch_env` (feature in a linked worktree; command `echo "$PWD $GITP_BRANCH $GITP_BASE $GITP_HEAD ${GITP_PR_NUMBER:-none}"; cat >/dev/null` → text has the worktree path, `feature`, the base, the head sha, `none`; result `head` = branch sha); `a_review_file_in_the_worktree_is_read`; `a_branch_with_no_changes_is_not_reviewed` (command writes a marker; Err contains "Nothing to review"; marker absent); `a_branch_in_no_worktree_is_not_reviewed`.
- [ ] Run → FAIL; implement; run → PASS. Commit `feat(core): review a local branch against its base`.

### Task 3: Fix a finding

**Files:** `crates/gitp-core/src/gh.rs`.

**Interfaces — Produces:**

```rust
#[derive(Deserialize)] pub struct FindingInput { pub path: String, pub line: u32, pub side: String, pub body: String,
    pub severity: Option<String>, pub diff_hunk: String, pub branch: String, pub base: String,
    /// A pull request's draft: the head the branch must contain.
    #[serde(default)] pub pr: Option<u64>, #[serde(default)] pub pr_head: Option<String> }
impl Repo {
    pub fn fix_finding(&self, input: &FindingInput, fix_command: &str) -> Result<ReviewFix>;
    /// fix_finding, then the draft `id` of the review at `key` marked fixed (loaded again after the run).
    pub fn fix_review_draft(&self, key: &ReviewKey, id: u64, input: &FindingInput, fix_command: &str) -> Result<StoredReview>;
}
fn run_verified_fix(dir: &Path, branch: &str, before: &str, run: impl FnOnce() -> Result<T>) -> Result<(T, String)>  // the checks + undo, shared with fix_thread
```

Preconditions in order: worktree found (`Check the branch out first: <branch> is in no worktree.`), clean (`Commit or stash the changes in <path> first.`), when `pr` and `pr_head` → `ensure_pull_request_head` and is-ancestor (`The local branch is behind GitHub: pull it first.`). `fix_review_draft` errors when the review or draft is missing *before* running.

- [ ] Tests (RED), reusing `fix_repo()`: `a_finding_fix_runs_in_the_worktree_with_the_finding` (command prints `$PWD`, `$GITP_TURN_KIND`, `$GITP_FINDING_PATH:$GITP_FINDING_LINE`, `cat $GITP_THREAD_FILE`, stdin, then commits one file → ReviewFix commit = new worktree HEAD, worktree = path; the printed file has `"kind":"finding"` and the hunk; stdin was the body; `GITP_CLAUDE_SESSION` empty); `a_finding_fix_that_commits_twice_or_dirties_is_undone` (twice → Err "exactly one commit", HEAD back; dirty → Err "uncommitted", file gone); `a_finding_fix_refuses_a_dirty_or_missing_worktree` (marker absent); `fixing_a_stored_draft_marks_it_fixed_and_keeps_other_edits` (save review with drafts 1, 2; command also rewrites draft 2's body in the stored file through a sibling path written in the command — simpler: save review, run fix whose command first edits the store file? No: before calling, save; after, assert draft 1 status Fixed with fix, draft 2 untouched; plus a missing draft id → Err "no draft" and the command never ran).
- [ ] Existing `fix_thread` tests stay green after the refactor to `run_verified_fix`.
- [ ] Run `cargo test -p gitp-core --lib gh::` → PASS. Commit `feat(core): fix a review finding in the branch's worktree`.
