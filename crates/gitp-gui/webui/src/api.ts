// Backend access layer. In the Tauri app these call Rust `#[tauri::command]`s.
// In a plain browser (e.g. `vite dev` for UI work) they return mock data so the
// UI is fully explorable without the desktop shell.

import type {
  BlameLine,
  CommitDetail,
  CommitRow,
  ConfigEntry,
  ConfigScope,
  FileCommit,
  FileDiff,
  LogPage,
  Refs,
  ResetMode,
  StatusLists,
  Workspace,
} from "./types";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

// Repo tabs: open/list/activate/close all return the full workspace so the
// frontend can re-render its tab bar from one source of truth.
export async function openRepo(path: string): Promise<Workspace> {
  if (!isTauri()) return mockOpen(path);
  return invoke<Workspace>("open_repo", { path });
}

export async function listRepos(): Promise<Workspace> {
  if (!isTauri()) return { ...MOCK_WORKSPACE };
  return invoke<Workspace>("list_repos", {});
}

export async function activateRepo(path: string): Promise<Workspace> {
  if (!isTauri()) return mockActivate(path);
  return invoke<Workspace>("activate_repo", { path });
}

export async function closeRepo(path: string): Promise<Workspace> {
  if (!isTauri()) return mockClose(path);
  return invoke<Workspace>("close_repo", { path });
}

// Show a native folder picker. Returns the chosen directory, or null if the
// user cancelled (or if running outside the Tauri shell, where no picker exists).
export async function browseForRepo(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false, title: "Open Repository" });
  return typeof selected === "string" ? selected : null;
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

export async function fetchRefs(): Promise<Refs> {
  if (!isTauri()) return MOCK_REFS;
  return invoke<Refs>("get_refs", {});
}

export async function fetchCommitTree(rev: string): Promise<string[]> {
  if (!isTauri()) return MOCK_TREE;
  return invoke<string[]>("get_commit_tree", { rev });
}

export async function fetchBlame(rev: string, path: string): Promise<BlameLine[]> {
  if (!isTauri()) return MOCK_BLAME;
  return invoke<BlameLine[]>("get_blame", { rev, path });
}

export async function fetchFileHistory(rev: string, path: string): Promise<FileCommit[]> {
  if (!isTauri()) return MOCK_FILE_HISTORY;
  return invoke<FileCommit[]>("get_file_history", { rev, path });
}

export async function fetchLocalChangeCount(): Promise<number> {
  if (!isTauri()) return mockDetail("x").files.length + 780;
  return invoke<number>("get_local_change_count", {});
}

// Staging trees: paths + statuses only (no hunks), so refreshing after each
// stage/unstage stays fast even with many changed files. The selected file's
// hunks come from fetchFileDiff.
export async function fetchStatusSummary(): Promise<StatusLists> {
  if (!isTauri()) {
    const strip = (f: FileDiff): FileDiff => ({ ...f, hunks: [] });
    return {
      staged: MOCK_STATUS.staged.map(strip),
      unstaged: MOCK_STATUS.unstaged.map(strip),
    };
  }
  return invoke<StatusLists>("get_status_summary", {});
}

// The full diff (with hunks) for one file, in the staged (HEAD→index) or
// unstaged (index→worktree) direction. Null when the path has no such change.
export async function fetchFileDiff(path: string, staged: boolean): Promise<FileDiff | null> {
  if (!isTauri()) {
    const list = staged ? MOCK_STATUS.staged : MOCK_STATUS.unstaged;
    return list.find((f) => f.path === path) ?? null;
  }
  return invoke<FileDiff | null>("get_file_diff", { path, staged });
}

export async function stage(path: string): Promise<void> {
  if (!isTauri()) return mockMove(MOCK_STATUS.unstaged, MOCK_STATUS.staged, path);
  await invoke<void>("stage", { path });
}

