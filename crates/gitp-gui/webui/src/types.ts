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
  // The backend is still reading the rest of a long history: `total` is only
  // the rows read so far. Asking again waits for the rest.
  partial: boolean;
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

// Local history: a snapshot of the working tree (gitp-core's Snapshot), the
// files uncommitted in it, and one file's versions across the snapshots.
export interface SnapshotFile {
  status: string;
  path: string;
  from: string | null;
}

export interface Snapshot {
  id: string;
  // Milliseconds since the epoch.
  time: number;
  head: string;
  files: SnapshotFile[];
}

export interface FileVersion {
  snapshot: string;
  time: number;
  blob: string;
  size: number;
}

// The repository's git hooks (gitp-core's Hooks).
export type HookState = "active" | "disabled" | "not_executable" | "missing";

export interface Hook {
  name: string;
  state: HookState;
  path: string;
}

export interface Hooks {
  dir: string;
  hooks: Hook[];
}

// What merging a branch would come to, without doing it (gitp-core's MergePreview).
export interface MergePreview {
  clean: boolean;
  conflicts: string[];
}

// How a merge combines the other branch (mirrors gitp-core's MergeMode).
export type MergeMode = "Default" | "NoFastForward" | "FastForwardOnly" | "Squash";

// How `pull` reconciles local and remote history (mirrors gitp-core's PullMode).
// Merge: a merge commit when it can't fast-forward, whatever the config says.
export type PullMode = "FastForward" | "FastForwardOnly" | "Rebase" | "Merge";

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
  // What "ours" and "theirs" are, in words. In a rebase git swaps them: ours
  // is the branch rebased onto, theirs the user's commit being applied.
  ours_label: string;
  theirs_label: string;
  // A rebase's commit being applied and how many there are, when known.
  step: number | null;
  steps: number | null;
  // Conflicted files with no conflict markers left on disk (git rerere
  // replayed a resolution, or they were edited), ready to mark resolved.
  clean: string[];
}

// A commit that changed a conflicted file, for the "why" panel.
export interface ConflictCommit {
  short: string;
  author: string;
  when: string;
  subject: string;
}

// The commits each side made to a conflicted file since the sides split.
export interface SideCommits {
  ours: ConflictCommit[];
  theirs: ConflictCommit[];
}

