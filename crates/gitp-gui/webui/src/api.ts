// Backend access layer. In the Tauri app these call Rust `#[tauri::command]`s.
// In a plain browser (e.g. `vite dev` for UI work) they return mock data so the
// UI is fully explorable without the desktop shell.

import type {
  ActivityEntry,
  BisectMark,
  BisectStatus,
  BlameLine,
  CloneOptions,
  CommitDetail,
  CommitRow,
  CommitSignature,
  CompareEnd,
  Comparison,
  ConfigEntry,
  ConfigScope,
  ConflictSides,
  ConflictStatus,
  DotfileKind,
  Editor,
  FileCommit,
  FileContent,
  FileDiff,
  FileSide,
  GitProgress,
  DeleteBranchesResult,
  DiffToolTarget,
  LogPage,
  MergeMode,
  LogScope,
  PickPlanOutcome,
  PullMode,
  RebaseCommit,
  RebaseStatus,
  RebaseStep,
  ReflogEntry,
  Refs,
  RemoteInfo,
  RepoChanged,
  ResetMode,
  SigningConfig,
  StatusLists,
  TagDetail,
  TextFile,
  UndoState,
  Workspace,
  WorkspaceSnapshot,
  Worktree,
  WorktreeTarget,
  Submodule,
  StashOptions,
} from "./types";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// --- In-flight tracking -----------------------------------------------------
// Every backend call passes through `invoke`, so counting them here gives the
// UI one place to learn "something is still running" — the global progress bar
// and the elapsed-time suffix in the status bar hang off this, instead of each
// of the ~100 call sites remembering to show its own feedback.
let inFlight = 0;
const pendingListeners = new Set<(count: number) => void>();

/// Subscribe to changes in the number of backend calls in flight. The callback
/// runs immediately with the current count, then on every change.
export function onPendingChange(cb: (count: number) => void): () => void {
  pendingListeners.add(cb);
  cb(inFlight);
  return () => pendingListeners.delete(cb);
}

function setInFlight(delta: number): void {
  inFlight = Math.max(0, inFlight + delta);
  for (const cb of pendingListeners) cb(inFlight);
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  setInFlight(1);
  try {
    return await invoke<T>(cmd, args);
  } finally {
    setInFlight(-1);
  }
}

// --- Network operations -----------------------------------------------------
// Fetch / pull / push run through `invokeNetwork`, which counts them apart from
// other calls: while one runs the status bar offers Cancel, and the backend
// streams git's progress as `git-progress` events (see report.ts). The mocks
// resolve at once, so preview mode never shows either.
let networkInFlight = 0;
const networkListeners = new Set<(count: number) => void>();

/// Subscribe to changes in the number of network operations in flight. Runs
/// immediately with the current count, then on every change.
export function onNetworkChange(cb: (count: number) => void): () => void {
  networkListeners.add(cb);
  cb(networkInFlight);
  return () => networkListeners.delete(cb);
}

function setNetworkInFlight(delta: number): void {
  networkInFlight = Math.max(0, networkInFlight + delta);
  for (const cb of networkListeners) cb(networkInFlight);
}

async function invokeNetwork<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  setNetworkInFlight(1);
  try {
    return await invoke<T>(cmd, args);
  } finally {
    setNetworkInFlight(-1);
  }
}

/// Listen for git's progress during network operations. No-op in preview mode.
export async function onGitProgress(cb: (progress: GitProgress) => void): Promise<void> {
  if (!isTauri()) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<GitProgress>("git-progress", (event) => cb(event.payload));
}

/// Stop the network operation running on the active repo; it then rejects with
/// the cancelled error (see `isCancelled`).
export async function cancelNetworkOp(): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("cancel_network_op", {});
}

/// Whether `err` is a network operation the user cancelled rather than one that
/// failed. Matches gitp-core's `Error::Cancelled` message.
export function isCancelled(err: unknown): boolean {
  return String(err) === "operation cancelled";
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
  return browseForFolder("Open Repository");
}

// The same picker under another title — where to init or clone a repository.
export async function browseForFolder(title: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false, title });
  return typeof selected === "string" ? selected : null;
}

// `git clone` `url` into `dest`, a new folder, as `options` say. A network
// operation: progress and Cancel as for a fetch, credentials asked for in a
// dialog. Returns git's output; open `dest` with openRepo afterwards. In
// preview mode it simply succeeds.
export async function cloneRepository(url: string, dest: string, options: CloneOptions): Promise<string> {
  if (!isTauri()) return `Cloning into '${dest}'... (preview mock)`;
  return invokeNetwork<string>("clone_repository", { url, dest, options });
}

// `git init` a new repository at `path` (created if missing) on `branch`
// (null: git's default), writing a `.gitignore` with `gitignore` and a
// README.md when asked. Open it afterwards with openRepo. In preview mode it
// simply succeeds.
export async function initRepository(
  path: string,
  branch: string | null,
  gitignore: string | null,
  readme: boolean,
): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("init_repository", { path, branch, gitignore, readme });
}

// A cheap "has history changed?" probe. Pulling a page to find out costs ~264 KB
// of JSON for a 1000-row page, serialized, sent over IPC and parsed, almost
// always to be thrown away — see refreshHistory.
export async function historyFingerprint(): Promise<string> {
  if (!isTauri()) {
    // Mirror the real thing: derive from what the mocks mutate, so preview mode
    // exercises the same skip path rather than always refetching.
    const refs = [
      MOCK_REFS.head ?? "",
      ...MOCK_REFS.branches.map((b) => `${b.name}:${b.target}`),
      ...MOCK_REFS.tags.map((t) => `${t.name}:${t.target}`),
    ].join(",");
    return `${MOCK_LOG.length}:${refs.length}:${refs.slice(0, 64)}`;
  }
  return invoke<string>("history_fingerprint", {});
}

export async function fetchLogPage(
  offset: number,
  limit: number,
  scope: LogScope,
): Promise<LogPage> {
  if (!isTauri()) {
    return { rows: MOCK_LOG.slice(offset, offset + limit), total: MOCK_LOG.length, head: MOCK_LOG[0].id };
  }
  return invoke<LogPage>("get_log_page", { offset, limit, scope });
}

// Where `rev` sits in the full log, or null when it isn't in it. The frontend
// only holds the pages it has scrolled through, so this is how a sidebar click
// finds out how far down a tag or an older branch actually is.
export async function logIndexOf(rev: string, scope: LogScope): Promise<number | null> {
  if (!isTauri()) return null;
  return invoke<number | null>("log_index_of", { rev, scope });
}

// Commits matching a search query, in log order — GitKraken-style commit search
// over the full loaded graph. Words match the message, author or id; author:,
// path:, content: (-S:), after: and before: narrow it (see LogSearch in gitp-core).
export async function searchLog(query: string, scope: LogScope): Promise<CommitRow[]> {
  if (!query.trim()) return [];
  if (!isTauri()) return mockSearch(query);
  return invoke<CommitRow[]>("search_log", { query, scope });
}

