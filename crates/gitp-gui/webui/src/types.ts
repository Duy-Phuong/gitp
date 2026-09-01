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

export interface LogPage {
  rows: CommitRow[];
  total: number;
}

export type ChangeKind =
  | "Added"
  | "Modified"
  | "Deleted"
  | "Renamed"
  | "Copied"
  | "Untracked"
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
}

export interface StatusLists {
  staged: FileDiff[];
  unstaged: FileDiff[];
}

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
}

export interface RemoteBranch {
  remote: string;
  name: string;
  target: string;
}

export interface TagRef {
  name: string;
  target: string;
}

export interface StashRef {
  index: number;
  message: string;
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
export interface ConflictSides {
  ours: string | null;
  theirs: string | null;
  base: string | null;
  working: string;
  binary: boolean;
}