// The three staged versions plus the working text of a conflicted file.
// What a Stash & Switch did (mirrors gitp-core's StashSwitch).
export interface StashSwitch {
  output: string;
  // Popping on the new HEAD conflicted: markers are in the files and the
  // auto-stash is still stash@{0}.
  stash_kept: boolean;
  // What was staged couldn't be staged again on the new HEAD: the work came
  // back all unstaged.
  staging_lost: boolean;
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

// --- GitHub pull requests (mirrors gitp-core's gh module) ---------------------

// The `gh` account signed in to github.com. gitp holds no token: gh does.
export interface GhAccount {
  installed: boolean;
  signed_in: boolean;
  login: string | null;
  scopes: string[];
  // Why it is signed out, when that's more than "never signed in".
  message: string | null;
}

// "reviewed" is gitp's own: all of them, narrowed to the ones with a review
// saved under the repo's review/ folder; "rereview" too: the ones with commits
// since their review. GitHub only sees the others.
export type PrFilter = "all" | "mine" | "review_requested" | "reviewed" | "rereview" | "merged";

// A review saved under the repo's review/ folder, and the pull request it reviews.
export interface ReviewFile {
  path: string;
  number: number;
  // The head commit the review says it reviewed; null when it names none.
  head?: string | null;
}

export interface PrLabel {
  name: string;
  // Hex, without the `#`.
  color: string;
}

// A pull request as the sidebar lists it.
export interface PullRequest {
  number: number;
  title: string;
  author: string;
  is_draft: boolean;
  // APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED, or null.
  review_decision: string | null;
  // All checks in one word: success / failure / pending; null without checks.
  checks: string | null;
  head: string;
  base: string;
  // The commit at the tip of `head`; "" from a list read before gitp knew it.
  head_oid: string;
  updated_at: string;
  url: string;
  labels: PrLabel[];
  // When it was merged; null while it isn't.
  merged_at: string | null;
  // The reviewers whose latest review approves it.
  approvals: number;
  // Its line-comment threads not resolved yet; null when GitHub didn't say.
  unresolved_threads: number | null;
  // GitHub says it has conflicts with its base (mergeable is CONFLICTING).
  conflicting: boolean;
}

export interface PrCheck {
  name: string;
  // success / failure / pending / neutral / skipped
  state: string;
  url: string | null;
}

// A reviewer asked for a review: `id` is what an add takes, a login or
// org/team.
export interface PrReviewer {
  id: string;
  team: boolean;
}

export interface PrReview {
  author: string;
  // APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED
  state: string;
  body: string;
  submitted_at: string;
}

// A comment on the pull request itself.
export interface PrComment {
  id: string;
  author: string;
  body: string;
  created_at: string;
  url: string;
}

// A line-comment thread's state: resolved or not, and its comments' ids.
export interface PrReviewThread {
  id: string;
  resolved: boolean;
  comment_ids: number[];
}

// A comment on a diff line: a thread's first, or a reply in it.
export interface PrReviewComment {
  id: number;
  author: string;
  body: string;
  path: string;
  // Its line in the current diff; null once outdated.
  line: number | null;
  original_line: number | null;
  // The first line of a comment on several lines (a multi-line suggestion
  // covers start_line..line); null on one line.
  start_line?: number | null;
  side: "LEFT" | "RIGHT";
  created_at: string;
  // The thread's first comment, for a reply.
  in_reply_to: number | null;
  url: string;
  diff_hunk: string;
}

// A commit a branch has that its upstream doesn't.
export interface AheadCommit {
  sha: string;
  subject: string;
}

// What a Claude turn on a thread asked for.
export type TurnKind = "check" | "explain" | "followup" | "reply-draft" | "fix";

// One message of a thread's Claude conversation.
export interface ThreadTurn {
  kind: TurnKind;
  role: "user" | "claude";
  // Epoch milliseconds.
  at: number;
  // The head commit a Claude turn was made against.
  head?: string;
  text: string;
  // A fix turn: the commit it made, in which worktree.
  commit?: string;
  worktree?: string;
  // A reply draft: where it was posted, or that it was dropped.
  posted?: string;
  dropped?: boolean;
}

// The Claude conversation kept for one line-comment thread, under the
// repository's .git.
export interface ThreadConversation {
  version: number;
  pr: number;
  thread: number;
  path: string;
  // The pull request's title, the thread's line and its comments as the last
  // turn was given them, for the search; older files lack them.
  title?: string;
  line?: number;
  comments?: { author: string; body: string }[];
  // The Claude Code session to resume, once a JSON answer gave one; the
  // fixes, made in the branch's worktree, have their own.
  session?: string;
  fix_session?: string;
  turns: ThreadTurn[];
}

// A thread as the pull request view has it, for a turn on it.
export interface ThreadInput {
  number: number;
  head: string;
  // The pull request's author login.
  author: string;
  // The pull request's title, kept for the search.
  title?: string;
  // Root first.
  comments: PrReviewComment[];
}

// A stored conversation a search found.
export interface ThreadHit {
  pr: number;
  thread: number;
  path: string;
  line: number | null;
  title: string | null;
  // Around the first word's first match, on one line.
  snippet: string;
  // The snippet is from a reply draft that was dropped.
  dropped: boolean;
  // The last turn, epoch milliseconds.
  at: number;
  fixed: boolean;
  reply_state: "ready" | "posted" | null;
}

// The first 200 hits, newest first, and how many there were.
export interface ThreadSearch {
  hits: ThreadHit[];
  total: number;
}

// A commit of a pull request, oldest first as GitHub lists them.
export interface PrCommit {
  oid: string;
  headline: string;
  body: string;
  // Logins, or names for authors without an account; co-authors too.
  authors: string[];
  committed_at: string;
}

// The files of a pull request marked Viewed on GitHub (gitp-core's PrViewed):
// the pull request's node id, which a mark names, and the paths.
export interface PrViewed {
  id: string;
  viewed: string[];
}

// What the pull request view polls (gitp-core's PrSignature): a change in any
// part means the pull request moved on GitHub.
export interface PrSignature {
  head: string;
  updated_at: string;
  // [thread node id, resolved]
  threads: [string, boolean][];
  // [check name, state], by name
  checks: [string, string][];
}

export interface PullRequestDetail {
  number: number;
  title: string;
  body: string;
  // OPEN / CLOSED / MERGED
  state: string;
  is_draft: boolean;
  author: string;
  base: string;
  head: string;
  head_oid: string;
  url: string;
  created_at: string;
  review_decision: string | null;
  labels: PrLabel[];
  checks: PrCheck[];
  reviews: PrReview[];
  // Who is asked for a review and hasn't answered since.
  review_requests: PrReviewer[];
  comments: PrComment[];
  review_comments: PrReviewComment[];
  // Which line-comment threads are resolved (empty when the host didn't say).
  review_threads: PrReviewThread[];
  commits: PrCommit[];
  additions: number;
  deletions: number;
  changed_files: number;
  // MERGEABLE / CONFLICTING / UNKNOWN (GitHub still working it out).
  mergeable: string;
  // GitHub's word on merging now: CLEAN, BLOCKED, BEHIND, DIRTY, DRAFT,
  // UNSTABLE, HAS_HOOKS or UNKNOWN.
  merge_state: string;
  // When GitHub last saw anything happen on it.
  updated_at?: string;
  // What a poll compares against, from this same read (null when its threads
  // couldn't be read: the first poll then sets it).
  signature?: PrSignature | null;
}

export type MergeMethod = "merge" | "squash" | "rebase";

// What the repository on GitHub allows when merging, and its default branch.
export interface GitHubRepoSettings {
  default_branch: string;
  merge_commit: boolean;
  squash: boolean;
  rebase: boolean;
  delete_branch_on_merge: boolean;
}

// A title and description to start a new pull request from.
export interface PrDraft {
  title: string;
  body: string;
}

export interface NewPullRequest {
  branch: string;
  // The remote the branch is pushed to (a fork's names it owner:branch).
  remote: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export type ReviewVerdict = "approve" | "request_changes" | "comment";

// A new comment on one diff line.
export interface LineComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  commit_id: string;
  body: string;
}

// What the GitHub sign-in dialog shows: the one-time code, and where to enter it.
export interface DeviceCode {
  code: string;
  url: string;
}

// --- Code tab (mirrors gitp-code and gitp-gui/src/code.rs) ------------------
// Lines are 0-based; columns are UTF-16 code units, as CodeMirror counts.

export type Lang = "java" | "javascript" | "typescript" | "tsx" | "python";

export interface FileEntry {
  path: string;
  size: number;
  lang: Lang | null;
  mtime_ms: number;
}

// A gitignored path, shown greyed in the explorer; a directory's contents
// are listed when it is opened.
export interface IgnoredEntry {
  path: string;
  dir: boolean;
}

export interface Location {
  path: string;
  line: number;
  col: number;
}

export interface Range {
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
  start_byte: number;
  end_byte: number;
}

export type SymbolKind = "function" | "method" | "class" | "interface" | "enum" | "variable" | "field";

export interface SymbolId {
  file: number;
  byte: number;
}

export interface Symbol {
  id: SymbolId;
  name: string;
  kind: SymbolKind;
  path: string;
  range: Range;
  // Just the identifier: where the caret lands.
  name_range: Range;
  container: SymbolId | null;
  lang: Lang;
}

export interface Reference {
  name: string;
  kind: "call" | "ident" | "import";
  path: string;
  range: Range;
  enclosing: SymbolId | null;
  receiver: string | null;
}

export interface UsageHit {
  reference: Reference;
  // Scope or an import ties it to this definition; else the names merely match.
  certain: boolean;
  // For a field or variable (found by grep): whether the use reads or writes it.
  access: "read" | "write" | null;
  // The line the use is on, when grep found it.
  text: string | null;
}

export interface UsagesResult {
  symbol: Symbol;
  hits: UsageHit[];
  truncated: boolean;
}

export interface HierarchyNode {
  symbol: Symbol | null;
  reference: Reference;
  certain: boolean;
}

export interface CodeFile {
  text: string;
  crlf: boolean;
  mixed: boolean;
  // What a save must present back; the backend refuses with "changed_on_disk" otherwise.
  mtime_ms: number;
}

// What gitignore hid: the explorer's entries, and the files under them for
// Quick Open (cut at 50 000; dependency caches left out).
export interface Ignored {
  entries: IgnoredEntry[];
  files: string[];
}

export interface CodeWorkspace {
  files: FileEntry[];
  ignored: Ignored;
  // The first index is being built; "code-index-ready" follows.
  indexing: boolean;
}

export interface IndexReady {
  symbols: number;
  files: number;
  ms: number;
}

export interface CodeFilesChanged {
  paths: string[];
  // The paths not written by the Code tab itself.
  external: string[];
  // The file list's patch: entries that are new or changed, and paths gone.
  entries: FileEntry[];
  removed: string[];
  // Too many paths to patch: the backend rebuilt; fetch the list again.
  rebuilt: boolean;
}

export interface SearchQuery {
  pattern: string;
  regex: boolean;
  case_sensitive: boolean;
  whole_word: boolean;
  include_glob: string | null;
}

export interface SearchHit {
  path: string;
  line: number;
  col: number;
  end_col: number;
  text: string;
}

export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
  files_searched: number;
}