// Preview-mode stand-in for LogSearch: bare words (ANDed), author:, after: and
// before:. The mock log has no files, so path: and content: match everything.
function mockSearch(query: string): CommitRow[] {
  const terms = (query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((t) => t.replace(/"/g, ""));
  const day = (v: string) => Date.parse(`${v}T00:00:00Z`) / 1000;
  return MOCK_LOG.filter((r) =>
    terms.every((term) => {
      const [, key = "", value = term] = /^(author|path|content|-S|after|before):(.*)$/i.exec(term) ?? [];
      const v = value.toLowerCase();
      switch (key.toLowerCase()) {
        case "author":
          return r.author_name.toLowerCase().includes(v) || r.author_email.toLowerCase().includes(v);
        case "after":
          return r.time >= day(value);
        case "before":
          return r.time < day(value);
        case "path":
        case "content":
        case "-s":
          return true;
        default:
          return r.summary.toLowerCase().includes(v) || r.author_name.toLowerCase().includes(v) || r.author_email.toLowerCase().includes(v) || r.id.startsWith(v);
      }
    }),
  );
}

export async function fetchCommitDetail(rev: string): Promise<CommitDetail> {
  if (!isTauri()) return mockDetail(rev);
  return invoke<CommitDetail>("get_commit_detail", { rev });
}

// The commit's signature, verified (null when unsigned). Separate from
// fetchCommitDetail because verifying runs gpg / ssh-keygen, which can be slow.
// In preview mode the newest mock commit is signed and verifies.
export async function fetchCommitSignature(rev: string): Promise<CommitSignature | null> {
  if (!isTauri()) {
    if (rev !== MOCK_LOG[0].id) return null;
    return { status: "Good", signer: "ada@example.com", key: "SHA256:mockKeyFingerprint0123456789abcdef", detail: "" };
  }
  return invoke<CommitSignature | null>("get_commit_signature", { rev });
}

// Lines of unchanged context around each change: git's default, which is what
// fetchCommitDetail's diffs use.
export const DEFAULT_CONTEXT_LINES = 3;
// "Full file": more context than any file has lines, so the whole file comes
// back as one block. Kept well under 2^31 — libgit2 doubles it internally.
export const FULL_FILE_CONTEXT = 1_000_000_000;
// The most diff lines a file comes back with unless `full` is asked for;
// mirrors gitp-core's MAX_DIFF_LINES, for the truncation notice.
export const MAX_DIFF_LINES = 5_000;

// One file of a commit re-diffed with `contextLines` of context — the diff
// pane's show more / show less / full file — and optionally ignoring
// whitespace (`git diff -w`). `oldPath` keeps a rename paired.
// `full` lifts the line cap for a file that came back `truncated`.
export async function fetchCommitFileDiff(
  rev: string,
  path: string,
  oldPath: string | null,
  contextLines: number,
  ignoreWhitespace: boolean,
  full = false,
): Promise<FileDiff | null> {
  if (!isTauri()) return mockDetail(rev).files.find((f) => f.path === path) ?? null;
  return invoke<FileDiff | null>("get_commit_file_diff", { rev, path, oldPath, contextLines, ignoreWhitespace, full });
}

// `path` as it is on `side`, for the image diff. Null when the file doesn't
// exist there; `base64` is null when it's too big to preview. In preview mode,
// a coloured square: blue for a revision, green for the index / working tree.
export async function fetchFileContent(side: FileSide, path: string): Promise<FileContent | null> {
  if (!isTauri()) {
    const fill = typeof side === "object" ? "#5b8cff" : "#3fb950";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><rect width="96" height="64" rx="8" fill="${fill}"/></svg>`;
    return { size: svg.length, base64: btoa(svg) };
  }
  return invoke<FileContent | null>("get_file_content", { side, path });
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

// One round trip for everything an action invalidates. Prefer this over the
// individual fetchRefs / fetchRebaseStatus / conflictStatus / undoState calls:
// it takes the backend lock once, and runs `git status` once for both the
// sidebar badge and the staging lists.
export async function workspaceSnapshot(): Promise<WorkspaceSnapshot> {
  if (!isTauri()) {
    const [refs, status, rebase, conflict, undo, bisect] = await Promise.all([
      fetchRefs(),
      fetchStatusSummary(),
      fetchRebaseStatus(),
      conflictStatus(),
      undoState(),
      bisectStatus(),
    ]);
    const paths = new Set([...status.staged, ...status.unstaged].map((f) => f.path));
    return { refs, local_changes: paths.size, status, rebase, conflict, undo, bisect };
  }
  return invoke<WorkspaceSnapshot>("workspace_snapshot", {});
}

// Changes on disk pushed by the backend's watcher (see RepoChanged). There is
// no watcher in preview mode, so nothing ever arrives there.
export async function onRepoChanged(cb: (ev: RepoChanged) => void): Promise<void> {
  if (!isTauri()) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<RepoChanged>("repo-changed", (event) => cb(event.payload));
}

// Files dragged onto the window from Finder: `over` while they hover, `drop`
// with their absolute paths, `leave` if they're taken away. The desktop
// webview takes file drops itself, so no HTML5 drop event (which wouldn't
// carry a path anyway) fires. The position is in CSS pixels: on macOS wry
// reports it in points, despite the "physical" in the type. There's nothing
// to drag in from in preview mode.
export type FileDragEvent =
  | { type: "over"; x: number; y: number }
  | { type: "drop"; paths: string[]; x: number; y: number }
  | { type: "leave" };

export async function onFileDragDrop(cb: (ev: FileDragEvent) => void): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  await getCurrentWebview().onDragDropEvent(({ payload: p }) => {
    if (p.type === "leave") cb({ type: "leave" });
    else if (p.type === "drop") cb({ type: "drop", paths: p.paths, x: p.position.x, y: p.position.y });
    else cb({ type: "over", x: p.position.x, y: p.position.y });
  });
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

// The diff (with hunks) for one file, in the staged (HEAD→index) or
// unstaged (index→worktree) direction. Null when the path has no such change.
// A whitespace-ignoring diff is for reading only — its blocks aren't the
// file's real changes, so never stage or discard by them.
// `full` lifts the line cap for a file that came back `truncated`.
export async function fetchFileDiff(
  path: string,
  staged: boolean,
  contextLines: number,
  ignoreWhitespace: boolean,
  full = false,
): Promise<FileDiff | null> {
  if (!isTauri()) {
    const list = staged ? MOCK_STATUS.staged : MOCK_STATUS.unstaged;
    return list.find((f) => f.path === path) ?? null;
  }
  return invoke<FileDiff | null>("get_file_diff", { path, staged, contextLines, ignoreWhitespace, full });
}

export async function stage(path: string): Promise<void> {
  if (!isTauri()) {
    mockRecord("Stage");
    return mockMove(MOCK_STATUS.unstaged, MOCK_STATUS.staged, path);
  }
  await invoke<void>("stage", { path });
}

export async function unstage(path: string): Promise<void> {
  if (!isTauri()) {
    mockRecord("Unstage");
    return mockMove(MOCK_STATUS.staged, MOCK_STATUS.unstaged, path);
  }
  await invoke<void>("unstage", { path });
}

// Per-hunk staging (git add -p style). In preview mode, approximate by dropping
// the affected hunk from the mock file (or moving the file when it empties).
// `contextLines` is the context the diff was shown with — it decides which
// block `hunkIndex` is.
export async function stageHunk(path: string, hunkIndex: number, contextLines: number): Promise<void> {
  if (!isTauri()) {
    mockRecord("Stage block");
    return mockMoveHunk(MOCK_STATUS.unstaged, MOCK_STATUS.staged, path, hunkIndex);
  }
  await invoke<void>("stage_hunk", { path, hunkIndex, contextLines });
}

export async function unstageHunk(path: string, hunkIndex: number, contextLines: number): Promise<void> {
  if (!isTauri()) {
    mockRecord("Unstage block");
    return mockMoveHunk(MOCK_STATUS.staged, MOCK_STATUS.unstaged, path, hunkIndex);
  }
  await invoke<void>("unstage_hunk", { path, hunkIndex, contextLines });
}

export async function discardHunk(path: string, hunkIndex: number, contextLines: number): Promise<void> {
  if (!isTauri()) {
    const f = MOCK_STATUS.unstaged.find((x) => x.path === path);
    f?.hunks.splice(hunkIndex, 1);
    if (f && f.hunks.length === 0) mockMove(MOCK_STATUS.unstaged, [], path);
    return;
  }
  await invoke<void>("discard_hunk", { path, hunkIndex, contextLines });
}

// Per-line staging: act on just the selected changed lines, each named as
// [hunkIndex, lineIndex within that hunk] at the diff's `contextLines`. In
// preview mode, approximate by moving the selected lines out of the mock file
// (dropping the file when no change is left in it).
export async function stageLines(path: string, lines: [number, number][], contextLines: number): Promise<void> {
  if (!isTauri()) {
    mockRecord("Stage lines");
    return mockTakeLines(MOCK_STATUS.unstaged, MOCK_STATUS.staged, path, lines);
  }
  await invoke<void>("stage_lines", { path, lines, contextLines });
}

export async function unstageLines(path: string, lines: [number, number][], contextLines: number): Promise<void> {
  if (!isTauri()) {
    mockRecord("Unstage lines");
    return mockTakeLines(MOCK_STATUS.staged, MOCK_STATUS.unstaged, path, lines);
  }
  await invoke<void>("unstage_lines", { path, lines, contextLines });
}

export async function discardLines(path: string, lines: [number, number][], contextLines: number): Promise<void> {
  if (!isTauri()) return mockTakeLines(MOCK_STATUS.unstaged, null, path, lines);
  await invoke<void>("discard_lines", { path, lines, contextLines });
}

export async function stageAll(): Promise<void> {
  if (!isTauri()) {
    MOCK_STATUS.staged.push(...MOCK_STATUS.unstaged.splice(0));
    mockRecord("Stage all");
    return;
  }
  await invoke<void>("stage_all", {});
}

export async function unstageAll(): Promise<void> {
  if (!isTauri()) {
    MOCK_STATUS.unstaged.push(...MOCK_STATUS.staged.splice(0));
    mockRecord("Unstage all");
    return;
  }
  await invoke<void>("unstage_all", {});
}

// `sign` forces signing on or off; null leaves it to git's commit.gpgsign.
export async function commitChanges(
  subject: string,
  body: string,
  amend: boolean,
  sign: boolean | null,
  noVerify: boolean,
): Promise<string> {
  if (!isTauri()) {
    const n = MOCK_STATUS.staged.length;
    MOCK_STATUS.staged.splice(0);
    mockRecord(amend ? "Amend commit" : "Commit");
    const flags = `${sign ? ", signed" : ""}${noVerify ? ", no hooks" : ""}`;
    return `[preview ${amend ? "amend" : "commit"}${flags}] ${subject} — ${n} file(s)`;
  }
  return invoke<string>("commit_changes", { subject, body, amend, sign, noVerify });
}

export async function fetchSigningConfig(): Promise<SigningConfig> {
  if (!isTauri()) return { can_sign: true, sign_by_default: false };
  return invoke<SigningConfig>("get_signing_config", {});
}

// The raw text of the file commit.template names; null when it isn't set.
export async function fetchCommitTemplate(): Promise<string | null> {
  if (!isTauri()) return null; // the preview repo has no template configured
  return invoke<string | null>("get_commit_template", {});
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
    mockRecord(`Checkout ${name}`);
    return;
  }
  await invoke<void>("checkout_branch", { name });
}

// Check out a remote branch, creating a local tracking branch if needed.
export async function checkoutRemoteBranch(name: string): Promise<string> {
  if (!isTauri()) {
    const local = name.split("/").slice(1).join("/");
    MOCK_REFS.branches.forEach((b) => (b.is_head = false));
    if (!MOCK_REFS.branches.some((b) => b.name === local)) {
      MOCK_REFS.branches.push({ name: local, is_head: true, ahead: 0, behind: 0, target: mockOid("g"), has_upstream: true });
    } else {
      const b = MOCK_REFS.branches.find((x) => x.name === local)!;
      b.is_head = true;
    }
    MOCK_REFS.head = local;
    return `Switched to ${local} (preview mock)`;
  }
  return invoke<string>("checkout_remote", { name });
}

export async function createBranch(name: string): Promise<void> {
  if (!isTauri()) {
    MOCK_REFS.branches.forEach((b) => (b.is_head = false));
    MOCK_REFS.branches.push({ name, is_head: true, ahead: 0, behind: 0, target: mockOid("g"), has_upstream: false });
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

// A non-empty `message` makes an annotated tag; without one it's lightweight.
export async function createTagAt(name: string, rev: string, message = ""): Promise<string> {
  if (!isTauri()) return `Tagged ${rev.slice(0, 10)} as ${name} (preview mock)`;
  return invoke<string>("create_tag_at", { name, rev, message: message || null });
}

// Recreate lightweight tag `name` as an annotated one at the same commit.
export async function annotateTag(name: string, message: string): Promise<string> {
  if (!isTauri()) {
    const tag = MOCK_REFS.tags.find((t) => t.name === name);
    if (tag) tag.message = message;
    return `Annotated ${name} (preview mock)`;
  }
  return invoke<string>("annotate_tag", { name, message });
}

export async function fetchTagDetail(name: string): Promise<TagDetail> {
  if (!isTauri()) {
    const target = MOCK_REFS.tags.find((t) => t.name === name)?.target ?? mockOid("a");
    // Alternate annotated/lightweight in preview mode so both layouts of the
    // details dialog are reachable without a real repo.
    const annotated = name.endsWith("0");
    return {
      name,
      target,
      annotated,
      tagger_name: annotated ? "Ada Lovelace" : null,
      tagger_email: annotated ? "ada@example.com" : null,
      tagger_time: annotated ? 1_700_000_000 : null,
      message: annotated ? `Release ${name}\n\nMock annotation shown in preview mode.` : null,
      target_summary: "Mock commit",
    };
  }
  return invoke<TagDetail>("tag_detail", { name });
}

export async function pushTag(name: string): Promise<string> {
  if (!isTauri()) return `Pushed ${name} to origin (preview mock)`;
  return invokeNetwork<string>("push_tag", { name });
}

export async function deleteTag(name: string): Promise<string> {
  if (!isTauri()) {
    MOCK_REFS.tags = MOCK_REFS.tags.filter((t) => t.name !== name);
    return `Deleted tag ${name} (preview mock)`;
  }
  return invoke<string>("delete_tag", { name });
}

export async function deleteRemoteTag(name: string): Promise<string> {
  if (!isTauri()) return `Deleted ${name} on origin (preview mock)`;
  return invokeNetwork<string>("delete_remote_tag", { name });
}

export async function remoteTagExists(name: string): Promise<boolean> {
  if (!isTauri()) return name.endsWith("0");
  return invoke<boolean>("remote_tag_exists", { name });
}

export async function cherryPick(rev: string): Promise<string> {
  if (!isTauri()) return `Cherry-picked ${rev.slice(0, 10)} (preview mock)`;
  return invoke<string>("cherry_pick", { rev });
}

// Cherry-pick an edited plan (pick / reword / squash / drop, in order) onto
// HEAD. Only those four actions are valid here.
export async function cherryPickPlan(steps: RebaseStep[]): Promise<PickPlanOutcome> {
  if (!isTauri()) {
    const n = steps.filter((s) => s.action !== "drop").length;
    return { output: `Cherry-picked ${n} commits (preview mock)`, paused: false, start_head: "" };
  }
  return invoke<PickPlanOutcome>("cherry_pick_plan", { steps });
}

export async function continueCherryPickPlan(): Promise<PickPlanOutcome> {
  if (!isTauri()) return { output: "Finished the cherry-pick plan (preview mock)", paused: false, start_head: "" };
  return invoke<PickPlanOutcome>("continue_cherry_pick_plan");
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

// --- Branch operations (sidebar right-click menu) --------------------------

export async function renameBranch(oldName: string, newName: string): Promise<string> {
  if (!isTauri()) {
    const b = MOCK_REFS.branches.find((x) => x.name === oldName);
    if (b) b.name = newName;
    if (MOCK_REFS.head === oldName) MOCK_REFS.head = newName;
    return `Renamed ${oldName} → ${newName} (preview mock)`;
  }
  return invoke<string>("rename_branch", { old: oldName, new: newName });
}

// Rename the branch's remote counterpart (call after renameBranch): pushes the
// new name and deletes the old remote branch.
export async function renameRemoteBranch(newName: string): Promise<string> {
  if (!isTauri()) return `Renamed remote branch to ${newName} (preview mock)`;
  return invokeNetwork<string>("rename_remote_branch", { new: newName });
}

// Create a branch at HEAD without checking it out (rebase backup).
export async function createBackupBranch(name: string): Promise<string> {
  if (!isTauri()) return `Created backup branch ${name} (preview mock)`;
  return invoke<string>("create_backup_branch", { name });
}

export async function deleteBranch(name: string, force: boolean): Promise<string> {
  if (!isTauri()) {
    const i = MOCK_REFS.branches.findIndex((x) => x.name === name);
    if (i !== -1) MOCK_REFS.branches.splice(i, 1);
    return `Deleted ${name} (preview mock)`;
  }
  return invoke<string>("delete_branch", { name, force });
}

// Delete several branches as ONE undoable action. Undo is single-level, so
// looping `deleteBranch` would leave only the last one recoverable.
export async function deleteBranches(
  names: string[],
  force: boolean,
): Promise<DeleteBranchesResult> {
  if (!isTauri()) return { output: `Deleted ${names.length} branches (preview mock)`, failed: [] };
  return invoke<DeleteBranchesResult>("delete_branches", { names, force });
}

export async function deleteRemoteBranch(name: string): Promise<string> {
  if (!isTauri()) return `Deleted remote branch for ${name} (preview mock)`;
  return invokeNetwork<string>("delete_remote_branch", { name });
}

// Live check (git ls-remote) of whether the branch exists on its remote right
// now. Returns the "<remote>/<branch>" label, or null if absent.
export async function remoteBranchExists(name: string): Promise<string | null> {
  if (!isTauri()) {
    const m =
      MOCK_REFS.remotes.find((r) => r.name === `origin/${name}`) ??
      MOCK_REFS.remotes.find((r) => r.name.endsWith(`/${name}`));
    return m ? m.name : null;
  }
  return invoke<string | null>("remote_branch_exists", { name });
}

export async function mergeBranch(name: string, mode: MergeMode = "Default"): Promise<string> {
  if (!isTauri()) return `Merged ${name} (${mode}, preview mock)`;
  return invoke<string>("merge_branch", { name, mode });
}

// The commit message a squash merge prepared, or null when none is pending.
export async function squashMessage(): Promise<string | null> {
  if (!isTauri()) return "Squashed commit of the following:\n\ncommit 1111111\n\n    feat: add widget (preview mock)";
  return invoke<string | null>("squash_message", {});
}

// `remote`: where to push; by default the remote the branch tracks, else origin.
export async function pushBranch(name: string, remote?: string): Promise<string> {
  if (!isTauri()) return `Pushed ${name} to ${remote ?? "origin"} (preview mock)`;
  return invokeNetwork<string>("push_branch", { name, remote: remote ?? null });
}

// Push local branch `name` to `remoteBranch` on `remote`, whatever its name
// there — a branch dropped on a remote branch in the graph.
export async function pushBranchTo(name: string, remote: string, remoteBranch: string): Promise<string> {
  if (!isTauri()) return `Pushed ${name} to ${remote}/${remoteBranch} (preview mock)`;
  return invokeNetwork<string>("push_branch_to", { name, remote, remoteBranch });
}

export async function fetchBranch(name: string): Promise<string> {
  if (!isTauri()) return `Fetched updates for ${name} (preview mock)`;
  return invokeNetwork<string>("fetch_branch", { name });
}

// Fetch all remotes (updates every branch's ahead/behind vs its upstream).
// Local branches whose upstream was deleted on the remote — `git branch -vv`'s
// `[gone]`. Run a fetch with pruning first, or the answer is stale.
export async function goneBranches(): Promise<string[]> {
  if (!isTauri()) return ["feature/merged-already", "bugfix/old-thing"];
  return invoke<string[]>("gone_branches", {});
}

export async function fetchRemote(remote: string): Promise<string> {
  if (!isTauri()) return `Fetched ${remote} (preview mock)`;
  return invokeNetwork<string>("fetch_remote", { remote });
}

// Preview mode's configured remotes: origin plus one never fetched, so the
// sidebar shows an empty remote and the branch menu offers a choice of push.
const MOCK_REMOTES: RemoteInfo[] = [
  { name: "origin", url: "git@github.com:ada/gitp.git" },
  { name: "upstream", url: "https://github.com/gitp-org/gitp.git" },
];

export async function listRemotes(): Promise<RemoteInfo[]> {
  if (!isTauri()) return MOCK_REMOTES.map((r) => ({ ...r }));
  return invoke<RemoteInfo[]>("list_remotes", {});
}

export async function addRemote(name: string, url: string): Promise<string> {
  if (!isTauri()) {
    MOCK_REMOTES.push({ name, url });
    MOCK_REMOTES.sort((a, b) => a.name.localeCompare(b.name));
    return "";
  }
  return invoke<string>("add_remote", { name, url });
}

export async function setRemoteUrl(name: string, url: string): Promise<string> {
  if (!isTauri()) {
    const r = MOCK_REMOTES.find((m) => m.name === name);
    if (r) r.url = url;
    return "";
  }
  return invoke<string>("set_remote_url", { name, url });
}

export async function renameRemote(old: string, name: string): Promise<string> {
  if (!isTauri()) {
    const r = MOCK_REMOTES.find((m) => m.name === old);
    if (r) r.name = name;
    return "";
  }
  return invoke<string>("rename_remote", { old, new: name });
}

export async function removeRemote(name: string): Promise<string> {
  if (!isTauri()) {
    const i = MOCK_REMOTES.findIndex((m) => m.name === name);
    if (i !== -1) MOCK_REMOTES.splice(i, 1);
    return "";
  }
  return invoke<string>("remove_remote", { name });
}

// `background`: the periodic refresh nobody asked for, which must never pop a
// credential dialog — it fails quietly instead.
// `prune` (default on) drops remote-tracking branches deleted upstream.
export async function fetchAll(opts: { background?: boolean; prune?: boolean } = {}): Promise<string> {
  if (!isTauri()) return "Fetched all remotes (preview mock)";
  return invokeNetwork<string>("fetch_all", { background: opts.background ?? false, prune: opts.prune ?? true });
}

// `git maintenance run --task=gc`: runs like a fetch (Cancel, the status
// bar's busy state) though nothing goes over the network.
export async function performMaintenance(): Promise<string> {
  if (!isTauri()) return "";
  return invokeNetwork<string>("perform_maintenance");
}

export async function fetchAndUpdateBranch(name: string): Promise<string> {
  if (!isTauri()) return `Fetched and updated ${name} (preview mock)`;
  return invokeNetwork<string>("fetch_and_update_branch", { name });
}

export async function fastForwardBranch(name: string): Promise<string> {
  if (!isTauri()) return `Fast-forwarded ${name} (preview mock)`;
  return invoke<string>("fast_forward_branch", { name });
}

// Fast-forward local branch `name` to `to` (a branch or remote branch); git
// refuses it unless `name` is behind `to`.
export async function fastForwardBranchTo(name: string, to: string): Promise<string> {
  if (!isTauri()) return `Fast-forwarded ${name} to ${to} (preview mock)`;
  return invoke<string>("fast_forward_branch_to", { name, to });
}

export async function setUpstream(branch: string, upstream: string): Promise<string> {
  if (!isTauri()) return `${branch} now tracks ${upstream} (preview mock)`;
  return invoke<string>("set_upstream", { branch, upstream });
}

export async function unsetUpstream(branch: string): Promise<string> {
  if (!isTauri()) return `${branch} no longer tracks an upstream (preview mock)`;
  return invoke<string>("unset_upstream", { branch });
}

// `remote`: whose web UI to open it on; by default the remote the branch tracks.
export async function createPullRequest(branch: string, remote?: string): Promise<string> {
  if (!isTauri()) return `https://example.com/${remote ?? "origin"}/compare/${branch} (preview mock)`;
  return invoke<string>("create_pull_request", { branch, remote: remote ?? null });
}

export async function fetchRebaseTodo(onto: string): Promise<RebaseCommit[]> {
  if (!isTauri()) {
    return [
      { sha: "1".repeat(40), short_sha: "1111111", subject: "feat: add widget" },
      { sha: "2".repeat(40), short_sha: "2222222", subject: "fix: typo in widget" },
      { sha: "3".repeat(40), short_sha: "3333333", subject: "refactor: tidy widget" },
    ];
  }
  return invoke<RebaseCommit[]>("get_rebase_todo", { onto });
}

export async function interactiveRebase(
  onto: string,
  steps: RebaseStep[],
  updateRefs: boolean,
): Promise<string> {
  if (!isTauri()) {
    const editStep = steps.find((s) => s.action === "edit");
    if (editStep) {
      // Simulate git pausing at the edit step so the in-progress UI is exercisable.
      MOCK_REBASE_STATUS.in_progress = true;
      MOCK_REBASE_STATUS.paused_for = "edit";
      MOCK_REBASE_STATUS.current_sha = editStep.sha;
      MOCK_REBASE_STATUS.current_subject = "edited commit";
      MOCK_REBASE_STATUS.done = 1;
      MOCK_REBASE_STATUS.total = steps.length;
      return `Stopped at an edit step (preview mock)`;
    }
    return `Rebased onto ${onto} with ${steps.length} step(s)${updateRefs ? ", refs updated" : ""} (preview mock)`;
  }
  return invoke<string>("interactive_rebase", { onto, steps, updateRefs });
}

export async function fetchRebaseStatus(): Promise<RebaseStatus> {
  if (!isTauri()) return MOCK_REBASE_STATUS;
  return invoke<RebaseStatus>("rebase_status", {});
}

export async function rebaseContinue(): Promise<string> {
  if (!isTauri()) {
    MOCK_REBASE_STATUS.in_progress = false;
    return "Continued rebase (preview mock)";
  }
  return invoke<string>("rebase_continue", {});
}

export async function rebaseSkip(): Promise<string> {
  if (!isTauri()) {
    MOCK_REBASE_STATUS.in_progress = false;
    return "Skipped commit (preview mock)";
  }
  return invoke<string>("rebase_skip", {});
}

export async function rebaseAbort(): Promise<string> {
  if (!isTauri()) {
    MOCK_REBASE_STATUS.in_progress = false;
    return "Aborted rebase (preview mock)";
  }
  return invoke<string>("rebase_abort", {});
}

export async function pull(mode: PullMode): Promise<string> {
  if (!isTauri()) {
    MOCK_UNDO = { undo: null, redo: null }; // a pull clears the undo history
    return "Already up to date. (preview mock)";
  }
  return invokeNetwork<string>("pull", { mode });
}

// Single-level undo/redo of the most recent supported action (GitKraken-style).
// The labels drive the toolbar buttons' enabled state and tooltips.
let MOCK_UNDO: UndoState = { undo: null, redo: null };

export async function undoState(): Promise<UndoState> {
  if (!isTauri()) return { ...MOCK_UNDO };
  return invoke<UndoState>("undo_state", {});
}

export async function undo(): Promise<UndoState> {
  if (!isTauri()) {
    if (MOCK_UNDO.undo) MOCK_UNDO = { undo: null, redo: MOCK_UNDO.undo };
    return { ...MOCK_UNDO };
  }
  return invoke<UndoState>("undo", {});
}

export async function redo(): Promise<UndoState> {
  if (!isTauri()) {
    if (MOCK_UNDO.redo) MOCK_UNDO = { undo: MOCK_UNDO.redo, redo: null };
    return { ...MOCK_UNDO };
  }
  return invoke<UndoState>("redo", {});
}

// In preview (mock) mode, record a fake undoable action so the buttons light up.
function mockRecord(label: string): void {
  MOCK_UNDO = { undo: label, redo: null };
}

export async function push(): Promise<string> {
  if (!isTauri()) return "Everything up-to-date (preview mock)";
  return invokeNetwork<string>("push", {});
}

// Force-push with --force-with-lease (see gitp-core's Repo::push_force) —
// offered when a plain push is rejected because the local branch is behind.
export async function pushForce(): Promise<string> {
  if (!isTauri()) return "Forced update (preview mock)";
  return invokeNetwork<string>("push_force", {});
}

// `git stash push` with the Stash dialog's options; an empty message lets git
// name the entry ("WIP on <branch>").
export async function stash(opts: StashOptions): Promise<string> {
  if (!isTauri()) {
    const message = opts.message ? `On develop: ${opts.message}` : "WIP on develop (preview mock)";
    MOCK_REFS.stashes.unshift({ index: 0, message, base: MOCK_LOG[0].id });
    MOCK_REFS.stashes.forEach((s, i) => (s.index = i));
    return `Saved ${opts.staged ? "index state" : "working directory"} (preview mock)`;
  }
  return invoke<string>("stash", {
    message: opts.message || null,
    staged: opts.staged,
    includeUntracked: opts.includeUntracked,
  });
}

export async function stashPop(): Promise<string> {
  if (!isTauri()) {
    MOCK_REFS.stashes.shift();
    MOCK_REFS.stashes.forEach((s, i) => (s.index = i));
    return "Popped stash (preview mock)";
  }
  return invoke<string>("stash_pop", {});
}

// --- Stash operations (sidebar right-click menu) ---------------------------

// Apply stash@{index}; `drop` pops (apply + remove) instead of leaving it.
export async function applyStash(index: number, drop: boolean): Promise<string> {
  if (!isTauri()) {
    if (drop) {
      MOCK_REFS.stashes.splice(index, 1);
      MOCK_REFS.stashes.forEach((s, i) => (s.index = i));
    }
    return `${drop ? "Popped" : "Applied"} stash@{${index}} (preview mock)`;
  }
  return invoke<string>("stash_apply", { index, drop });
}

export async function dropStash(index: number): Promise<string> {
  if (!isTauri()) {
    MOCK_REFS.stashes.splice(index, 1);
    MOCK_REFS.stashes.forEach((s, i) => (s.index = i));
    return `Dropped stash@{${index}} (preview mock)`;
  }
  return invoke<string>("stash_drop", { index });
}

export async function renameStash(index: number, message: string): Promise<string> {
  if (!isTauri()) {
    const s = MOCK_REFS.stashes[index];
    if (s) s.message = message;
    return `Renamed stash to "${message}" (preview mock)`;
  }
  return invoke<string>("stash_rename", { index, message });
}

// Prompt for a destination and write stash@{index}'s diff there as a patch.
// Returns a status string, or null if the user cancelled the save dialog.
export async function saveStashPatch(index: number, defaultName: string): Promise<string | null> {
  if (!isTauri()) return `Saved patch for stash@{${index}} (preview mock)`;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ title: "Save Stash as Patch", defaultPath: defaultName });
  if (!path) return null;
  return invoke<string>("save_stash_patch", { index, path });
}

// --- Local-changes file operations (changes-view right-click menu) ---------

// Discard all local changes to `paths` (revert to HEAD; delete new files).
export async function discardFiles(paths: string[]): Promise<void> {
  if (!isTauri()) {
    for (const p of paths) {
      mockMove(MOCK_STATUS.unstaged, [], p);
      mockMove(MOCK_STATUS.staged, [], p);
    }
    mockRecord(`Discard ${paths.length} file${paths.length === 1 ? "" : "s"}`);
    return;
  }
  await invoke<void>("discard_files", { paths });
}

// Put `paths` back to how they are in commit `rev` — written and staged
// (`git checkout <rev> -- <paths>`). Undoable like a discard.
export async function restoreFilesFromCommit(rev: string, paths: string[]): Promise<void> {
  if (!isTauri()) {
    for (const p of paths) {
      mockMove(MOCK_STATUS.unstaged, [], p);
      if (!MOCK_STATUS.staged.some((f) => f.path === p)) {
        MOCK_STATUS.staged.push({ path: p, old_path: null, status: "Modified", hunks: [] });
      }
    }
    mockRecord(`Restore ${paths.length} file${paths.length === 1 ? "" : "s"} from ${rev.slice(0, 7)}`);
    return;
  }
  await invoke<void>("restore_files_from_commit", { rev, paths });
}

// Undo block `hunkIndex` of commit `rev`'s diff of `file` (at `contextLines`,
// as drawn) in the working tree. Fails when the file has moved on there.
export async function revertCommitHunk(
  rev: string,
  file: FileDiff,
  hunkIndex: number,
  contextLines: number,
): Promise<void> {
  if (!isTauri()) {
    if (!MOCK_STATUS.unstaged.some((f) => f.path === file.path)) {
      MOCK_STATUS.unstaged.push({ path: file.path, old_path: null, status: "Modified", hunks: [] });
    }
    mockRecord(`Revert block of ${file.path}`);
    return;
  }
  await invoke<void>("revert_commit_hunk", {
    rev,
    path: file.path,
    oldPath: file.old_path,
    hunkIndex,
    contextLines,
  });
}

// Stash only `paths` away (`git stash push -u -- <paths>`).
export async function stashFiles(paths: string[]): Promise<string> {
  if (!isTauri()) {
    for (const p of paths) {
      mockMove(MOCK_STATUS.unstaged, [], p);
      mockMove(MOCK_STATUS.staged, [], p);
    }
    MOCK_REFS.stashes.unshift({ index: 0, message: `WIP: ${paths.length} file(s) (preview mock)`, base: MOCK_LOG[0].id });
    MOCK_REFS.stashes.forEach((s, i) => (s.index = i));
    return `Stashed ${paths.length} file(s) (preview mock)`;
  }
  return invoke<string>("stash_files", { paths });
}

// Prompt for a destination and write a patch of `paths` (staged or working-tree
// direction) there. Returns a status string, or null if the user cancelled.
export async function saveFilesPatch(
  paths: string[],
  staged: boolean,
  defaultName: string,
): Promise<string | null> {
  if (!isTauri()) return `Saved patch for ${paths.length} file(s) (preview mock)`;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const dest = await save({ title: "Save as Patch", defaultPath: defaultName });
  if (!dest) return null;
  return invoke<string>("save_files_patch", { paths, staged, path: dest });
}

// Prompt for a destination and write every local change — staged, unstaged and
// untracked — there as one patch against HEAD. Returns a status string, or null
// if the user cancelled.
export async function saveAllChangesPatch(defaultName: string): Promise<string | null> {
  if (!isTauri()) return "Saved patch of all changes (preview mock)";
  const { save } = await import("@tauri-apps/plugin-dialog");
  const dest = await save({ title: "Create Patch from All Changes", defaultPath: defaultName });
  if (!dest) return null;
  return invoke<string>("save_all_changes_patch", { path: dest });
}

// Prompt for a destination and write `revs` (in that order) there as one patch
// file. Returns a status string, or null if the user cancelled.
export async function saveCommitsPatch(revs: string[], defaultName: string): Promise<string | null> {
  if (!isTauri()) return `Saved patch for ${revs.length} commit(s) (preview mock)`;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const dest = await save({ title: "Save as Patch", defaultPath: defaultName });
  if (!dest) return null;
  return invoke<string>("save_commits_patch", { revs, path: dest });
}

// Pick a .patch / .diff file and apply it to the working tree and index
// (`git apply --3way`). Resolves to the file applied, or null if the user
// cancelled the picker.
export async function applyPatchFile(): Promise<string | null> {
  if (!isTauri()) return "changes.patch";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({
    title: "Apply Patch",
    multiple: false,
    filters: [{ name: "Patch", extensions: ["patch", "diff"] }],
  });
  if (typeof path !== "string") return null;
  await invoke<void>("apply_patch", { path });
  return path;
}

// Append `paths` to the repo's .gitignore; returns the number actually added.
export async function addToGitignore(paths: string[]): Promise<number> {
  if (!isTauri()) return paths.length;
  return invoke<number>("add_to_gitignore", { paths });
}

// Stop tracking `paths` (`git rm --cached`), keeping the files on disk.
export async function untrackFiles(paths: string[]): Promise<void> {
  if (!isTauri()) {
    for (const p of paths) mockMove(MOCK_STATUS.unstaged, [], p);
    return;
  }
  await invoke<void>("untrack_files", { paths });
}

// Reveal the repo-relative `path` in the OS file manager.
export async function revealPath(path: string): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("reveal_path", { path });
}

// Open the repo-relative `path` in the OS default application (e.g. the
// user's configured code editor).
export async function openInEditor(path: string): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("open_in_editor", { path });
}