export async function unstage(path: string): Promise<void> {
  if (!isTauri()) return mockMove(MOCK_STATUS.staged, MOCK_STATUS.unstaged, path);
  await invoke<void>("unstage", { path });
}

export async function stageAll(): Promise<void> {
  if (!isTauri()) {
    MOCK_STATUS.staged.push(...MOCK_STATUS.unstaged.splice(0));
    return;
  }
  await invoke<void>("stage_all", {});
}

export async function unstageAll(): Promise<void> {
  if (!isTauri()) {
    MOCK_STATUS.unstaged.push(...MOCK_STATUS.staged.splice(0));
    return;
  }
  await invoke<void>("unstage_all", {});
}

export async function commitChanges(
  subject: string,
  body: string,
  amend: boolean,
): Promise<string> {
  if (!isTauri()) {
    const n = MOCK_STATUS.staged.length;
    MOCK_STATUS.staged.splice(0);
    return `[preview ${amend ? "amend" : "commit"}] ${subject} — ${n} file(s)`;
  }
  return invoke<string>("commit_changes", { subject, body, amend });
}

export async function fetchWorkingChanges(): Promise<FileDiff[]> {
  if (!isTauri()) {
    return [
      ...mockDetail("x").files,
      {
        path: "notes.md",
        old_path: null,
        status: "Untracked",
        hunks: [
          {
            header: "@@ -0,0 +1,2 @@",
            lines: [
              { origin: "+", old_lineno: null, new_lineno: 1, content: "# Notes" },
              { origin: "+", old_lineno: null, new_lineno: 2, content: "brand new file" },
            ],
          },
        ],
      },
    ];
  }
  return invoke<FileDiff[]>("get_working_changes", {});
}

// Yes/No confirmation. Uses the native dialog plugin in Tauri; window.confirm
// in a plain browser (preview mode).
export async function confirmDialog(message: string, title = "gitp"): Promise<boolean> {
  if (!isTauri()) return window.confirm(message);
  const { ask } = await import("@tauri-apps/plugin-dialog");
  return ask(message, { title, kind: "warning" });
}

export async function checkoutBranch(name: string): Promise<void> {
  if (!isTauri()) {
    MOCK_REFS.branches.forEach((b) => (b.is_head = b.name === name));
    MOCK_REFS.head = name;
    return;
  }
  await invoke<void>("checkout_branch", { name });
}

export async function createBranch(name: string): Promise<void> {
  if (!isTauri()) {
    MOCK_REFS.branches.forEach((b) => (b.is_head = false));
    MOCK_REFS.branches.push({ name, is_head: true, ahead: 0, behind: 0, target: mockOid("g") });
    MOCK_REFS.head = name;
    return;
  }
  await invoke<void>("create_branch", { name });
}

// --- Commit-scoped operations (log right-click menu) -----------------------
// In preview mode these are no-ops that report they can't run without the shell.

export async function checkoutCommit(rev: string): Promise<string> {
  if (!isTauri()) return `Checkout ${rev.slice(0, 10)} (preview mock)`;
  return invoke<string>("checkout_commit", { rev });
}

export async function createBranchAt(name: string, rev: string): Promise<string> {
  if (!isTauri()) return `Created ${name} at ${rev.slice(0, 10)} (preview mock)`;
  return invoke<string>("create_branch_at", { name, rev });
}

export async function createTagAt(name: string, rev: string): Promise<string> {
  if (!isTauri()) return `Tagged ${rev.slice(0, 10)} as ${name} (preview mock)`;
  return invoke<string>("create_tag_at", { name, rev });
}

export async function cherryPick(rev: string): Promise<string> {
  if (!isTauri()) return `Cherry-picked ${rev.slice(0, 10)} (preview mock)`;
  return invoke<string>("cherry_pick", { rev });
}

export async function revertCommit(rev: string): Promise<string> {
  if (!isTauri()) return `Reverted ${rev.slice(0, 10)} (preview mock)`;
  return invoke<string>("revert", { rev });
}