// Who last changed each line of a file in the Code tab (see gitp-core's
// blame_contents): per line its commit, null for a line not committed yet.
export interface FileBlame {
  lines: (string | null)[];
  commits: Record<string, BlameCommit>;
}

export interface BlameCommit {
  author: string;
  email: string;
  // Unix seconds.
  time: number;
  summary: string;
  body: string;
}

// --- Review drafts kept on disk (a branch's or a pull request's) ---------------

// The commit a fix made for a draft, where, and when (ms).
export interface ReviewFix {
  commit: string;
  worktree: string;
  at: number;
  // The worktree's own changes, set aside for the fix, clashed with it and
  // stay in the stash: what to do about it.
  notice?: string;
}

export type DraftStatus = "pending" | "approved" | "discarded" | "fixed";

export interface StoredDraft {
  id: number;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  severity: string | null;
  original: string;
  status: DraftStatus;
  topic?: string | null;
  fix?: ReviewFix | null;
  stale?: boolean;
  explained?: string | null;
  finding?: string | null;
  explanations?: string[];
  fixNotes?: string | null;
}

export interface StoredReview {
  version: number;
  branch?: string | null;
  pr?: number | null;
  base: string;
  head: string;
  drafts: StoredDraft[];
}

export type ReviewKey = { branch: string } | { pr: number };