// The editors and IDEs installed here that the repository can be opened in.
export async function listEditors(): Promise<Editor[]> {
  if (!isTauri()) {
    return [
      { id: "vscode", name: "Visual Studio Code" },
      { id: "cursor", name: "Cursor" },
    ];
  }
  return invoke<Editor[]>("list_editors");
}

// Open the active repository's folder in the editor `id` (from listEditors).
export async function openRepoInEditor(id: string): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("open_repo_in_editor", { id });
}

// --- In-app file editor ------------------------------------------------------
// Working-tree files as text. Saving, creating and deleting are undoable. In
// preview mode the files live in MOCK_FILES.

// `path` as text, null when it doesn't exist. Binary, non-UTF-8 and >2 MB
// files are refused with an error.
export async function readTextFile(path: string): Promise<TextFile | null> {
  if (!isTauri()) {
    const text = MOCK_FILES.get(path);
    return text === undefined ? null : { text, crlf: false, mixed: false };
  }
  return invoke<TextFile | null>("read_text_file", { path });
}

// Save `text` ("\n" line breaks) to `path`, as "\r\n" when `crlf`.
export async function writeTextFile(path: string, text: string, crlf: boolean): Promise<void> {
  if (!isTauri()) {
    MOCK_FILES.set(path, text);
    mockMarkModified(path);
    mockRecord(`Edit ${path}`);
    return;
  }
  await invoke<void>("write_text_file", { path, text, crlf });
}

