// Backend access layer. In the Tauri app these call Rust `#[tauri::command]`s.
// In a plain browser (e.g. `vite dev` for UI work) they return mock data so the
// UI is fully explorable without the desktop shell.

import type { CommitDetail, CommitRow, ConfigEntry, ConfigScope, LogPage } from "./types";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function openRepo(path: string): Promise<string> {
  if (!isTauri()) return path;
  return invoke<string>("open_repo", { path });
}

export async function fetchLogPage(offset: number, limit: number): Promise<LogPage> {
  if (!isTauri()) {
    return { rows: MOCK_LOG.slice(offset, offset + limit), total: MOCK_LOG.length };
  }
  return invoke<LogPage>("get_log_page", { offset, limit });
}

export async function fetchCommitDetail(rev: string): Promise<CommitDetail> {
  if (!isTauri()) return mockDetail(rev);
  return invoke<CommitDetail>("get_commit_detail", { rev });
}

export async function fetchConfig(): Promise<ConfigEntry[]> {
  if (!isTauri()) return MOCK_CONFIG;
  return invoke<ConfigEntry[]>("get_config", {});
}

export async function saveConfig(
  scope: ConfigScope,
  name: string,
  value: string,
): Promise<void> {
  if (!isTauri()) {
    const existing = MOCK_CONFIG.find((e) => e.name === name && e.scope === scope);
    if (existing) existing.value = value;
    else MOCK_CONFIG.push({ scope, name, value });
    return;
  }
  await invoke<void>("set_config", { scope, name, value });
}

// ---------------------------------------------------------------------------
// Mock data (browser-only)
// ---------------------------------------------------------------------------

const DAY = 86400;
const BASE = 1_700_000_000;

export const MOCK_LOG: CommitRow[] = [
  mkRow("g", "Merge branch 'feature/widget'", ["f", "e"], 0, 0, BASE + 6 * DAY),
  mkRow("f", "docs: expand config guide", ["d"], 0, 0, BASE + 5 * DAY),
  mkRow("e", "feat: add dashboard widget", ["c"], 1, 1, BASE + 4 * DAY),
  mkRow("d", "fix: config loader precedence", ["c"], 0, 0, BASE + 3 * DAY),
  mkRow("c", "feat: add config loader", ["b"], 0, 0, BASE + 2 * DAY),
  mkRow("b", "chore: initial layout", ["a"], 0, 0, BASE + 1 * DAY),
  mkRow("a", "chore: initial commit", [], 0, 0, BASE),
];

function mkRow(
  id: string,
  summary: string,
  parents: string[],
  lane: number,
  color: number,
  time: number,
): CommitRow {
  return {
    id: id.repeat(40).slice(0, 40),
    short_id: id.repeat(7).slice(0, 7),
    summary,
    author_name: "Ada Lovelace",
    author_email: "ada@example.com",
    time,
    parents: parents.map((p) => p.repeat(40).slice(0, 40)),
    lane,
    color,
  };
}

function mockDetail(rev: string): CommitDetail {
  const short = rev.slice(0, 1);
  return {
    id: rev,
    summary: `Mock commit ${short}`,
    message: `Mock commit ${short}\n\nThis is placeholder detail shown when running the UI\noutside the Tauri shell.`,
    author_name: "Ada Lovelace",
    author_email: "ada@example.com",
    author_time: BASE,
    parents: [],
    files: [
      {
        path: "src/config.rs",
        old_path: null,
        status: "Modified",
        hunks: [
          {
            header: "@@ -1,4 +1,6 @@",
            lines: [
              { origin: " ", old_lineno: 1, new_lineno: 1, content: "use crate::error::Result;" },
              { origin: "-", old_lineno: 2, new_lineno: null, content: "// TODO: read config" },
              { origin: "+", old_lineno: null, new_lineno: 2, content: "pub fn read_config() -> Result<Vec<ConfigEntry>> {" },
              { origin: "+", old_lineno: null, new_lineno: 3, content: "    // ..." },
              { origin: "+", old_lineno: null, new_lineno: 4, content: "}" },
            ],
          },
        ],
      },
      {
        path: "README.md",
        old_path: null,
        status: "Added",
        hunks: [
          {
            header: "@@ -0,0 +1,2 @@",
            lines: [
              { origin: "+", old_lineno: null, new_lineno: 1, content: "# gitp" },
              { origin: "+", old_lineno: null, new_lineno: 2, content: "A nicer git UI." },
            ],
          },
        ],
      },
    ],
  };
}

export const MOCK_CONFIG: ConfigEntry[] = [
  { name: "user.name", value: "Ada Lovelace", scope: "Global" },
  { name: "user.email", value: "ada@example.com", scope: "Global" },
  { name: "core.editor", value: "vim", scope: "Global" },
  { name: "init.defaultBranch", value: "main", scope: "Global" },
  { name: "remote.origin.url", value: "git@github.com:ada/gitp.git", scope: "Local" },
  { name: "branch.main.remote", value: "origin", scope: "Local" },
  { name: "core.autocrlf", value: "input", scope: "System" },
];
