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

export type ConfigScope = "Local" | "Global" | "System" | "Other";

// How far a reset moves the branch (mirrors gitp-core's ResetMode).
export type ResetMode = "Soft" | "Mixed" | "Hard";

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