// Create `path` (repo-relative) as an empty file, with its folders. Refuses an
// existing file and anything outside the working tree.
export async function createFile(path: string): Promise<void> {
  if (!isTauri()) {
    if (MOCK_FILES.has(path)) throw new Error(`${path} already exists`);
    if (path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error(`not a path inside the repository: ${path}`);
    }
    MOCK_FILES.set(path, "");
    MOCK_STATUS.unstaged.push({ path, old_path: null, status: "Untracked", hunks: [] });
    mockRecord(`Create ${path}`);
    return;
  }
  await invoke<void>("create_file", { path });
}

// Delete the working-tree file `path`; the index is left alone.
export async function deleteFile(path: string): Promise<void> {
  if (!isTauri()) {
    MOCK_FILES.delete(path);
    mockMove(MOCK_STATUS.unstaged, [], path);
    mockMove(MOCK_STATUS.staged, [], path);
    mockRecord(`Delete ${path}`);
    return;
  }
  await invoke<void>("delete_file", { path });
}

// Every tracked and untracked (not ignored) file in the working tree, sorted.
export async function listWorkFiles(): Promise<string[]> {
  if (!isTauri()) return [...MOCK_FILES.keys()].sort();
  return invoke<string[]>("list_work_files", {});
}

// Open `paths` of `target` in the user's `git difftool` (diff.tool), without
// waiting for it to close. False when no diff tool is configured — always, in
// preview mode, where there's nothing to launch.
export async function openDiffTool(target: DiffToolTarget, paths: string[]): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("open_difftool", { target, paths });
}

