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

export type ConfigScope = "Local" | "Global" | "System" | "Other";

export interface ConfigEntry {
  name: string;
  value: string;
  scope: ConfigScope;
}
