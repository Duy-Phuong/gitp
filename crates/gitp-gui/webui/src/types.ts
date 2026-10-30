// Mirrors the plain-data structures returned by gitp-core (via Tauri commands).

export interface CommitRow {
  id: string;
  short_id: string;
  summary: string;
  author_name: string;
  author_email: string;
  time: number;
  parents: string[];
  lane: number;
  color: number;
}

// What the log covers and how it is laid out (gitp-core's LogScope): the
// All/Current toggle plus the repo's graph settings.
export interface LogScope {
  all_branches: boolean;
  // The local branch whose first-parent line keeps the leftmost lane.
  pinned: string | null;
  // Full ref names the all-branches walk leaves out.
  hidden: string[];
  // Full ref names to walk instead (plus HEAD), when any.
  solo: string[];
}

export interface LogPage {
  rows: CommitRow[];
  total: number;
  // HEAD's commit, where the graph's WIP row hangs; null on an unborn branch.
  head: string | null;
}

export type ChangeKind =
  | "Added"
  | "Modified"
  | "Deleted"
  | "Renamed"
  | "Copied"
  | "Untracked"
  // An unmerged path during a merge/rebase/cherry-pick/revert. Sent as a single
  // unstaged entry; resolved in the conflict view, not staged from here.
  | "Conflicted"
  | "Other";

export interface DiffLine {
  origin: string; // '+', '-', or ' '
  old_lineno: number | null;
  new_lineno: number | null;
  content: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  old_path: string | null;
  status: ChangeKind;
  hunks: DiffHunk[];
  // Set when `hunks` stops short of the whole diff because the file passed
  // the backend's line cap (MAX_DIFF_LINES). Whole hunks only, so the hunk
  // indexes still match the complete diff. Absent on preview-mode mocks.
  truncated?: boolean;
}

export interface StatusLists {
  staged: FileDiff[];
  unstaged: FileDiff[];
}

// Where to read one side of a file from (mirrors gitp-core's FileSide): a
// revision's tree, the index, or the working tree.
export type FileSide = { Rev: string } | "Index" | "WorkTree";

// A file's bytes as base64, or only its size when it's too big to preview.
export interface FileContent {
  size: number;
  base64: string | null;
}

// A working-tree file as the in-app editor holds it (mirrors gitp-core's
// TextFile): line breaks as "\n", and the kind the file had, which saving
// writes back. `mixed` when they weren't all one kind — saving then makes
// them all the `crlf` kind.
export interface TextFile {
  text: string;
  crlf: boolean;
  mixed: boolean;
}

// What `git difftool` compares (mirrors gitp-core's DiffToolTarget): a commit
// against its parent, two revisions, or the staged / unstaged changes.
export type DiffToolTarget =
  | { Commit: string }
  | { Compare: { base: string; head: string; three_dot: boolean } }
  | "Staged"
  | "Unstaged";

export interface CommitDetail {
  id: string;
  summary: string;
  message: string;
  author_name: string;
  author_email: string;
  author_time: number;
  parents: string[];
  files: FileDiff[];
}

export interface BlameLine {
  commit: string;
  author: string;
  line_no: number;
  content: string;
}

export interface FileCommit {
  id: string;
  short_id: string;
  summary: string;
  author_name: string;
  time: number;
}

/// Outcome of a bulk branch delete: git's output plus the branches it refused.
export interface DeleteBranchesResult {
  output: string;
  failed: string[];
}

export interface RepoTab {
  path: string;
  name: string;
}

export interface BranchRef {
  name: string;
  is_head: boolean;
  ahead: number;
  behind: number;
  target: string;
  // False when the branch has no upstream (never pushed / no remote to compare).
  has_upstream: boolean;
  // The remote it tracks (branch.<name>.remote), where a push or a pull request
  // goes by default. Always sent by the backend; preview mocks leave it out.
  upstream_remote?: string | null;
}

export interface RemoteBranch {
  remote: string;
  name: string;
  target: string;
}

// A configured remote (mirrors gitp-core's RemoteInfo).
export interface RemoteInfo {
  name: string;
  url: string | null;
}