// The branch Review panel's data (see reviews.rs): the saved review, the
// branch's diff against `base`, how files moved since the reviewed head
// (null: that head is gone, every line moved), and the worktree.
export interface BranchReviewData {
  review: StoredReview | null;
  head: string;
  base: string;
  files: FileDiff[];
  moves: FileDiff[] | null;
  worktree: string | null;
  dirty: boolean;
}

export interface GeneratedBranchReview {
  text: string;
  file: string | null;
  head: string;
  base: string;
}

// One draft to fix, with the hunk around it; `pr` and `pr_head` for a pull
// request's draft, whose branch must hold that head.
export interface FindingInput {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  severity: string | null;
  diff_hunk: string;
  branch: string;
  base: string;
  pr?: number | null;
  pr_head?: string | null;
}

// A merge of the base into a pull request's branch, with Claude's edits of
// the conflicted files, waiting in the branch's worktree for an approve
// (commit and push) or a discard.
export interface ConflictResolution {
  worktree: string;
  branch: string;
  // What was merged in: <remote>/<base>.
  base: string;
  // The branch's commit before the merge.
  before: string;
  // The files that had conflicts, which Claude edited.
  conflicted: string[];
  // Every file the merge changes on the branch, with git's status letter.
  changed: { status: string; path: string }[];
  // The diff of the conflicted files against the branch's commit.
  diff: string;
  // What Claude said it did; empty for a merge shown again.
  summary: string;
}