// Open the conflicted `path` in the user's `git mergetool` (merge.tool). False
// when no merge tool is configured (always, in preview mode).
export async function openMergeTool(path: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("open_mergetool", { path });
}

// --- Conflict resolution (merge/rebase conflict resolver view) -------------

export async function conflictStatus(): Promise<ConflictStatus> {
  if (!isTauri()) return { ...MOCK_CONFLICT, conflicted: [...MOCK_CONFLICT.conflicted] };
  return invoke<ConflictStatus>("conflict_status", {});
}

export async function conflictSides(path: string): Promise<ConflictSides> {
  if (!isTauri()) {
    return MOCK_SIDES[path] ?? { ours: "", theirs: "", base: null, working: "", binary: false };
  }
  return invoke<ConflictSides>("conflict_sides", { path });
}

export async function resolveConflict(path: string, content: string): Promise<void> {
  if (!isTauri()) {
    if (MOCK_SIDES[path]) MOCK_SIDES[path] = { ...MOCK_SIDES[path], working: content };
    MOCK_CONFLICT.conflicted = MOCK_CONFLICT.conflicted.filter((p) => p !== path);
    return;
  }
  await invoke<void>("resolve_conflict", { path, content });
}

export async function resolveConflictSide(path: string, ours: boolean): Promise<void> {
  if (!isTauri()) {
    MOCK_CONFLICT.conflicted = MOCK_CONFLICT.conflicted.filter((p) => p !== path);
    return;
  }
  await invoke<void>("resolve_conflict_side", { path, ours });
}

export async function abortConflict(): Promise<string> {
  if (!isTauri()) {
    MOCK_CONFLICT = { kind: "none", summary: "", conflicted: [], message: "" };
    return "Merge aborted (preview mock)";
  }
  return invoke<string>("abort_conflict", {});
}