export interface TagRef {
  name: string;
  target: string;
  // An annotated tag's message (signature cut, capped); null for a lightweight tag.
  message: string | null;
}

export interface StashRef {
  index: number;
  message: string;
  // The commit the stash was taken on, where the graph draws it ("" if unknown).
  base: string;
}

// What the Stash dialog asks `git stash push` for: an entry name (empty for
// git's own), only the staged changes, and whether new files go too.
export interface StashOptions {
  message: string;
  staged: boolean;
  includeUntracked: boolean;
}

export interface Refs {
  head: string | null;
  branches: BranchRef[];
  remotes: RemoteBranch[];
  tags: TagRef[];
  stashes: StashRef[];
  // Local branch names most recently switched to, newest first (excludes HEAD).
  recent: string[];
}

export interface Workspace {
  repos: RepoTab[];
  active: number | null;
}

// Labels for what Undo / Redo would do (null = nothing / button disabled).
export interface UndoState {
  undo: string | null;
  redo: string | null;
}

export type ConfigScope = "Local" | "Global" | "System" | "Other";

// How far a reset moves the branch (mirrors gitp-core's ResetMode).
export type ResetMode = "Soft" | "Mixed" | "Hard";

// How a merge combines the other branch (mirrors gitp-core's MergeMode).
export type MergeMode = "Default" | "NoFastForward" | "FastForwardOnly" | "Squash";

// How `pull` reconciles local and remote history (mirrors gitp-core's PullMode).
export type PullMode = "FastForward" | "FastForwardOnly" | "Rebase";

// One of the two dotfiles the Settings "Dotfiles" panel edits (mirrors
// gitp-gui's DotfileKind). Resolved server-side from $HOME.
export type DotfileKind = "GitConfig" | "Tigrc";

// A commit in an interactive-rebase plan.
export interface RebaseCommit {
  sha: string;
  short_sha: string;
  subject: string;
}

export type RebaseAction = "pick" | "edit" | "reword" | "squash" | "fixup" | "drop";

export interface RebaseStep {
  sha: string;
  action: RebaseAction;
  message: string | null;
}

// Where an interactive cherry-pick run got to: `paused` on a conflict (the
// rest resumes through continueCherryPickPlan once it's resolved).
export interface PickPlanOutcome {
  output: string;
  paused: boolean;
  start_head: string;
}

export interface RebaseStatus {
  in_progress: boolean;
  paused_for: "edit" | "conflict" | null;
  current_sha: string | null;
  current_subject: string | null;
  conflicted_files: string[];
  done: number;
  total: number;
}

export interface ConfigEntry {
  name: string;
  value: string;
  scope: ConfigScope;
}

// Everything refreshed after an action, fetched in one round trip. Replaces
// five separate calls (refs / change count / rebase / conflict / undo) and, in
// particular, runs `git status` once instead of twice — see the Rust
// WorkspaceSnapshot for why that mattered.
export interface WorkspaceSnapshot {
  refs: Refs;
  local_changes: number;
  status: StatusLists;
  rebase: RebaseStatus;
  conflict: ConflictStatus;
  undo: UndoState;
  // The in-progress bisect, or null.
  bisect: BisectStatus | null;
}

// What a tag is and what it points at, for the tag details dialog. A
// lightweight tag is only a ref, so it has no tagger and no message of its own.
export interface TagDetail {
  name: string;
  target: string;
  annotated: boolean;
  tagger_name: string | null;
  tagger_email: string | null;
  tagger_time: number | null;
  message: string | null;
  target_summary: string;
}

// The in-progress conflict session for the resolver view.
export interface ConflictStatus {
  kind: "merge" | "rebase" | "cherry-pick" | "revert" | "none";
  summary: string;
  conflicted: string[];
  message: string;
}

// The three staged versions plus the working text of a conflicted file.
// What a Stash & Switch did (mirrors gitp-core's StashSwitch).
export interface StashSwitch {
  output: string;
  // Popping on the new HEAD conflicted: markers are in the files and the
  // auto-stash is still stash@{0}.
  stash_kept: boolean;
}