export async function resetTo(rev: string, mode: ResetMode): Promise<string> {
  if (!isTauri()) return `Reset --${mode.toLowerCase()} to ${rev.slice(0, 10)} (preview mock)`;
  return invoke<string>("reset", { rev, mode });
}

export async function rebaseOnto(rev: string): Promise<string> {
  if (!isTauri()) return `Rebased onto ${rev.slice(0, 10)} (preview mock)`;
  return invoke<string>("rebase_onto", { rev });
}

export async function pull(): Promise<string> {
  if (!isTauri()) return "Already up to date. (preview mock)";
  return invoke<string>("pull", {});
}

export async function push(): Promise<string> {
  if (!isTauri()) return "Everything up-to-date (preview mock)";
  return invoke<string>("push", {});
}

export async function stash(): Promise<string> {
  if (!isTauri()) {
    MOCK_REFS.stashes.unshift({ index: 0, message: "WIP on develop (preview mock)" });
    MOCK_REFS.stashes.forEach((s, i) => (s.index = i));
    return "Saved working directory (preview mock)";
  }
  return invoke<string>("stash", {});
}

export async function stashPop(): Promise<string> {
  if (!isTauri()) {
    MOCK_REFS.stashes.shift();
    MOCK_REFS.stashes.forEach((s, i) => (s.index = i));
    return "Popped stash (preview mock)";
  }
  return invoke<string>("stash_pop", {});
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

// A stand-in workspace so the tab bar is explorable in `vite dev`.
const MOCK_WORKSPACE: Workspace = {
  repos: [{ path: "/Users/you/Documents/mideal", name: "mideal (Documents)" }],
  active: 0,
};

function mockName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  const base = parts[parts.length - 1] || path;
  const parent = parts[parts.length - 2];
  return parent ? `${base} (${parent})` : base;
}

function mockOpen(path: string): Workspace {
  const i = MOCK_WORKSPACE.repos.findIndex((r) => r.path === path);
  if (i === -1) MOCK_WORKSPACE.repos.push({ path, name: mockName(path) });
  MOCK_WORKSPACE.active = i === -1 ? MOCK_WORKSPACE.repos.length - 1 : i;
  return { ...MOCK_WORKSPACE };
}

function mockActivate(path: string): Workspace {
  const i = MOCK_WORKSPACE.repos.findIndex((r) => r.path === path);
  if (i !== -1) MOCK_WORKSPACE.active = i;
  return { ...MOCK_WORKSPACE };
}

function mockClose(path: string): Workspace {
  const i = MOCK_WORKSPACE.repos.findIndex((r) => r.path === path);
  if (i !== -1) {
    MOCK_WORKSPACE.repos.splice(i, 1);
    const a = MOCK_WORKSPACE.active ?? 0;
    MOCK_WORKSPACE.active = MOCK_WORKSPACE.repos.length === 0 ? null : Math.min(i < a ? a - 1 : a, MOCK_WORKSPACE.repos.length - 1);
  }
  return { ...MOCK_WORKSPACE };
}

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
    author_email: `${id}@example.com`,
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

// Build the same 40-char id MOCK_LOG uses, so a mock branch tip resolves to a row.
function mockOid(c: string): string {
  return c.repeat(40).slice(0, 40);
}