export async function finishConflict(message: string): Promise<string> {
  if (!isTauri()) {
    MOCK_CONFLICT = { kind: "none", summary: "", conflicted: [], message: "" };
    return `Committed merge (preview mock): ${message.split("\n")[0]}`;
  }
  return invoke<string>("finish_conflict", { message });
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

// Remove `name` from `scope`'s config file; a key that isn't there is fine.
export async function unsetConfig(scope: ConfigScope, name: string): Promise<void> {
  if (!isTauri()) {
    const i = MOCK_CONFIG.findIndex((e) => e.name === name && e.scope === scope);
    if (i !== -1) MOCK_CONFIG.splice(i, 1);
    return;
  }
  await invoke<void>("unset_config", { scope, name });
}

// The path each DotfileKind resolves to, purely for display — the backend
// re-resolves it server-side from $HOME rather than trusting a path from here.
export const DOTFILE_DISPLAY_PATH: Record<DotfileKind, string> = {
  GitConfig: "~/.gitconfig",
  Tigrc: "~/.tigrc",
};

const MOCK_DOTFILES: Record<DotfileKind, string> = {
  GitConfig: "[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n",
  Tigrc: "",
};

export async function readDotfile(kind: DotfileKind): Promise<string> {
  if (!isTauri()) return MOCK_DOTFILES[kind];
  return invoke<string>("read_dotfile", { kind });
}

export async function writeDotfile(kind: DotfileKind, content: string): Promise<void> {
  if (!isTauri()) {
    MOCK_DOTFILES[kind] = content;
    return;
  }
  await invoke<void>("write_dotfile", { kind, content });
}

// --- Worktrees --------------------------------------------------------------

// Every worktree of the active repo, the main one first.
export async function listWorktrees(): Promise<Worktree[]> {
  if (!isTauri()) {
    const active = MOCK_WORKSPACE.repos[MOCK_WORKSPACE.active ?? -1]?.path;
    return MOCK_WORKTREES.map((w) => ({ ...w, is_current: w.path === active }));
  }
  return invoke<Worktree[]>("list_worktrees", {});
}

// `git worktree add`; a relative `path` resolves against the repo's folder.
// Returns the new worktree's absolute path.
export async function addWorktree(path: string, target: WorktreeTarget): Promise<string> {
  if (!isTauri()) {
    const full = path.startsWith("/") ? path : `${MOCK_WORKSPACE.repos[0]?.path ?? ""}/${path}`;
    const branch = target.kind === "detached" ? null : target.name;
    MOCK_WORKTREES.push({ ...MOCK_LINKED_WORKTREE, path: full, branch });
    return full;
  }
  return invoke<string>("add_worktree", { path, target });
}

// `git worktree remove`. Without `force`, git refuses a worktree with local
// changes and says to use --force (see removeWorktreeAction).
export async function removeWorktree(path: string, force: boolean): Promise<string> {
  if (!isTauri()) {
    // Every mock worktree has "changes", so preview exercises the force path.
    if (!force) throw `fatal: '${path}' contains modified or untracked files, use --force to delete it`;
    const i = MOCK_WORKTREES.findIndex((w) => w.path === path);
    if (i !== -1) MOCK_WORKTREES.splice(i, 1);
    return "";
  }
  return invoke<string>("remove_worktree", { path, force });
}

export async function lockWorktree(path: string, reason: string): Promise<string> {
  if (!isTauri()) {
    const w = MOCK_WORKTREES.find((x) => x.path === path);
    if (w) Object.assign(w, { locked: true, lock_reason: reason || null });
    return "";
  }
  return invoke<string>("lock_worktree", { path, reason });
}

export async function unlockWorktree(path: string): Promise<string> {
  if (!isTauri()) {
    const w = MOCK_WORKTREES.find((x) => x.path === path);
    if (w) Object.assign(w, { locked: false, lock_reason: null });
    return "";
  }
  return invoke<string>("unlock_worktree", { path });
}

// Forget worktrees whose folders are gone. Returns what git removed.
export async function pruneWorktrees(): Promise<string> {
  if (!isTauri()) {
    const gone = MOCK_WORKTREES.filter((w) => w.prunable);
    for (const w of gone) MOCK_WORKTREES.splice(MOCK_WORKTREES.indexOf(w), 1);
    return gone.map((w) => `Removing worktrees/${w.path.split("/").pop()}: gitdir file points to non-existent location`).join("\n");
  }
  return invoke<string>("prune_worktrees", {});
}

// --- Submodules -------------------------------------------------------------

export async function listSubmodules(): Promise<Submodule[]> {
  if (!isTauri()) return MOCK_SUBMODULES.map((m) => ({ ...m }));
  return invoke<Submodule[]>("list_submodules", {});
}

// `git submodule update --init --recursive` for the submodule at `path`, or all
// of them with null. A network operation: it may clone or fetch, so it reports
// progress and can be cancelled.
export async function updateSubmodules(path: string | null): Promise<string> {
  if (!isTauri()) {
    for (const m of MOCK_SUBMODULES) {
      if (path !== null && m.path !== path) continue;
      Object.assign(m, { checked_out: m.recorded, state: "up_to_date" });
      const i = MOCK_STATUS.unstaged.findIndex((f) => f.path === m.path);
      if (i !== -1) MOCK_STATUS.unstaged.splice(i, 1);
    }
    return `Submodule path '${path ?? MOCK_SUBMODULES[0].path}': checked out '${MOCK_SUBMODULES[0].recorded}' (preview mock)`;
  }
  return invokeNetwork<string>("update_submodules", { path });
}

// `git submodule sync --recursive`: copy URLs from .gitmodules into the config.
export async function syncSubmodules(path: string | null): Promise<string> {
  if (!isTauri()) return `Synchronizing submodule url for '${path ?? MOCK_SUBMODULES[0].path}' (preview mock)`;
  return invoke<string>("sync_submodules", { path });
}

// `git submodule add -- <url> [<path>]` (no path: git names the folder after
// the repository): clones, so it reports progress and
// can be cancelled like update. The new submodule is left staged.
export async function addSubmodule(url: string, path: string | null): Promise<string> {
  if (!isTauri()) {
    path ??= url.replace(/\/+$/, "").split("/").pop()!.replace(/\.git$/, "");
    MOCK_SUBMODULES.push({ name: path, path, url, recorded: mockOid("d"), checked_out: mockOid("d"), state: "up_to_date" });
    return `Cloning into '${path}'... (preview mock)`;
  }
  return invokeNetwork<string>("add_submodule", { url, path });
}

// `git submodule set-url`: a new URL in .gitmodules, synced into the config.
export async function setSubmoduleUrl(path: string, url: string): Promise<string> {
  if (!isTauri()) {
    const m = MOCK_SUBMODULES.find((m) => m.path === path);
    if (m) m.url = url;
    return "";
  }
  return invoke<string>("set_submodule_url", { path, url });
}

// Deinit, `git rm` and delete its clone under .git/modules; the removal is
// left staged for the user to commit.
export async function removeSubmodule(path: string): Promise<string> {
  if (!isTauri()) {
    const i = MOCK_SUBMODULES.findIndex((m) => m.path === path);
    if (i !== -1) MOCK_SUBMODULES.splice(i, 1);
    return `rm '${path}' (preview mock)`;
  }
  return invoke<string>("remove_submodule", { path });
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
          {
            header: "@@ -8,3 +10,3 @@",
            lines: [
              { origin: " ", old_lineno: 8, new_lineno: 10, content: "fn load(path: &Path) -> Result<String> {" },
              { origin: "-", old_lineno: 9, new_lineno: null, content: "    let text = fs::read_to_string(path)?;" },
              { origin: "+", old_lineno: null, new_lineno: 11, content: "    let text = fs::read_to_string(&path).context(\"read config\")?;" },
              { origin: " ", old_lineno: 10, new_lineno: 12, content: "    Ok(text)" },
            ],
          },
        ],
      },
      // No hunks, like any binary file — shown by the image diff.
      { path: "assets/logo.svg", old_path: null, status: "Modified", hunks: [] },
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
    { name: "master", is_head: false, ahead: 0, behind: 46, target: mockOid("a"), has_upstream: true },
    { name: "bugifx/login-crash", is_head: false, ahead: 0, behind: 0, target: mockOid("b"), has_upstream: false },
    { name: "develop/3.33.0", is_head: true, ahead: 2, behind: 0, target: mockOid("g"), has_upstream: true },
    { name: "development/api-v2", is_head: false, ahead: 0, behind: 0, target: mockOid("c"), has_upstream: true },
    { name: "draft-development/spike", is_head: false, ahead: 0, behind: 0, target: mockOid("d"), has_upstream: false },
    { name: "feature/dashboard", is_head: false, ahead: 3, behind: 1, target: mockOid("e"), has_upstream: true },
    { name: "feature/export", is_head: false, ahead: 0, behind: 0, target: mockOid("f"), has_upstream: true },
    { name: "hotfix/urgent-patch", is_head: false, ahead: 0, behind: 0, target: mockOid("c"), has_upstream: true },
    { name: "merge/master-to-develop", is_head: false, ahead: 0, behind: 0, target: mockOid("d"), has_upstream: true },
    { name: "pr-2444", is_head: false, ahead: 0, behind: 0, target: mockOid("b"), has_upstream: true },
    { name: "pr-2536", is_head: false, ahead: 0, behind: 0, target: mockOid("c"), has_upstream: true },
    { name: "pr-2543", is_head: false, ahead: 0, behind: 0, target: mockOid("d"), has_upstream: true },
    { name: "pr-2684-review", is_head: false, ahead: 0, behind: 0, target: mockOid("e"), has_upstream: true },
    { name: "release-hotfix-3.24.5", is_head: false, ahead: 0, behind: 0, target: mockOid("f"), has_upstream: true },
    { name: "release-hotfix-3.29.2", is_head: false, ahead: 0, behind: 0, target: mockOid("a"), has_upstream: true },
  ],
  remotes: [
    { remote: "origin", name: "origin/master", target: mockOid("a") },
    { remote: "origin", name: "origin/develop/3.33.0", target: mockOid("f") },
    { remote: "origin", name: "origin/feature/dashboard", target: mockOid("e") },
  ],
  // Same annotated/lightweight split as the fetchTagDetail mock.
  tags: [
    { name: "v3.31.2", target: mockOid("b"), message: null },
    { name: "v3.32.0", target: mockOid("d"), message: "Release v3.32.0\n\nMock annotation shown in preview mode." },
    { name: "v3.33.0", target: mockOid("g"), message: "Release v3.33.0\n\nMock annotation shown in preview mode." },
  ],
  stashes: [
    { index: 0, message: "config 3.31.2", base: mockOid("d") },
    { index: 1, message: "config 3.31 for mock", base: mockOid("b") },
  ],
  recent: [
    "feature/dashboard",
    "development/api-v2",
    "master",
    "draft-development/spike",
    "feature/export",
    "hotfix/urgent-patch",
    "pr-2444",
    "release-hotfix-3.24.5",
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

// The working tree's files as text, for the in-app editor in preview mode.
const MOCK_FILES = new Map<string, string>([
  ...MOCK_TREE.map((p): [string, string] => [p, `// ${p}\n`]),
  ["notes.md", "# Notes\n\nSome *emphasis*, `code` and a [link](https://example.com).\n\n- one\n- two\n"],
]);

// Show a saved file as modified in Local Changes, as git status would.
function mockMarkModified(path: string): void {
  const all = [...MOCK_STATUS.unstaged, ...MOCK_STATUS.staged];
  if (!all.some((f) => f.path === path)) {
    MOCK_STATUS.unstaged.push({ path, old_path: null, status: "Modified", hunks: [] });
  }
}

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
// Not in progress by default; the preview mock flips this on if a rebase step
// uses "edit" so the in-progress UI can be exercised without a real repo.
const MOCK_REBASE_STATUS: RebaseStatus = {
  in_progress: false,
  paused_for: null,
  current_sha: null,
  current_subject: null,
  conflicted_files: [],
  done: 0,
  total: 0,
};

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
    // The out-of-date mock submodule (MOCK_SUBMODULES), as git diffs one.
    {
      path: "libs/shared",
      old_path: null,
      status: "Modified",
      hunks: [
        {
          header: "@@ -1 +1 @@",
          lines: [
            { origin: "-", old_lineno: 1, new_lineno: null, content: `Subproject commit ${mockOid("c")}` },
            { origin: "+", old_lineno: null, new_lineno: 1, content: `Subproject commit ${mockOid("b")}` },
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

// Preview-only: move one hunk of `path` from `from` to `to`. Removes it from the
// source file (dropping the file when it empties) and appends it to a matching
// file in the destination (creating a shell entry if needed).
function mockMoveHunk(from: FileDiff[], to: FileDiff[], path: string, hunkIndex: number): void {
  const src = from.find((f) => f.path === path);
  if (!src || !src.hunks[hunkIndex]) return;
  const [hunk] = src.hunks.splice(hunkIndex, 1);
  let dst = to.find((f) => f.path === path);
  if (!dst) {
    dst = { path: src.path, old_path: src.old_path, status: src.status, hunks: [] };
    to.push(dst);
  }
  dst.hunks.push(hunk);
  if (src.hunks.length === 0) mockMove(from, [], path);
}

// Preview-only: take the selected [hunk, line] lines of `path` out of `from`,
// appending them as a block to the matching file in `to` (none for a discard).
// A block left with no changed line goes, and the file goes when none are left.
function mockTakeLines(from: FileDiff[], to: FileDiff[] | null, path: string, lines: [number, number][]): void {
  const src = from.find((f) => f.path === path);
  if (!src) return;
  const picked = new Set(lines.map(([h, l]) => `${h}:${l}`));
  const taken: FileDiff["hunks"] = [];
  src.hunks = src.hunks
    .map((hunk, h) => {
      const take = hunk.lines.filter((_, l) => picked.has(`${h}:${l}`));
      if (take.length > 0) taken.push({ header: hunk.header, lines: take });
      return { ...hunk, lines: hunk.lines.filter((_, l) => !picked.has(`${h}:${l}`)) };
    })
    .filter((hunk) => hunk.lines.some((l) => l.origin === "+" || l.origin === "-"));
  if (to && taken.length > 0) {
    let dst = to.find((f) => f.path === path);
    if (!dst) {
      dst = { path: src.path, old_path: src.old_path, status: src.status, hunks: [] };
      to.push(dst);
    }
    dst.hunks.push(...taken);
  }
  if (src.hunks.length === 0) mockMove(from, [], path);
}

// Preview-mode conflict scenario, resembling the reference screenshots: a merge
// of origin/merge-conflict into dev with two conflicted files. Mutated by the
// resolve/abort/finish mocks so the resolver view is fully explorable.
// Preview scenario resembling the reference repo: a common ancestor (base), and
// test-2 (ours) / test-1 (theirs) that both changed the summary line (a real
// conflict) and each added their own non-conflicting lines elsewhere.
const BASE_README = [
  "# html-pdf-printer",
  "Single Spring Boot Application",
  "Support PDF/A Compliance.",
  "",
  "## Running on local environment",
  "",
  "### Using image from registry",
  "docker run -d -p 8090:8080 img",
  "",
  "### Using IDE",
  "- Import as a maven project",
  "- Start project",
  "",
  "## Sample request/response",
  "- example one",
  "- example two",
  "- example three",
  "",
  "## Notes",
  "note line 1",
  "note line 2",
  "note line 3",
  "",
];
// Ours (test-2): rewrites the summary line, and appends its own block.
const OURS_README = BASE_README.map((l) =>
  l === "Support PDF/A Compliance." ? "Support PDF/A Compliance. (test-2)" : l,
).concat(["## From test-2", "- last block on branch test-2", ""]);
// Theirs (test-1): rewrites the summary line differently, and inserts a block
// after "- example three".
const THEIRS_README = BASE_README.flatMap((l) => {
  if (l === "Support PDF/A Compliance.") return ["Support PDF/A Compliance. (test-1)"];
  if (l === "- example three") return ["- example three", "- ljandsjkna", "- kajsdnkasd"];
  return [l];
});

const MOCK_SIDES: Record<string, ConflictSides> = {
  "README.md": {
    ours: `${OURS_README.join("\n")}\n`,
    theirs: `${THEIRS_README.join("\n")}\n`,
    base: `${BASE_README.join("\n")}\n`,
    working: "<<<<<<< HEAD\n(conflict)\n=======\n(conflict)\n>>>>>>> test-1\n",
    binary: false,
  },
  "reset.css": {
    ours: "body {\n  margin: 10px;\n}\n",
    theirs: "body {\n  margin: 20px;\n}\n",
    base: "body {\n  margin: 0;\n}\n",
    working: "body {\n<<<<<<< HEAD\n  margin: 10px;\n=======\n  margin: 20px;\n>>>>>>> test-1\n}\n",
    binary: false,
  },
};

let MOCK_CONFLICT: ConflictStatus = {
  kind: "merge",
  summary: "Merge remote-tracking branch 'origin/test-1' into test-2",
  conflicted: ["README.md", "reset.css"],
  message: "Merge remote-tracking branch 'origin/test-1' into test-2\n",
};

export const MOCK_CONFIG: ConfigEntry[] = [
  { name: "user.name", value: "Ada Lovelace", scope: "Global" },
  { name: "user.email", value: "ada@example.com", scope: "Global" },
  { name: "core.editor", value: "vim", scope: "Global" },
  { name: "init.defaultBranch", value: "main", scope: "Global" },
  { name: "remote.origin.url", value: "git@github.com:ada/gitp.git", scope: "Local" },
  { name: "branch.main.remote", value: "origin", scope: "Local" },
  { name: "core.autocrlf", value: "input", scope: "System" },
];

// --- Reflog -----------------------------------------------------------------

// Up to 500 entries of `refname`'s reflog (`HEAD` or `refs/heads/<name>`),
// newest first.
export async function fetchReflog(refname: string): Promise<ReflogEntry[]> {
  if (!isTauri()) {
    const short = refname.replace(/^refs\/heads\//, "");
    // A branch's own reflog has only the moves of that branch, not checkouts.
    const entries = refname === "HEAD" ? MOCK_REFLOG : MOCK_REFLOG.filter((e) => !e.message.startsWith("checkout:"));
    return entries.map((e, index) => ({ ...e, index, selector: `${short}@{${index}}` }));
  }
  return invoke<ReflogEntry[]>("get_reflog", { refname });
}

// HEAD's reflog in preview mode: commits, a checkout, an amend, and a hard
// reset whose commit (`9…`) is in no mock row — as if it had been pruned — so
// its summary is null.
const MOCK_REFLOG: Omit<ReflogEntry, "index" | "selector">[] = [
  mkReflog("g", "f", "merge feature/widget: Merge made by the 'ort' strategy.", BASE + 6 * DAY),
  mkReflog("f", "9", "reset: moving to HEAD~1", BASE + 5 * DAY + 600),
  mkReflog("9", "f", "commit: wip: try a different loader", BASE + 5 * DAY + 300),
  mkReflog("f", "d", "commit (amend): docs: expand config guide", BASE + 5 * DAY),
  mkReflog("d", "e", "checkout: moving from feature/widget to develop/3.33.0", BASE + 4 * DAY + 60),
  mkReflog("e", "c", "commit: feat: add dashboard widget", BASE + 4 * DAY),
  mkReflog("c", "b", "commit: feat: add config loader", BASE + 2 * DAY),
  mkReflog("b", "a", "commit: chore: initial layout", BASE + DAY),
  mkReflog("a", "0", "commit (initial): chore: initial commit", BASE),
];

function mkReflog(to: string, from: string, message: string, time: number): Omit<ReflogEntry, "index" | "selector"> {
  const newId = mockOid(to);
  return {
    new_id: newId,
    short_id: newId.slice(0, 7),
    old_id: mockOid(from),
    message,
    committer: "Ada Lovelace",
    time,
    summary: MOCK_LOG.find((r) => r.id === newId)?.summary ?? null,
  };
}

// --- Activity log -----------------------------------------------------------

// The git commands gitp ran for the active repo, newest first; with `since`,
// only those after that entry id.
export async function fetchActivityLog(since: number | null = null): Promise<ActivityEntry[]> {
  if (!isTauri()) return MOCK_ACTIVITY.filter((e) => since === null || e.id > since);
  return invoke<ActivityEntry[]>("get_activity_log", { since });
}

export async function clearActivityLog(): Promise<void> {
  if (!isTauri()) {
    MOCK_ACTIVITY.length = 0;
    return;
  }
  await invoke<void>("clear_activity_log", {});
}

// Preview mode: a push, a commit a pre-commit hook rejected, and the quiet
// probes a refresh runs around them.
const MOCK_ACTIVITY: ActivityEntry[] = (() => {
  const now = Date.now();
  const at = (secondsAgo: number) => now - secondsAgo * 1000;
  const ok = { exit_code: 0, success: true, stderr: "", stdout: "" };
  return [
    { id: 9, started_at: at(5), duration_ms: 31, command: "git --no-optional-locks status --porcelain=v1 -z --untracked-files=all", quiet: true, ...ok },
    {
      id: 8,
      started_at: at(8),
      duration_ms: 1840,
      command: "git push --progress -u origin feature/widget",
      quiet: false,
      ...ok,
      stderr: "To github.com:ada/gitp.git\n * [new branch]      feature/widget -> feature/widget\nbranch 'feature/widget' set up to track 'origin/feature/widget'.",
    },
    { id: 7, started_at: at(40), duration_ms: 212, command: "git commit -m 'feat: add dashboard widget'", quiet: false, ...ok },
    { id: 6, started_at: at(41), duration_ms: 9, command: "git config --get commit.gpgsign", quiet: true, exit_code: 1, success: false, stderr: "", stdout: "" },
    {
      id: 5,
      started_at: at(95),
      duration_ms: 3120,
      command: "git commit -m 'feat: add dashboard widget'",
      quiet: false,
      exit_code: 1,
      success: false,
      stderr: "eslint.....................................................Failed\n- hook id: eslint\n- exit code: 1\n\nsrc/widget.ts\n  12:7  error  'unused' is assigned a value but never used  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)",
      stdout: "",
    },
    { id: 4, started_at: at(120), duration_ms: 14, command: "git add -- :(literal)src/widget.ts", quiet: false, ...ok },
    { id: 3, started_at: at(122), duration_ms: 27, command: "git diff -- src/widget.ts", quiet: true, ...ok },
    { id: 2, started_at: at(300), duration_ms: 2410, command: "git fetch --progress --all --prune", quiet: false, ...ok, stderr: "From github.com:ada/gitp\n   b5b31e4..ec1daa1  main       -> origin/main" },
    { id: 1, started_at: at(302), duration_ms: 18, command: "git worktree list --porcelain -z", quiet: true, ...ok },
  ];
})();

// --- Comparing two revisions ------------------------------------------------

// The revs naming the empty tree and the working directory as a side of a
// comparison — gitp-core's EMPTY_REV and WORKDIR_REV. Their ends come back
// with no id.
export const EMPTY_REV = "Empty Tree";
export const WORKDIR_REV = "Working Directory";

// What differs between `base` and `head` (ref names or ids). `threeDot` diffs
// from their merge base — only what `head` added since they diverged.
export async function compareRevs(base: string, head: string, threeDot: boolean): Promise<Comparison> {
  if (!isTauri()) return mockCompare(base, head, threeDot);
  return invoke<Comparison>("compare_revs", { base, head, threeDot });
}

// One file of a comparison re-diffed with `contextLines` of context — the
// compare counterpart of fetchCommitFileDiff.
export async function fetchCompareFileDiff(
  cmp: Comparison,
  file: FileDiff,
  contextLines: number,
  ignoreWhitespace: boolean,
  full = false,
): Promise<FileDiff | null> {
  if (!isTauri()) return cmp.files.find((f) => f.path === file.path) ?? null;
  return invoke<FileDiff | null>("get_compare_file_diff", {
    base: cmp.base.rev,
    head: cmp.head.rev,
    threeDot: cmp.three_dot,
    path: file.path,
    oldPath: file.old_path,
    contextLines,
    ignoreWhitespace,
    full,
  });
}

// Preview mode: resolve against the mock log and refs, count the rows between
// the two as ahead/behind, and show the mock commit's files — fewer of them in
// three-dot mode, so the toggle visibly does something.
function mockCompare(base: string, head: string, threeDot: boolean): Comparison {
  const resolve = (rev: string): CompareEnd => {
    if (rev === EMPTY_REV || rev === WORKDIR_REV) return { rev, id: "", short_id: "", summary: "" };
    const target =
      [...MOCK_REFS.branches, ...MOCK_REFS.remotes, ...MOCK_REFS.tags].find((r) => r.name === rev)?.target ??
      (rev === "HEAD" ? MOCK_LOG[0].id : rev);
    const row = MOCK_LOG.find((r) => r.id === target || r.short_id === target);
    if (!row) throw new Error(`revspec '${rev}' not found`);
    return { rev, id: row.id, short_id: row.short_id, summary: row.summary };
  };
  const b = resolve(base);
  const h = resolve(head);
  // The empty tree sits below the oldest commit; the working directory is HEAD.
  const depth = (end: CompareEnd) =>
    end.id ? MOCK_LOG.findIndex((r) => r.id === end.id) : end.rev === WORKDIR_REV ? 0 : MOCK_LOG.length;
  const distance = depth(b) - depth(h);
  const files = b.id === h.id ? [] : mockDetail(h.id).files;
  return {
    base: b,
    head: h,
    three_dot: threeDot,
    merge_base: MOCK_LOG[MOCK_LOG.length - 1].id,
    ahead: Math.max(0, distance),
    behind: Math.max(0, -distance),
    files: threeDot ? files.slice(0, 1) : files,
  };
}

// --- Bisect ------------------------------------------------------------------

export async function bisectStatus(): Promise<BisectStatus | null> {
  if (!isTauri()) return MOCK_BISECT && { ...MOCK_BISECT };
  return invoke<BisectStatus | null>("bisect_status", {});
}

// Start a bisect. With `bad` set git checks out the first commit to test right
// away; `good` may be empty, leaving the session waiting for a good commit.
export async function bisectStart(bad: string | null, good: string[]): Promise<string> {
  if (!isTauri()) {
    const head = mockOid("g");
    MOCK_BISECT = {
      bad: bad === "HEAD" ? head : bad,
      good,
      skipped: [],
      current: good.length ? mockOid("d") : head,
      current_summary: good.length ? "fix: config loader precedence" : "Merge branch 'feature/widget'",
      remaining_estimate: good.length ? [2, 1] : null,
      first_bad: null,
      first_bad_summary: null,
      original_ref: MOCK_REFS.head ?? head,
    };
    return "Bisecting: 2 revisions left to test after this (roughly 1 step) (preview mock)";
  }
  return invoke<string>("bisect_start", { bad, good });
}

// Mark `rev` — the commit under test when null — and let git pick the next.
export async function bisectMark(mark: BisectMark, rev: string | null): Promise<string> {
  if (!isTauri()) {
    const b = MOCK_BISECT;
    if (!b) throw new Error("We are not bisecting.");
    const id = rev ?? b.current;
    if (mark === "skip") {
      b.skipped.push(id);
      b.current = mockOid("e");
      b.current_summary = "feat: add dashboard widget";
      return `Bisecting: 1 revision left to test after this (roughly 1 step) (preview mock)`;
    }
    if (mark === "good") b.good.push(id);
    else b.bad = id;
    // Pretend one step was enough: whatever is still marked bad is the culprit.
    if (b.bad && b.good.length) {
      const row = MOCK_LOG.find((r) => r.id === b.bad);
      b.first_bad = b.bad;
      b.first_bad_summary = row?.summary ?? "";
      b.remaining_estimate = null;
      return `${b.bad} is the first bad commit (preview mock)`;
    }
    return `Marked ${id.slice(0, 7)} ${mark} (preview mock)`;
  }
  return invoke<string>("bisect_mark", { mark, rev });
}

export async function bisectReset(): Promise<string> {
  if (!isTauri()) {
    const back = MOCK_BISECT?.original_ref ?? "";
    MOCK_BISECT = null;
    return `Switched to branch '${back}' (preview mock)`;
  }
  return invoke<string>("bisect_reset", {});
}

// A bisect already under way in preview mode, so the banner and the log
// markers can be looked at without a real repo: f is bad, b good, d skipped,
// and c is the commit being tested.
let MOCK_BISECT: BisectStatus | null = {
  bad: mockOid("f"),
  good: [mockOid("b")],
  skipped: [mockOid("d")],
  current: mockOid("c"),
  current_summary: "feat: add config loader",
  remaining_estimate: [1, 1],
  first_bad: null,
  first_bad_summary: null,
  original_ref: "develop/3.33.0",
};

// The mock repo's own worktree plus one linked worktree, so the Worktrees
// section shows in preview.
const MOCK_LINKED_WORKTREE: Worktree = {
  path: "/Users/you/Documents/mideal-feature-dashboard",
  head: mockOid("e"),
  branch: "feature/dashboard",
  is_main: false,
  is_current: false,
  locked: false,
  lock_reason: null,
  prunable: false,
};

const MOCK_WORKTREES: Worktree[] = [
  { ...MOCK_LINKED_WORKTREE, path: "/Users/you/Documents/mideal", head: mockOid("g"), branch: "develop/3.33.0", is_main: true },
  { ...MOCK_LINKED_WORKTREE },
];

// One submodule, with an older commit checked out than the repo records.
const MOCK_SUBMODULES: Submodule[] = [
  {
    name: "libs/shared",
    path: "libs/shared",
    url: "https://github.com/example/shared.git",
    recorded: mockOid("c"),
    checked_out: mockOid("b"),
    state: "modified",
  },
];