export interface ConflictSides {
  ours: string | null;
  theirs: string | null;
  base: string | null;
  working: string;
  binary: boolean;
  // Changed on disk since git wrote it (matches neither side, no markers).
  edited: boolean;
}

// Pushed by the backend's filesystem watcher (Tauri event `repo-changed`) when
// files or refs of the active repo change on disk — debounced, with changes in
// ignored directories left out.
export interface RepoChanged {
  path: string;
  kinds: ("worktree" | "index" | "refs" | "head")[];
}

// One `git-progress` event from a running fetch / pull / push: which operation,
// git's phase ("Receiving objects"), its percentage when git knows one, and the
// rest of git's line ("(450/1000), 1.2 MiB | 2.0 MiB/s"). `cancellable` turns
// false once the network part is over and a local write (a pull's merge or
// rebase) has begun — the backend ignores Cancel from then on.
export interface GitProgress {
  op: string;
  phase: string;
  percent: number | null;
  detail: string;
  cancellable: boolean;
}

// A local workspace's repo, as its row in the Workspaces screen shows it.
// `missing`: the folder is gone. `branch` is null when HEAD is detached.
export interface RepoSummary {
  missing: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  has_upstream: boolean;
  changes: number;
  // The main worktree's folder when this is a linked worktree of it.
  worktree_of: string | null;
  // The git directory shared with the repo's other worktrees ("" when missing).
  common_dir: string;
}

// Git's progress for one repo of a Workspaces bulk fetch or pull.
export interface WorkspaceProgress {
  path: string;
  phase: string;
  percent: number | null;
  detail: string;
  cancellable: boolean;
}

// One reflog entry: the ref moved from `old_id` to `new_id` because of
// `message` (git's own, e.g. "commit: …", "checkout: moving from a to b").
export interface ReflogEntry {
  // 0 is the most recent move.
  index: number;
  // The revision naming this entry, e.g. `HEAD@{3}` or `main@{0}`.
  selector: string;
  new_id: string;
  short_id: string;
  old_id: string;
  message: string;
  committer: string;
  time: number;
  // Summary of the `new_id` commit, or null once it has been pruned.
  summary: string | null;
}

// An installed editor or IDE the repository can be opened in (mirrors
// gitp-gui's os::Editor).
export interface Editor {
  id: string;
  name: string;
}

// One git command gitp ran for the repo (the Activity view).
export interface ActivityEntry {
  // Increasing; poll with the newest one seen to get only what's new.
  id: number;
  // When git started, ms since the epoch.
  started_at: number;
  duration_ms: number;
  // `git …` with credentials masked.
  command: string;
  // null when git couldn't start or was stopped (Cancel).
  exit_code: number | null;
  success: boolean;
  // A read-only probe a refresh runs (status, log, …): hidden by default.
  quiet: boolean;
  // The last few KB of each stream; stdout only for a failure.
  stderr: string;
  stdout: string;
}

// One side of a comparison: the revision as given (a ref name or an id) and
// the commit it resolved to.
export interface CompareEnd {
  rev: string;
  id: string;
  short_id: string;
  summary: string;
}

// What differs between two revisions — see Repo::compare in gitp-core.
// Three-dot diffs from the merge base (what `head` added since the two
// diverged); two-dot diffs `base` straight against `head`.
export interface Comparison {
  base: CompareEnd;
  head: CompareEnd;
  three_dot: boolean;
  merge_base: string | null;
  // Commits on `head` that `base` doesn't have, and the other way round.
  ahead: number;
  behind: number;
  files: FileDiff[];
}

// How the commit under test behaved (mirrors gitp-core's BisectMark).
export type BisectMark = "good" | "bad" | "skip";

// An in-progress `git bisect`, read back from .git (so one started in the
// terminal shows up too).
export interface BisectStatus {
  bad: string | null;
  good: string[];
  skipped: string[];
  // The commit checked out for testing (HEAD).
  current: string;
  current_summary: string;
  // [revisions left after this one, roughly how many steps]; null until both
  // ends are marked, and once the first bad commit is found.
  remaining_estimate: [number, number] | null;
  first_bad: string | null;
  first_bad_summary: string | null;
  // The branch (or commit) the bisect started from; Reset returns there.
  original_ref: string;
}