// Ref tree resembling the reference design, so the sidebar is explorable.
export const MOCK_REFS: Refs = {
  head: "develop/3.33.0",
  branches: [
    { name: "master", is_head: false, ahead: 0, behind: 46, target: mockOid("a") },
    { name: "bugifx/login-crash", is_head: false, ahead: 0, behind: 0, target: mockOid("b") },
    { name: "develop/3.33.0", is_head: true, ahead: 2, behind: 0, target: mockOid("g") },
    { name: "development/api-v2", is_head: false, ahead: 0, behind: 0, target: mockOid("c") },
    { name: "draft-development/spike", is_head: false, ahead: 0, behind: 0, target: mockOid("d") },
    { name: "feature/dashboard", is_head: false, ahead: 3, behind: 1, target: mockOid("e") },
    { name: "feature/export", is_head: false, ahead: 0, behind: 0, target: mockOid("f") },
    { name: "hotfix/urgent-patch", is_head: false, ahead: 0, behind: 0, target: mockOid("c") },
    { name: "merge/master-to-develop", is_head: false, ahead: 0, behind: 0, target: mockOid("d") },
    { name: "pr-2444", is_head: false, ahead: 0, behind: 0, target: mockOid("b") },
    { name: "pr-2536", is_head: false, ahead: 0, behind: 0, target: mockOid("c") },
    { name: "pr-2543", is_head: false, ahead: 0, behind: 0, target: mockOid("d") },
    { name: "pr-2684-review", is_head: false, ahead: 0, behind: 0, target: mockOid("e") },
    { name: "release-hotfix-3.24.5", is_head: false, ahead: 0, behind: 0, target: mockOid("f") },
    { name: "release-hotfix-3.29.2", is_head: false, ahead: 0, behind: 0, target: mockOid("a") },
  ],
  remotes: [
    { remote: "origin", name: "origin/master", target: mockOid("a") },
    { remote: "origin", name: "origin/develop/3.33.0", target: mockOid("f") },
    { remote: "origin", name: "origin/feature/dashboard", target: mockOid("e") },
  ],
  tags: [
    { name: "v3.31.2", target: mockOid("b") },
    { name: "v3.32.0", target: mockOid("d") },
    { name: "v3.33.0", target: mockOid("g") },
  ],
  stashes: [
    { index: 0, message: "config 3.31.2" },
    { index: 1, message: "config 3.31 for mock" },
  ],
};

// A sample repository tree for the File Tree tab in preview mode. Includes the
// two files mockDetail marks as changed (src/config.rs, README.md).
export const MOCK_TREE: string[] = [
  "Cargo.toml",
  "README.md",
  "docs/design.md",
  "src/config.rs",
  "src/error.rs",
  "src/lib.rs",
  "src/main.rs",
  "src/views/log.ts",
  "src/views/sidebar.ts",
];

// Per-line blame for the blame view in preview mode. Commit ids are full (as
// the backend returns) so clicking a line can navigate to that commit.
export const MOCK_BLAME: BlameLine[] = [
  { commit: mockOid("a"), author: "Ada Lovelace", line_no: 1, content: "use crate::error::Result;" },
  { commit: mockOid("c"), author: "Ada Lovelace", line_no: 2, content: "pub fn read_config() -> Result<Vec<ConfigEntry>> {" },
  { commit: mockOid("c"), author: "Grace Hopper", line_no: 3, content: "    // ..." },
  { commit: mockOid("f"), author: "Ada Lovelace", line_no: 4, content: "}" },
];

// A file's commit history for the History view in preview mode.
export const MOCK_FILE_HISTORY: FileCommit[] = MOCK_LOG.slice(0, 4).map((r) => ({
  id: r.id,
  short_id: r.short_id,
  summary: r.summary,
  author_name: r.author_name,
  time: r.time,
}));

// Mutable staging state for preview mode, so stage/unstage/commit feel real.
const MOCK_STATUS: StatusLists = {
  staged: [],
  unstaged: [
    ...mockDetail("x").files,
    {
      path: "notes.md",
      old_path: null,
      status: "Untracked",
      hunks: [
        {
          header: "@@ -0,0 +1,2 @@",
          lines: [
            { origin: "+", old_lineno: null, new_lineno: 1, content: "# Notes" },
            { origin: "+", old_lineno: null, new_lineno: 2, content: "brand new file" },
          ],
        },
      ],
    },
  ],
};

function mockMove(from: FileDiff[], to: FileDiff[], path: string): void {
  const i = from.findIndex((f) => f.path === path);
  if (i !== -1) to.push(from.splice(i, 1)[0]);
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