// How a signed commit's signature verified (gitp-core's SignatureStatus).
export type SignatureStatus = "Good" | "Bad" | "UnknownKey" | "Expired" | "Revoked" | "Unverifiable";

// A commit's signature, from get_commit_signature (null when unsigned).
export interface CommitSignature {
  status: SignatureStatus;
  // Who signed it (GPG user id / SSH principal) and the key's fingerprint;
  // empty when git couldn't tell.
  signer: string;
  key: string;
  // Git's message when it couldn't verify at all (Unverifiable).
  detail: string;
}

// Starting state of the commit box's Sign toggle.
export interface SigningConfig {
  // A signing key is configured (or commit.gpgsign is already on).
  can_sign: boolean;
  // The effective commit.gpgsign.
  sign_by_default: boolean;
}

// The user.name / user.email / user.signingkey / gpg.format a profile commits
// as (mirrors gitp-core's Identity). An empty field is an unset key.
export interface Identity {
  name: string;
  email: string;
  signing_key: string;
  signing_format: string;
}

// One working tree of the repository (mirrors gitp-core's Worktree): the main
// one, listed first, and any linked ones added with `git worktree add`.
export interface Worktree {
  path: string;
  head: string | null;
  // Short branch name; null when HEAD is detached there.
  branch: string | null;
  is_main: boolean;
  // The worktree the active tab is open in.
  is_current: boolean;
  locked: boolean;
  lock_reason: string | null;
  // Its folder is gone; Prune Worktrees would forget it.
  prunable: boolean;
}

// A worktree's state at a glance, for its sidebar row (mirrors gitp-core's
// WorktreeSummary). ahead / behind are against its branch's upstream, 0
// without one.
export interface WorktreeSummary {
  path: string;
  changed: number;
  ahead: number;
  behind: number;
}

// What removing a worktree would lose or strand (mirrors gitp-core's
// WorktreeUnsavedWork). `unpushed`: commits only its branch has — ahead of the
// upstream, or on no remote branch; on a detached HEAD, on no branch at all.
export interface WorktreeUnsavedWork {
  changed: string[];
  untracked: number;
  unpushed: number;
}

// A worktree entry Prune would forget (mirrors gitp-core's StaleWorktree).
export interface StaleWorktree {
  name: string;
  reason: string;
}

// The optional parts of a clone (mirrors gitp-core's CloneOptions).
export interface CloneOptions {
  branch: string | null;
  single_branch: boolean;
  depth: number | null;
  recurse_submodules: boolean;
}

// What a new worktree checks out (mirrors gitp-core's WorktreeTarget).
export type WorktreeTarget =
  | { kind: "branch"; name: string }
  | { kind: "new_branch"; name: string; start: string }
  | { kind: "detached"; rev: string };

// Where a submodule stands against the commit the superproject records
// (mirrors gitp-core's SubmoduleState).
export type SubmoduleState = "uninitialized" | "up_to_date" | "modified" | "dirty";

// One submodule of the repository (mirrors gitp-core's Submodule).
export interface Submodule {
  name: string;
  // Relative to the repository's folder.
  path: string;
  url: string | null;
  // The commit the superproject records (in its index).
  recorded: string | null;
  // The commit checked out in the submodule; null while uninitialized.
  checked_out: string | null;
  state: SubmoduleState;
}

// A repository's Git Flow settings (mirrors gitp-core's GitFlowConfig), stored
// under git-flow's own `gitflow.*` config keys.
export interface GitFlowConfig {
  production: string;
  develop: string;
  feature: string;
  release: string;
  hotfix: string;
  // May be empty.
  version_tag: string;
}

export type FlowKind = "Feature" | "Release" | "Hotfix";

// Git LFS for the status bar indicator (mirrors gitp-core's LfsStatus).
export interface LfsStatus {
  // `git lfs` runs.
  installed: boolean;
  // `.gitattributes` tracks some paths with LFS.
  used: boolean;
  // The LFS filters are configured (`git lfs install`).
  initialized: boolean;
  patterns: string[];
}
