import "./styles.css";
import {
  activateRepo,
  browseForRepo,
  checkoutBranch,
  checkoutRemoteBranch,
  checkoutCommit,
  deleteRemoteTag,
  deleteTag,
  fetchTagDetail,
  pushTag,
  remoteTagExists,
  cherryPick,
  closeRepo,
  commitChanges,
  confirmDialog,
  createBranch,
  createBranchAt,
  createPullRequest,
  createTagAt,
  deleteBranch,
  deleteBranches,
  deleteRemoteBranch,
  remoteBranchExists,
  discardHunk,
  fastForwardBranch,
  fetchAll,
  fetchAndUpdateBranch,
  fetchBlame,
  fetchBranch,
  fetchCommitDetail,
  fetchCommitTree,
  fetchConfig,
  goneBranches,
  fetchRemote,
  DOTFILE_DISPLAY_PATH,
  readDotfile,
  writeDotfile,
  fetchFileHistory,
  fetchFileDiff,
  fetchLogPage,
  logIndexOf,
  searchLog,
  createBackupBranch,
  fetchRebaseStatus,
  fetchRebaseTodo,
  fetchStatusSummary,
  interactiveRebase,
  isTauri,
  listRepos,
  mergeBranch,
  openRepo,
  pull,
  push,
  pushForce,
  pushBranch,
  undo,
  redo,
  rebaseAbort,
  rebaseContinue,
  rebaseSkip,
  rebaseOnto,
  renameBranch,
  renameRemoteBranch,
  resetTo,
  revertCommit,
  saveConfig,
  setUpstream,
  unsetUpstream,
  stage,
  stageAll,
  stageHunk,
  stash,
  stashPop,
  applyStash,
  dropStash,
  renameStash,
  saveStashPatch,
  conflictStatus,
  conflictSides,
  resolveConflict,
  resolveConflictSide,
  abortConflict,
  finishConflict,
  discardFiles,
  stashFiles,
  saveFilesPatch,
  addToGitignore,
  revealPath,
  openInEditor,
  workspaceSnapshot,
  unstage,
  unstageAll,
  unstageHunk,
} from "./api";
import { ensureAvatars } from "./avatar";
import { clear, el } from "./dom";
import { GRAPH_METRICS } from "./graph";
import { renderLog, type LogHandle, type RefLabel } from "./views/log";
import { showCommitMenu, closeCommitMenu } from "./views/commit-menu";
import { showContextMenu, type MenuItem } from "./views/context-menu";
import { openRebaseModal, type RebaseOptions } from "./views/rebase";
import { openDeleteBranchModal, openDeleteTagModal } from "./views/delete-branch";
import { openRenameBranchModal } from "./views/rename-branch";
import { showErrorDialog, type MessageDialogAction } from "./views/message-dialog";
import { openTagDetailsModal } from "./views/tag-details";
import { relativeTime } from "./timeago";
import { toast } from "./views/toast";
import { openStashApplyModal } from "./views/stash-apply";
import { setupDetail, type DetailHandle, type DetailTab } from "./views/detail";
import { setupChanges, type ChangesHandle } from "./views/changes";
import { setupConflict, type ConflictHandle } from "./views/conflict";
import { renderConfig } from "./views/config";
import { renderDotfiles } from "./views/dotfiles";
import { openFetchDialog } from "./views/fetch-dialog";
import { renderSidebar, type SidebarView } from "./views/sidebar";
import {
  closeQuickLaunch,
  isQuickLaunchOpen,
  showQuickLaunch,
  type QuickItem,
  type QuickStage,
} from "./views/quick-launch";
import { setupTerminal, type TerminalHandle } from "./views/terminal";
import type {
  BranchRef,
  CommitRow,
  ConfigScope,
  ConflictStatus,
  DotfileKind,
  LogPage,
  PullMode,
  RebaseAction,
  RebaseStatus,
  RebaseStep,
  Refs,
  RepoTab,
  ResetMode,
  StashRef,
  UndoState,
  Workspace,
} from "./types";

type View = "history" | "changes" | "config" | "conflict";

const EMPTY_REFS: Refs = { head: null, branches: [], remotes: [], tags: [], stashes: [], recent: [] };

// Commits loaded per page. The first page makes the repo openable instantly;
// more are appended as the user scrolls (see loadMoreCommits).
const PAGE_SIZE = 1000;

interface State {
  repoPath: string;
  repos: RepoTab[];
  rows: CommitRow[];
  total: number;
  selectedId: string | null;
  view: View;
  refs: Refs;
  localChanges: number;
  sbFilter: string;
  sbCollapsed: Set<string>;
  rebase: RebaseStatus | null;
  conflict: ConflictStatus | null;
  // History graph shows all branches (true) or just the current branch (false).
  allBranches: boolean;
  // Cmd/Shift-click multi-selection, for bulk actions — see log.ts / sidebar.ts.
  // Separate from `selectedId` (the one commit the detail pane follows).
  commitSelection: Set<string>;
  // Local-branch names only; bulk actions (delete) don't apply to remotes/tags.
  branchSelection: Set<string>;
  // The last plain/Cmd-clicked branch — the Shift-click range anchor.
  branchSelectionAnchor: string | null;
  // Refs with an operation in flight — see withBusyRef.
  busyRefs: Set<string>;
}

const state: State = {
  repoPath: "",
  repos: [],
  rows: [],
  total: 0,
  selectedId: null,
  view: "history",
  refs: EMPTY_REFS,
  localChanges: 0,
  sbFilter: "",
  // Recent starts collapsed — it's a quick-switch shortcut, not the primary list.
  // Tags and Remotes too: on a real repo they're the two largest sections by far
  // (hundreds of rows each), and expanding them is a deliberate act, not the
  // default view. Keeping them shut is what makes the first paint cheap.
  sbCollapsed: new Set(["sec:recent", "sec:remotes", "sec:tags"]),
  allBranches: true,
  commitSelection: new Set(),
  branchSelection: new Set(),
  branchSelectionAnchor: null,
  busyRefs: new Set(),
  rebase: null,
  conflict: null,
};
let terminal: TerminalHandle | null = null;
let detailView: DetailHandle | null = null;
let changesView: ChangesHandle | null = null;
let conflictView: ConflictHandle | null = null;
// The live log's handle, from the most recent renderLog — the log view owns
// keyboard movement through the rows it has on screen (see LogHandle).
let logView: LogHandle | null = null;
let loadingMore = false;
// Which repo `state.rows` was loaded from — history from a previous tab must
// never be mistaken for the active repo's (see historyUnchanged).
let rowsRepoPath = "";
// The commit id whose detail is currently rendered in detailView. Commits are
// immutable, so re-selecting the same id (e.g. switching back to History)
// never needs to re-fetch and re-diff it — see selectCommit.
let shownDetailId: string | null = null;

// Labels of refs whose tip is this commit — shown as chips in the Commit tab.
function refsAt(id: string): string[] {
  const labels: string[] = [];
  for (const b of state.refs.branches) if (b.target === id) labels.push(b.name);
  for (const r of state.refs.remotes) if (r.target === id) labels.push(r.name);
  for (const t of state.refs.tags) if (t.target === id) labels.push(t.name);
  return labels;
}

// For the log-row hover chips we want the branches/tags that CONTAIN each
// commit (so every commit shows its branch), not just the tips. Computed once
// per log/ref change by seeding each ref at its tip and propagating the label to
// ancestors over the loaded commit graph.
let commitRefs = new Map<string, RefLabel[]>();

function refLabelsAt(id: string): RefLabel[] {
  return commitRefs.get(id) ?? [];
}

// rebuildCommitRefs does a BFS from every branch tip over the whole loaded log
// (O(branches × loaded commits)) — real cost on a repo with many branches or a
// long history. It's called from loadSidebar() after nearly every action, and
// now also from the periodic background remote fetch, most of which don't
// actually move any ref (staging a file, popping a stash, an idle refresh that
// found nothing new upstream). Skip the rebuild when neither the loaded rows
// nor the refs' targets have changed since last time.
let lastCommitRefsRows: CommitRow[] | null = null;
let lastCommitRefsSig = "";

function refsSignature(): string {
  const r = state.refs;
  return [
    r.branches.map((b) => `${b.name}:${b.target}:${b.is_head ? 1 : 0}`).join(","),
    r.tags.map((t) => `${t.name}:${t.target}`).join(","),
    r.remotes.map((rm) => `${rm.name}:${rm.target}`).join(","),
  ].join("|");
}

function rebuildCommitRefs(): void {
  const sig = refsSignature();
  if (state.rows === lastCommitRefsRows && sig === lastCommitRefsSig) return;
  lastCommitRefsRows = state.rows;
  lastCommitRefsSig = sig;
  const byId = new Map(state.rows.map((r) => [r.id, r]));
  // Per commit: candidate labels with the distance (in commits) from the ref tip
  // and a stable tie-break order. Sorted nearest-first so a commit shows the
  // most-specific branch it belongs to; the current branch only leads on commits
  // that are near its tip (or that no other branch contains).
  interface Cand {
    label: RefLabel;
    dist: number;
    order: number;
  }
  const cands = new Map<string, Cand[]>();
  let order = 0;

  const add = (cid: string, label: RefLabel, dist: number, ord: number) => {
    if (!byId.has(cid)) return;
    const arr = cands.get(cid) ?? [];
    const existing = arr.find((c) => c.label.name === label.name);
    if (existing) {
      if (dist < existing.dist) existing.dist = dist;
      return;
    }
    arr.push({ label, dist, order: ord });
    cands.set(cid, arr);
  };

  // Breadth-first from a branch tip so every contained commit gets its hop
  // distance from that tip.
  const bfs = (tip: string, label: RefLabel) => {
    if (!byId.has(tip)) return;
    const ord = order++;
    const seen = new Set([tip]);
    let frontier = [tip];
    let dist = 0;
    while (frontier.length) {
      for (const id of frontier) add(id, label, dist, ord);
      const next: string[] = [];
      for (const id of frontier) {
        const row = byId.get(id);
        if (!row) continue;
        for (const p of row.parents) {
          if (byId.has(p) && !seen.has(p)) {
            seen.add(p);
            next.push(p);
          }
        }
      }
      frontier = next;
      dist++;
    }
  };

  // Non-current branches first so they win ties over the current branch. Tags
  // and remotes stay at their tip only.
  for (const b of state.refs.branches) if (!b.is_head) bfs(b.target, { name: b.name, kind: "branch" });
  const head = state.refs.branches.find((b) => b.is_head);
  if (head) bfs(head.target, { name: head.name, kind: "head" });
  for (const t of state.refs.tags) add(t.target, { name: t.name, kind: "tag" }, 0, order++);
  for (const r of state.refs.remotes) add(r.target, { name: r.name, kind: "remote" }, 0, order++);

  const labels = new Map<string, RefLabel[]>();
  for (const [cid, arr] of cands) {
    arr.sort((a, b) => a.dist - b.dist || a.order - b.order);
    labels.set(cid, arr.map((c) => c.label));
  }
  commitRefs = labels;
}

const $ = <T extends HTMLElement>(sel: string): T => {
  const node = document.querySelector<T>(sel);
  if (!node) throw new Error(`missing element: ${sel}`);
  return node;
};

// Render a status message. In-progress messages end with an ellipsis (e.g.
// "Pushing…", "Checking out main…"); those show a spinner so any slow action
// has clear in-app feedback instead of relying on the OS wait cursor.
function setStatus(message: string): void {
  const slot = $("#status-message");
  const busy = message.trimEnd().endsWith("…") || message.trimEnd().endsWith("...");
  clear(slot);
  if (busy) slot.append(el("span", { class: "status-spinner", "aria-hidden": "true" }));
  slot.append(el("span", { class: "status-text", text: message }));
  $("#statusbar").classList.toggle("busy", busy);
}

// --- Fetch freshness -------------------------------------------------------
//
// Every ahead/behind count in the sidebar is only as current as the last fetch,
// and there was no way to tell whether that was ten seconds or forty minutes
// ago. Per repo, because the counts are per repo: switching to a tab that hasn't
// been fetched in an hour shouldn't claim the freshness of the one you left.

const remoteFetchedAt = new Map<string, number>();
// How often the label is re-rendered. Only a text write, so the cost is nil and
// "1m ago" doesn't sit there reading "just now".
const FETCH_AGE_TICK_MS = 30_000;

function markRemoteFetched(): void {
  if (state.repoPath) remoteFetchedAt.set(state.repoPath, Date.now());
  renderFetchAge();
}

function fetchAgeLabel(at: number | undefined): string {
  if (at === undefined) return "not fetched yet";
  return `fetched ${relativeTime(Math.floor(at / 1000))}`;
}

function renderFetchAge(): void {
  const slot = $("#status-fetched");
  slot.classList.toggle("hidden", !state.repoPath);
  if (!state.repoPath) return;
  slot.textContent = fetchAgeLabel(remoteFetchedAt.get(state.repoPath));
}

function setupFetchAgeIndicator(): void {
  renderFetchAge();
  window.setInterval(renderFetchAge, FETCH_AGE_TICK_MS);
}

// --- Reporting outcomes ----------------------------------------------------
//
// The status bar keeps saying what the app is doing, but on its own it's one
// line in the corner furthest from where you're looking. Every outcome worth
// noticing also goes to a toast:
//
//   readFailed  — a read/refresh that failed. Sticky toast; no modal, because
//                 there's no decision to make and nothing was changed.
//   opFailed    — an operation that mutates the repo failed. Sticky toast plus
//                 the modal, which is where git's full output and any recovery
//                 actions (Pull / Force Push / Resolve Conflicts) live.
//   reportDone  — an async outcome ("Pull complete", "Deleted 2 branches")
//                 that would otherwise land silently in the status line.
//
// Synchronous chatter ("3 commits match", "Jumped to main") stays on the
// status line alone — a toast per keystroke-settled search is noise.

function readFailed(title: string, err: unknown): void {
  const detail = String(err);
  setStatus(`${title}: ${detail}`);
  toast(title, {
    kind: "error",
    onDetails: () => showErrorDialog(title, detail),
  });
}

function opFailed(
  title: string,
  err: unknown,
  actions?: MessageDialogAction | MessageDialogAction[],
): void {
  const detail = String(err);
  setStatus(`${title}: ${detail}`);
  showErrorDialog(title, detail, actions);
  toast(title, { kind: "error", onDetails: () => showErrorDialog(title, detail, actions) });
}

function reportDone(message: string): void {
  setStatus(message);
  // Git's own output can run to several lines (a pull summary, a stash listing)
  // and a toast clips it — offer the full text rather than truncating silently.
  const clipped = message.includes("\n");
  toast(message, {
    kind: "success",
    onDetails: clipped ? () => showErrorDialog("Result", message) : undefined,
  });
}

// --- Persisted preferences (localStorage) ----------------------------------

const ALL_BRANCHES_KEY = "gitp-all-branches";
const REPOS_KEY = "gitp-repos";
const PULL_DEFAULT_KEY = "gitp-pull-default";
// Which commit-detail tab to open with. The pane already keeps your last tab as
// you move between commits; this carries that across restarts too.
const DETAIL_TAB_KEY = "gitp-detail-tab";

function loadDetailTab(): DetailTab {
  const saved = localStorage.getItem(DETAIL_TAB_KEY);
  // Changes is the default: a commit click should show what changed.
  return saved === "commit" || saved === "changes" || saved === "tree" ? saved : "changes";
}

function saveDetailTab(tab: DetailTab): void {
  localStorage.setItem(DETAIL_TAB_KEY, tab);
}

// What the plain Pull button runs. "FetchAll" isn't a real pull (no merge) but
// is offered alongside the pull strategies, GitKraken-style.
type PullDefault = "FetchAll" | PullMode;
const PULL_DEFAULTS: PullDefault[] = ["FetchAll", "FastForward", "FastForwardOnly", "Rebase"];
const PULL_DEFAULT_LABEL: Record<PullDefault, string> = {
  FetchAll: "Fetch All",
  FastForward: "Pull (fast-forward if possible)",
  FastForwardOnly: "Pull (fast-forward only)",
  Rebase: "Pull (rebase)",
};

function loadPullDefault(): PullDefault {
  const v = localStorage.getItem(PULL_DEFAULT_KEY);
  return (PULL_DEFAULTS as string[]).includes(v ?? "") ? (v as PullDefault) : "FastForward";
}
function savePullDefault(mode: PullDefault): void {
  localStorage.setItem(PULL_DEFAULT_KEY, mode);
  updatePullButtonTitle();
}
function updatePullButtonTitle(): void {
  $<HTMLButtonElement>("#pull-btn").title = PULL_DEFAULT_LABEL[loadPullDefault()];
}

// The history toggle, persisted across restarts. Defaults to all branches.
function loadAllBranches(): boolean {
  return localStorage.getItem(ALL_BRANCHES_KEY) !== "current";
}
function saveAllBranches(all: boolean): void {
  localStorage.setItem(ALL_BRANCHES_KEY, all ? "all" : "current");
}

// The open repos + which is active, so the last workspace reopens on restart.
// Only persisted in the desktop shell (preview uses mock repos).
function saveWorkspace(): void {
  if (!isTauri()) return;
  const data = { paths: state.repos.map((r) => r.path), active: state.repoPath };
  localStorage.setItem(REPOS_KEY, JSON.stringify(data));
}
// Repositories opened before, most recent first — Quick Launch's top section.
//
// The workspace list (REPOS_KEY) only holds what's open *now*, so it can't
// answer "that repo I was in last week". This is a separate MRU that only
// grows, capped at MAX_RECENT_REPOS.
function loadRecentRepos(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_REPOS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function rememberRecentRepo(path: string): void {
  if (!path) return;
  const next = [path, ...loadRecentRepos().filter((p) => p !== path)].slice(0, MAX_RECENT_REPOS);
  localStorage.setItem(RECENT_REPOS_KEY, JSON.stringify(next));
}

function forgetRecentRepo(path: string): void {
  localStorage.setItem(
    RECENT_REPOS_KEY,
    JSON.stringify(loadRecentRepos().filter((p) => p !== path)),
  );
}

function loadWorkspace(): { paths: string[]; active: string } | null {
  try {
    const raw = localStorage.getItem(REPOS_KEY);
    return raw ? (JSON.parse(raw) as { paths: string[]; active: string }) : null;
  } catch {
    return null;
  }
}

// --- Theme (System / Light / Dark) -----------------------------------------

type ThemeChoice = "system" | "light" | "dark";
const THEME_KEY = "gitp-theme";
const RECENT_REPOS_KEY = "gitp-recent-repos";
// Enough to fill Quick Launch's list without it becoming an archive.
const MAX_RECENT_REPOS = 12;

function currentTheme(): ThemeChoice {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

// Apply and persist a theme. "system" clears the override so CSS follows the OS
// via prefers-color-scheme; "light"/"dark" force the palette via data-theme.
function applyTheme(choice: ThemeChoice): void {
  if (choice === "system") {
    document.documentElement.removeAttribute("data-theme");
    localStorage.removeItem(THEME_KEY);
  } else {
    document.documentElement.dataset.theme = choice;
    localStorage.setItem(THEME_KEY, choice);
  }
  // xterm keeps its palette as JS values, so the CSS change alone leaves the
  // terminal on the old theme until it's told.
  terminal?.syncTheme();
}

function updateThemeMenu(): void {
  const cur = currentTheme();
  for (const b of document.querySelectorAll<HTMLElement>("#settings-menu [data-theme-choice]")) {
    b.classList.toggle("active", b.dataset.themeChoice === cur);
  }
}

// Open a repo as a new tab (or switch to it if already open), then show its log.
async function loadRepo(path: string): Promise<void> {
  try {
    applyWorkspace(await openRepo(path));
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    setStatus(`Opened ${state.repoPath} · ${state.total} commits`);
  } catch (err) {
    readFailed("Failed to open repo", err);
  }
}

// Reopen the repos from the last session. Skips paths that no longer open
// (moved/deleted), restores the previously active tab, and loads its history.
// Returns false when there's nothing saved or nothing could be reopened.
async function restoreWorkspace(): Promise<boolean> {
  const saved = loadWorkspace();
  if (!saved || saved.paths.length === 0) return false;

  let opened = 0;
  for (const path of saved.paths) {
    try {
      applyWorkspace(await openRepo(path));
      opened++;
    } catch {
      // Repo moved or deleted since last run — drop it silently.
    }
  }
  if (opened === 0) return false;

  if (saved.active && saved.active !== state.repoPath && state.repos.some((r) => r.path === saved.active)) {
    try {
      applyWorkspace(await activateRepo(saved.active));
    } catch {
      // fall back to whatever is active
    }
  }
  showView("history");
  await Promise.all([refreshHistory(), loadSidebar()]);
  setStatus(`Reopened ${opened} repo${opened === 1 ? "" : "s"} · ${state.total} commits`);
  return true;
}

// Adopt the backend's workspace as the source of truth for the tab bar and the
// active repo. Does not itself load history — callers decide when to refresh.
function applyWorkspace(ws: Workspace): void {
  state.repos = ws.repos;
  const active = ws.active != null ? ws.repos[ws.active] : undefined;
  state.repoPath = active?.path ?? "";
  rememberRecentRepo(state.repoPath);
  renderRepoTabs();
  $("#action-bar").classList.toggle("hidden", state.repos.length === 0);
  $<HTMLInputElement>("#repo-input").value = state.repoPath;
  if (state.repoPath) terminal?.setCwd(state.repoPath);
  saveWorkspace();
}

function renderRepoTabs(): void {
  const host = $("#repo-tabs");
  host.classList.toggle("hidden", state.repos.length === 0);
  clear(host);
  for (const repo of state.repos) {
    const active = repo.path === state.repoPath;
    const tab = el("div", { class: `repo-tab${active ? " active" : ""}`, title: repo.path }, [
      repo.name,
    ]);
    tab.addEventListener("click", () => void switchRepo(repo.path));
    const close = el("span", { class: "repo-tab-close", title: "Close" }, ["×"]);
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      void closeRepoTab(repo.path);
    });
    tab.append(close);
    host.append(tab);
  }
}

async function switchRepo(path: string): Promise<void> {
  if (path === state.repoPath) return;
  try {
    applyWorkspace(await activateRepo(path));
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    setStatus(`Switched to ${state.repoPath} · ${state.total} commits`);
  } catch (err) {
    readFailed("Failed to switch repo", err);
  }
}

async function closeRepoTab(path: string): Promise<void> {
  const wasActive = path === state.repoPath;
  try {
    applyWorkspace(await closeRepo(path));
    if (state.repos.length === 0) {
      state.rows = [];
      rowsRepoPath = "";
      state.total = 0;
      state.selectedId = null;
      state.refs = EMPTY_REFS;
      state.localChanges = 0;
      logView = renderLog($("#log-pane"), [], null, selectCommit, loadMoreCommits, undefined, undefined, state.commitSelection, onCommitMultiSelect);
      shownDetailId = null;
      detailView?.showEmpty();
      renderSidebarNow();
      setStatus("No repository open.");
    } else if (wasActive) {
      showView("history");
      await Promise.all([refreshHistory(), loadSidebar()]);
      setStatus(`Switched to ${state.repoPath} · ${state.total} commits`);
    }
  } catch (err) {
    readFailed("Failed to close repo", err);
  }
}

// `keepSelection`: preserve the current selection if it's still in the
// reloaded rows, instead of jumping to the newest commit. Mutating actions
// (commit/checkout/merge/reset/…) want the default jump-to-HEAD behavior;
// passive/background refreshes (tab switch, branch click) don't — they'd
// otherwise yank the view away from whatever the user just clicked.
async function refreshHistory(opts: { keepSelection?: boolean } = {}): Promise<void> {
  const page = await fetchLogPage(0, PAGE_SIZE, state.allBranches);
  // A passive refresh that found history unchanged: keep the rows we already
  // have — including every page loaded by scrolling — and skip the re-render.
  // `state.rows` keeps its identity, so the log's graph-layout cache stays
  // valid too (see getLayout in log.ts), making a tab switch nearly free.
  if (opts.keepSelection && historyUnchanged(page)) return;
  state.rows = page.rows;
  rowsRepoPath = state.repoPath;
  state.total = page.total;
  const keep = Boolean(opts.keepSelection && state.selectedId && state.rows.some((r) => r.id === state.selectedId));
  if (!keep) state.selectedId = state.rows[0]?.id ?? null;
  // Drop any multi-selected commits that no longer exist (e.g. a rebase
  // rewrote them) — surviving ones stay selected across an ordinary refresh.
  if (state.commitSelection.size) {
    const present = new Set(state.rows.map((r) => r.id));
    state.commitSelection = new Set([...state.commitSelection].filter((id) => present.has(id)));
  }
  await ensureAvatars(state.rows.map((r) => r.author_email));
  rebuildCommitRefs();
  await updateLogView();
  if (state.selectedId) await selectCommit(state.selectedId);
  else {
    shownDetailId = null;
    detailView?.showEmpty();
  }
}

// Whether the freshly fetched first page matches what we already have loaded —
// same repo, same total, same commits in the same order. Comparing only the
// first page is enough: the log is append-only below it, so an unchanged head
// plus an unchanged total means an unchanged log.
function historyUnchanged(page: LogPage): boolean {
  if (rowsRepoPath !== state.repoPath || page.total !== state.total) return false;
  if (state.rows.length < page.rows.length) return false;
  return page.rows.every((r, i) => state.rows[i]?.id === r.id);
}

// The trimmed commit-search query (empty when the box is empty or absent).
function logSearchQuery(): string {
  const input = document.querySelector<HTMLInputElement>("#log-search");
  return input ? input.value.trim() : "";
}

// Render the log pane: the paged history normally, or live search results when
// the search box has text — GitKraken-style commit search over the full graph
// (matches message, author, or SHA).
async function updateLogView(): Promise<void> {
  const pane = $("#log-pane");
  const query = logSearchQuery();
  if (!query) {
    logView = renderLog(pane, state.rows, state.selectedId, selectCommit, loadMoreCommits, refLabelsAt, onCommitContextMenu, state.commitSelection, onCommitMultiSelect);
    // An empty log (e.g. right after an abort that left an odd state) should read
    // as such rather than as a blank pane.
    if (!state.rows.length) pane.append(el("div", { class: "detail-empty", text: "No commits to show." }));
    return;
  }
  let results: CommitRow[];
  try {
    results = await searchLog(query, state.allBranches);
  } catch (err) {
    readFailed("Search failed", err);
    return;
  }
  // Drop a stale result if the query changed while the search was in flight.
  if (logSearchQuery() !== query) return;
  await ensureAvatars(results.map((r) => r.author_email));
  // No onNeedMore: search returns the complete match set, not a page.
  logView = renderLog(pane, results, state.selectedId, selectCommit, undefined, refLabelsAt, onCommitContextMenu, state.commitSelection, onCommitMultiSelect);
  if (!results.length) {
    pane.append(el("div", { class: "detail-empty", text: `No commits match “${query}”.` }));
  }
  setStatus(`${results.length} commit${results.length === 1 ? "" : "s"} match “${query}”.`);
}

// Append the next page when the user scrolls near the end of what's loaded.
async function loadMoreCommits(): Promise<void> {
  if (loadingMore || state.rows.length >= state.total) return;
  loadingMore = true;
  try {
    const page = await fetchLogPage(state.rows.length, PAGE_SIZE, state.allBranches);
    state.rows = state.rows.concat(page.rows);
    rowsRepoPath = state.repoPath;
    state.total = page.total;
    const host = $("#log-pane");
    const keepScroll = host.scrollTop;
    await ensureAvatars(state.rows.map((r) => r.author_email));
    rebuildCommitRefs();
    logView = renderLog(host, state.rows, state.selectedId, selectCommit, loadMoreCommits, refLabelsAt, onCommitContextMenu, state.commitSelection, onCommitMultiSelect);
    host.scrollTop = keepScroll;
    setStatus(`${state.rows.length} / ${state.total} commits loaded`);
  } catch (err) {
    readFailed("Failed to load more commits", err);
  } finally {
    loadingMore = false;
  }
}

// Persist a commit multi-selection change and repaint the rows that need the
// highlight update outside the log pane itself (currently none — the log
// pane already redraws itself synchronously on the click that caused this).
function onCommitMultiSelect(ids: Set<string>): void {
  state.commitSelection = ids;
}

async function selectCommit(id: string): Promise<void> {
  // The log view updates its own highlight on click; here we only load detail.
  state.selectedId = id;
  // Commits are immutable — re-showing one already on screen (e.g. switching
  // back to History with the same selection) needs no re-fetch/re-diff.
  if (id === shownDetailId) return;
  try {
    const detail = await fetchCommitDetail(id);
    // The selection moved on while this was in flight (easy to do by holding an
    // arrow key) — a later request owns the pane now.
    if (state.selectedId !== id) return;
    shownDetailId = id;
    detailView?.show(detail);
  } catch (err) {
    readFailed("Failed to load commit", err);
  }
}

// --- Keyboard navigation in the commit log --------------------------------
//
// Walking history is the main thing a git client is for, and it was click-only:
// the only global keys were Cmd+Z/Y and Cmd+K. The log view owns the moving
// (see LogHandle — it knows which rows are on screen, which are the search
// results while a search is active); this decides when a key means navigation
// and what to do with the row it lands on.

// Whether a bare navigation key belongs to the log right now.
function logNavAllowed(e: KeyboardEvent): boolean {
  if (state.view !== "history") return false;
  // Modifiers belong to other shortcuts (Cmd+Z, Cmd+K); Shift is left alone for
  // a future range-extend.
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  // Anything layered over the log owns its own arrows: modals (including the
  // rebase editor), the Quick Launch palette, and open menus.
  if (document.querySelector(".modal-overlay, .ql-overlay, .commit-menu")) return false;
  if (document.querySelector(".menu:not(.hidden)")) return false;
  // `e.target` is only an Element when something focusable has focus; with focus
  // on the document itself there is nothing to defer to (and no .closest()).
  const t = e.target instanceof HTMLElement ? e.target : null;
  if (!t) return true;
  // Typing wins: the log search box, the commit message, the conflict editor,
  // the embedded terminal.
  if (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA") return false;
  if (t.closest("#terminal-host")) return false;
  return true;
}

function setupLogKeyboardNav(): void {
  document.addEventListener("keydown", (e) => {
    if (!logNavAllowed(e)) return;
    const log = logView;
    if (!log) return;

    let id: string | null = null;
    switch (e.key) {
      case "ArrowDown":
      case "j":
        id = log.moveSelection(1);
        break;
      case "ArrowUp":
      case "k":
        id = log.moveSelection(-1);
        break;
      case "PageDown":
        id = log.moveSelection(log.pageRows());
        break;
      case "PageUp":
        id = log.moveSelection(-log.pageRows());
        break;
      case "Home":
        id = log.selectEdge("first");
        break;
      case "End":
        // The oldest row *loaded* — the log is paged, so this is the end of what
        // we have, and landing there pulls in the next page like scrolling does.
        id = log.selectEdge("last");
        break;
      case "Enter":
        // Hand focus to the diff so it can be scrolled from the keyboard too.
        focusDetailPane();
        e.preventDefault();
        return;
      default:
        return;
    }
    // The key was ours even at the ends of the list, so the page never scrolls
    // underneath the log.
    e.preventDefault();
    if (id) void selectCommit(id);
  });
}

// Move focus into the detail pane so its scroll container answers the keyboard.
// The pane isn't natively focusable, hence the tabindex.
function focusDetailPane(): void {
  const scroller = document.querySelector<HTMLElement>(
    "#detail-pane .file-view, #detail-pane .tab-scroll, #detail-pane .tree-view",
  );
  const target = scroller ?? $("#detail-pane");
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus();
}

// Which sub-view the Config tab shows: the structured git key/value editor,
// or the raw ~/.gitconfig + ~/.tigrc panel.
let configTab: "git" | "dotfiles" = "git";

function setConfigTab(tab: "git" | "dotfiles"): void {
  configTab = tab;
  $("#config-seg-git").classList.toggle("active", tab === "git");
  $("#config-seg-dotfiles").classList.toggle("active", tab === "dotfiles");
}

async function refreshConfig(): Promise<void> {
  if (configTab === "dotfiles") return refreshDotfiles();
  const entries = await fetchConfig();
  renderConfig($("#config-editor"), entries, handleConfigSave);
}

async function handleConfigSave(scope: ConfigScope, name: string, value: string): Promise<void> {
  try {
    await saveConfig(scope, name, value);
    setStatus(`Saved ${name} (${scope})`);
    await refreshConfig();
  } catch (err) {
    opFailed(`Failed to save ${name}`, err);
  }
}

const DOTFILE_KINDS: DotfileKind[] = ["GitConfig", "Tigrc"];

async function refreshDotfiles(): Promise<void> {
  const files = await Promise.all(
    DOTFILE_KINDS.map(async (kind) => ({
      kind,
      path: DOTFILE_DISPLAY_PATH[kind],
      content: await readDotfile(kind),
    })),
  );
  renderDotfiles($("#config-editor"), files, {
    confirm: confirmDialog,
    save: async (kind, content) => {
      await writeDotfile(kind, content);
      setStatus(`Saved ${DOTFILE_DISPLAY_PATH[kind]}.`);
    },
  });
}

// Throttle for the background remote fetch triggered by navigation (below).
// A real fetch is a network round trip (and can prompt for credentials), so it
// shouldn't fire on every single tab/branch click — this keeps ahead/behind
// and remote branches "fresh enough" without hammering it. A manual click on
// the Reload button (refreshAllAction) always bypasses this.
// Generous: a background fetch is a network round trip plus a full sidebar
// repaint, and navigation must never feel gated on it. A manual Reload
// (refreshAllAction) always bypasses this, so 60s costs nothing in freshness
// the user can't get on demand.
const REMOTE_REFRESH_THROTTLE_MS = 60_000;

// Fetch all remotes in the background (throttled) and reload the sidebar so
// ahead/behind counts and remote-tracking refs reflect it. Silent on failure
// (offline, no cached credentials) — a background refresh must never
// interrupt navigation with an error dialog, only a status-bar note.
async function refreshRemoteQuietly(): Promise<void> {
  if (!state.repoPath || actionsBusy) return;
  const last = remoteFetchedAt.get(state.repoPath);
  if (last !== undefined && Date.now() - last < REMOTE_REFRESH_THROTTLE_MS) return;
  // Recorded before the round trip, so a slow or failing fetch can't have every
  // navigation start another one.
  markRemoteFetched();
  try {
    await fetchAll();
    await loadSidebar();
  } catch (err) {
    readFailed("Background fetch failed", err);
  }
}

// --- Picking up changes made outside gitp ---------------------------------
//
// Another app — a terminal, an IDE, another git GUI — can stage, commit, or
// check out at any moment. The backend already serves fresh data whenever it's
// asked (its `git status` cache is guarded by a worktree watcher *and* the
// `.git/index` stamp), but nothing was asking: loadSidebar() ran only after
// gitp's own actions, so an external `git add` stayed invisible until the user
// happened to do something in gitp that refreshed.
//
// So refresh on the two signals that mean "the user is looking at this now":
// the window regaining focus (stage elsewhere, switch back — the reported
// case), and interaction, throttled, for when gitp already had focus.

const INTERACTION_REFRESH_THROTTLE_MS = 3_000;
let lastDiskRefreshAt = 0;

// Whether gitp is running an operation of its own right now.
function operationInFlight(): boolean {
  return actionsBusy || (changesView?.isBusy() ?? false);
}

// Re-read refs, staging lists and history from disk. `force` skips the
// interaction throttle — window focus is deliberate and infrequent, so it
// shouldn't be swallowed by a click a moment earlier.
function refreshFromDisk(force: boolean): void {
  if (!state.repoPath) return;
  // An operation in flight refreshes on its own when it finishes.
  if (operationInFlight()) return;
  const now = Date.now();
  if (!force && now - lastDiskRefreshAt < INTERACTION_REFRESH_THROTTLE_MS) return;
  lastDiskRefreshAt = now;
  void (async () => {
    await loadSidebar({ abortIfBusy: true });
    // Commits made outside gitp change history too. This is the passive mode:
    // it compares the first page and returns without touching anything when
    // history is unchanged, which is the common case.
    if (state.view === "history") await refreshHistory({ keepSelection: true });
  })();
}

function setupExternalChangeRefresh(): void {
  // Coming back to the window: the reported case, and the cheapest signal there
  // is that the user wants to see current state.
  window.addEventListener("focus", () => refreshFromDisk(true));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshFromDisk(true);
  });

  // Already focused: any interaction is a hint the user is here and looking.
  // Throttled, and skipped while a modal is open — mid-dialog the file lists
  // aren't what's being looked at, and repainting them underneath is a
  // surprise, not a service.
  const onInteract = (e: Event) => {
    if (document.querySelector(".modal-overlay")) return;
    // A keystroke inside a text field means the user is writing, not navigating.
    // Re-reading the workspace mid-sentence rebuilds the staging view under
    // them; render() puts the caret back, but the churn buys nothing.
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    refreshFromDisk(false);
  };
  document.addEventListener("pointerdown", onInteract, true);
  document.addEventListener("keydown", onInteract, true);
}

// Switch the main panel between history, local changes, and config; keeps the
// topbar tabs and sidebar nav highlight in sync, and loads the view's data.
function showView(view: View): void {
  closeCommitMenu();
  state.view = view;
  $("#history-view").classList.toggle("hidden", view !== "history");
  $("#changes-view").classList.toggle("hidden", view !== "changes");
  $("#config-view").classList.toggle("hidden", view !== "config");
  $("#conflict-view").classList.toggle("hidden", view !== "conflict");
  for (const el of document.querySelectorAll<HTMLElement>(".tab")) {
    el.classList.toggle("active", el.dataset.tab === view);
  }
  renderSidebarNow();
  renderConflictBanner(); // entering/leaving the resolver toggles the banner
  if (view === "config") void refreshConfig();
  else if (view === "changes") void loadChanges();
  else if (view === "conflict") void conflictView?.reload();
  // Entering History or Local Changes — including via a branch click, which
  // routes through here too (see jumpToCommit/checkoutBranchAction) — reloads
  // the graph (keeping whatever's selected) and, throttled, fetches remotes,
  // so switching over always shows current local + remote state without a
  // manual Reload click.
  if (view === "history") void refreshHistory({ keepSelection: true });
  // A cheap local check (no network) — re-run on every visit so the Resolve
  // Conflicts banner (and its pre-filled commit message) stays accurate even
  // after navigating away from the resolver without finishing or aborting.
  if (view === "history" || view === "changes") void refreshConflictStatus();
  if (view === "history" || view === "changes") void refreshRemoteQuietly();
}

// Re-read everything an action can invalidate — refs, change count, staging
// lists, rebase/conflict state, undo labels — and repaint from it.
//
// This is ONE backend round trip (see workspaceSnapshot). It used to be five,
// each taking the global backend lock, and two of them independently ran
// `git status`: once for the sidebar badge and once for the staging lists.
// Now status runs once and is shared with the Local Changes view.
async function loadSidebar(opts: { abortIfBusy?: boolean } = {}): Promise<void> {
  try {
    const snap = await workspaceSnapshot();
    // A passive refresh must not land a snapshot taken before an operation the
    // user started while it was in flight: that would repaint the pre-op state
    // over an optimistic staging update, and only the operation's own reload
    // would put it back. Dropping the result costs nothing — the operation
    // refreshes when it finishes.
    if (opts.abortIfBusy && operationInFlight()) return;
    state.refs = snap.refs;
    state.localChanges = snap.local_changes;
    state.rebase = snap.rebase;
    undoLabels = snap.undo;
    // Hand the staging lists straight to Local Changes so it doesn't re-run
    // `git status` for this same refresh.
    changesView?.applyStatus(snap.status);
    renderRebaseBanner();
    applyConflictStatus(snap.conflict);
  } catch (err) {
    state.refs = EMPTY_REFS;
    readFailed("Failed to load refs", err);
  }
  renderSidebarNow();
  // Refs now known — recompute containment and re-render the open commit + the
  // log so the branch chips appear on every commit.
  detailView?.refresh();
  rebuildCommitRefs();
  if (state.view === "history" && state.rows.length) {
    const pane = $("#log-pane");
    const keep = pane.scrollTop;
    logView = renderLog(pane, state.rows, state.selectedId, selectCommit, loadMoreCommits, refLabelsAt, onCommitContextMenu, state.commitSelection, onCommitMultiSelect);
    pane.scrollTop = keep;
  }
}

// Show the checked-out branch name as a chip in the top bar (hidden when no
// repo is open or HEAD is detached).
function renderBranchIndicator(): void {
  const chip = $("#branch-indicator");
  const head = state.repoPath ? state.refs.head : null;
  chip.textContent = head ?? "";
  chip.title = head ? `On branch ${head}` : "Current branch";
  chip.classList.toggle("hidden", !head);
}

let sbFilterDebounce: number | undefined;

// Everything renderSidebar reads, flattened to a comparable string.
//
// renderSidebar tears the whole ref tree down and rebuilds it (see the
// `clear(host)` at its top), and it's called on every view switch, every
// workspace snapshot, and every background remote refresh — nearly all of
// which change nothing about it. On a repo with a few hundred branches/tags
// that's hundreds of elements and listeners rebuilt for no visible change,
// twice per tab switch. Building this signature walks the same refs but
// allocates only a string, so skipping an unchanged render is a large net win.
function sidebarSignature(repoName: string): string {
  const r = state.refs;
  return [
    repoName,
    state.view,
    state.localChanges,
    state.sbFilter,
    r.head ?? "",
    r.branches.map((b) => `${b.name}:${b.target}:${b.is_head ? 1 : 0}:${b.ahead}:${b.behind}:${b.has_upstream ? 1 : 0}`).join(","),
    r.remotes.map((rm) => `${rm.name}:${rm.target}`).join(","),
    r.tags.map((t) => `${t.name}:${t.target}`).join(","),
    r.stashes.map((st) => `${st.index}:${st.message}`).join(","),
    r.recent.join(","),
    [...state.sbCollapsed].sort().join(","),
    [...state.branchSelection].sort().join(","),
    state.branchSelectionAnchor ?? "",
    [...state.busyRefs].sort().join(","),
  ].join("|");
}

let lastSidebarSig: string | null = null;

function renderSidebarNow(): void {
  renderBranchIndicator();
  // The fetch age is per repo, so it has to follow a tab switch, not just the
  // 30s tick.
  renderFetchAge();
  renderTerminalCwd();
  refreshActionButtons();
  const active = state.repos.find((r) => r.path === state.repoPath);
  const sig = sidebarSignature(active?.name ?? "");
  if (sig === lastSidebarSig) return;
  lastSidebarSig = sig;
  renderSidebar(
    $("#sidebar"),
    {
      refs: state.refs,
      localChanges: state.localChanges,
      repoName: active?.name ?? "",
      // The conflict resolver has no sidebar entry; highlight Local Changes.
      activeView: state.view === "conflict" ? "changes" : state.view,
      filter: state.sbFilter,
      collapsed: state.sbCollapsed,
      branchSelection: state.branchSelection,
      branchSelectionAnchor: state.branchSelectionAnchor,
      busyRefs: state.busyRefs,
    },
    {
      onSelectView: (v: SidebarView) => showView(v),
      // Debounced: renderSidebarNow rebuilds the whole branch/tag/remote tree
      // (including recreating this very input), so filtering on every single
      // keystroke costs a full tree teardown+rebuild per character on a repo
      // with many branches. The input itself isn't debounced — the browser
      // shows what's typed immediately — only the filtered re-render lags a
      // touch behind, which is imperceptible.
      onFilter: (text) => {
        window.clearTimeout(sbFilterDebounce);
        sbFilterDebounce = window.setTimeout(() => {
          state.sbFilter = text;
          renderSidebarNow();
        }, 120);
      },
      onToggle: (key) => {
        if (state.sbCollapsed.has(key)) state.sbCollapsed.delete(key);
        else state.sbCollapsed.add(key);
        renderSidebarNow();
      },
      onRefJump: (target, label) => void jumpToCommit(target, label),
      onBranchCheckout: (b) => void checkoutBranchAction(b),
      onBranchMenu: (b, x, y) => onBranchMenu(b, x, y),
      onBranchMultiSelect: (names, anchor) => {
        state.branchSelection = names;
        state.branchSelectionAnchor = anchor;
        renderSidebarNow();
      },
      onBranchBulkMenu: (x, y) => onBranchBulkMenu(x, y),
      onStashClick: (s) => void showStashDetail(s),
      onStashMenu: (s, x, y) => onStashMenu(s, x, y),
      onRemoteMenu: (name, target, x, y) => onRemoteMenu(name, target, x, y),
      onTagMenu: (name, target, x, y) => onTagMenu(name, target, x, y),
    },
  );
}

async function loadChanges(): Promise<void> {
  try {
    await changesView?.reload();
  } catch (err) {
    readFailed("Failed to load local changes", err);
  }
}

// Single-click a branch/remote/tag: show its tip commit, scrolling the log to it
// if that commit is loaded.
async function jumpToCommit(target: string, label: string): Promise<void> {
  showView("history");
  state.selectedId = target;
  let idx = state.rows.findIndex((r) => r.id === target);
  // Not on screen yet. The log is paged — only the newest PAGE_SIZE commits are
  // loaded — so on any real repository a tag or an older branch points *below*
  // what's loaded, and clicking one used to leave the graph exactly where it
  // was with nothing selected. Find out how far down it is and load to there.
  if (idx < 0) idx = await loadDownTo(target, label);

  logView = renderLog($("#log-pane"), state.rows, state.selectedId, selectCommit, loadMoreCommits, refLabelsAt, onCommitContextMenu, state.commitSelection, onCommitMultiSelect);
  if (idx >= 0) {
    const pane = $("#log-pane");
    pane.scrollTop = Math.max(0, idx * GRAPH_METRICS.rowHeight - pane.clientHeight / 2);
  }
  await selectCommit(target);
  detailView?.focusCommit();
  setStatus(idx >= 0 ? `Jumped to ${label}` : `Showing ${label} (not in this graph)`);
}

/// Load log pages until `target` is among them; returns its row index, or -1 if
/// it isn't in the graph at all (unreachable, or hidden by the Current-branch
/// toggle).
///
/// The graph's lanes are computed over a contiguous run from the newest commit,
/// so reaching row N genuinely means holding rows 0..N — hence one fetch sized
/// to the gap rather than page-by-page paging down to it.
async function loadDownTo(target: string, label: string): Promise<number> {
  try {
    const idx = await logIndexOf(target, state.allBranches);
    if (idx == null) return -1;
    if (idx < state.rows.length) return idx;

    const missing = idx + 1 - state.rows.length;
    setStatus(`Loading ${missing.toLocaleString()} more commits to reach ${label}…`);
    const page = await fetchLogPage(state.rows.length, Math.max(missing, PAGE_SIZE), state.allBranches);
    state.rows = state.rows.concat(page.rows);
    rowsRepoPath = state.repoPath;
    state.total = page.total;
    await ensureAvatars(state.rows.map((r) => r.author_email));
    rebuildCommitRefs();
    return state.rows.findIndex((r) => r.id === target);
  } catch (err) {
    readFailed(`Couldn't locate ${label}`, err);
    return -1;
  }
}

// Double-click a branch: check it out, then reload history + sidebar from the new
// HEAD. Warns first if the working tree has uncommitted changes.
async function checkoutBranchAction(b: BranchRef): Promise<void> {
  if (b.is_head) return;
  if (state.localChanges > 0) {
    const n = state.localChanges;
    const ok = await confirmDialog(
      `You have ${n} uncommitted change${n === 1 ? "" : "s"}.\n\n` +
        `Switch to "${b.name}"? Conflicting changes will block the checkout.`,
    );
    if (!ok) {
      setStatus("Checkout cancelled.");
      return;
    }
  }
  setStatus(`Checking out ${b.name}…`);
  try {
    await withBusyRef(b.name, () => checkoutBranch(b.name));
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    reportDone(`Checked out ${b.name}`);
  } catch (err) {
    // Conflicting local changes ("would be overwritten by checkout") come back
    // as multi-line git output — show the full reason, not just a status line.
    opFailed(`Couldn't switch to ${b.name}`, err);
  }
}

// --- Action bar (Pull / Push / Branch) -------------------------------------

let actionsBusy = false;
// Selector of the toolbar button whose action is in flight, so it can spin.
let busyActionBtn: string | null = null;

// Enable/disable the toolbar buttons based on the in-flight state and what the
// active repo supports: nothing to stash → Stash off; empty stack → Pop off.
function refreshActionButtons(): void {
  const blocked = actionsBusy || !state.repoPath;
  // Undo/Redo: enabled only when the backend has a matching action, and labelled
  // with it ("Undo Commit"), GitKraken-style.
  const undoBtn = $<HTMLButtonElement>("#undo-btn");
  const redoBtn = $<HTMLButtonElement>("#redo-btn");
  undoBtn.disabled = blocked || !undoLabels.undo;
  redoBtn.disabled = blocked || !undoLabels.redo;
  undoBtn.title = undoLabels.undo ? `Undo ${undoLabels.undo}` : "Nothing to undo";
  redoBtn.title = undoLabels.redo ? `Redo ${undoLabels.redo}` : "Nothing to redo";
  $<HTMLButtonElement>("#pull-btn").disabled = blocked;
  $<HTMLButtonElement>("#pull-caret-btn").disabled = blocked;
  $<HTMLButtonElement>("#push-btn").disabled = blocked;
  $<HTMLButtonElement>("#branch-btn").disabled = blocked;
  $<HTMLButtonElement>("#stash-btn").disabled = blocked || state.localChanges === 0;
  $<HTMLButtonElement>("#pop-btn").disabled = blocked || state.refs.stashes.length === 0;
  $<HTMLButtonElement>("#refresh-btn").disabled = blocked;

  // Spin the button whose action is running.
  for (const sel of ["#undo-btn", "#redo-btn", "#pull-btn", "#push-btn", "#stash-btn", "#pop-btn", "#refresh-btn"]) {
    $(sel).classList.toggle("busy", busyActionBtn === sel);
  }

  // Badge the current branch's sync state vs its upstream. A branch with no
  // upstream (never pushed) shows a dot on Push instead of a count; otherwise
  // Push shows commits ahead (unpushed) and Pull shows commits behind.
  const head = state.refs.branches.find((b) => b.is_head);
  if (head && !head.has_upstream) {
    setActionDot("#push-badge", "Branch has no upstream — not pushed yet");
  } else {
    setActionBadge("#push-badge", head?.ahead ?? 0, "commit(s) to push");
  }
  setActionBadge("#pull-badge", head?.behind ?? 0, "commit(s) to pull");
}

// Show `count` on a toolbar badge (hidden when zero), with a descriptive title.
function setActionBadge(sel: string, count: number, noun: string): void {
  const badge = $(sel);
  badge.classList.remove("dot");
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.title = `${count} ${noun}`;
  badge.classList.toggle("hidden", count === 0);
}

// Show a small dot (no number) on a toolbar badge — "there's something here,
// but no count to give", e.g. an un-pushed branch with no upstream.
function setActionDot(sel: string, title: string): void {
  const badge = $(sel);
  badge.textContent = "";
  badge.title = title;
  badge.classList.add("dot");
  badge.classList.remove("hidden");
}

// Disable every toolbar button while a git operation is in flight. `activeSel`
// is the button that launched it — it shows a spinner over its icon so the
// feedback is right where the user clicked.
function setActionsBusy(busy: boolean, activeSel?: string): void {
  actionsBusy = busy;
  busyActionBtn = busy ? (activeSel ?? null) : null;
  refreshActionButtons();
}

// Labels of the actions Undo/Redo would perform, mirrored from the backend so
// the buttons enable/disable and show what they'd do.
let undoLabels: UndoState = { undo: null, redo: null };

async function undoAction(): Promise<void> {
  if (!state.repoPath || !undoLabels.undo) return;
  const label = undoLabels.undo;
  setActionsBusy(true, "#undo-btn");
  setStatus(`Undoing ${label}…`);
  try {
    undoLabels = await undo();
    await Promise.all([refreshHistory(), loadSidebar()]);
    if (state.view === "changes") await loadChanges();
    reportDone(`Undid ${label}.`);
  } catch (err) {
    opFailed("Undo failed", err);
  } finally {
    setActionsBusy(false);
  }
}

async function redoAction(): Promise<void> {
  if (!state.repoPath || !undoLabels.redo) return;
  const label = undoLabels.redo;
  setActionsBusy(true, "#redo-btn");
  setStatus(`Redoing ${label}…`);
  try {
    undoLabels = await redo();
    await Promise.all([refreshHistory(), loadSidebar()]);
    if (state.view === "changes") await loadChanges();
    reportDone(`Redid ${label}.`);
  } catch (err) {
    opFailed("Redo failed", err);
  } finally {
    setActionsBusy(false);
  }
}

async function pullAction(mode: PullMode): Promise<void> {
  if (!state.repoPath) return;
  setActionsBusy(true, "#pull-btn");
  setStatus("Pulling…");
  try {
    const out = await pull(mode);
    await Promise.all([refreshHistory(), loadSidebar()]);
    reportDone(out || "Pull complete.");
  } catch (err) {
    opFailed("Pull failed", err);
  } finally {
    setActionsBusy(false);
  }
}

// Run one of the four pull-menu methods, whichever it is.
async function runPullMethod(mode: PullDefault): Promise<void> {
  if (mode === "FetchAll") await refreshAllAction();
  else await pullAction(mode);
}

// The plain Pull button: run whatever method is currently the default.
async function runPullDefault(): Promise<void> {
  await runPullMethod(loadPullDefault());
}

// Git's own wording for "the remote has commits this branch doesn't" — the
// same rejection whether or not we've fetched recently (fetch first) or have
// (non-fast-forward). Confirmed against a real rejected push, not guessed;
// see gitp-core's remote.rs test of the same name in spirit.
function isNonFastForwardRejection(message: string): boolean {
  return message.includes("[rejected]") && (message.includes("fetch first") || message.includes("non-fast-forward"));
}

async function pushAction(): Promise<void> {
  if (!state.repoPath) return;
  setActionsBusy(true, "#push-btn");
  setStatus("Pushing…");
  try {
    const out = await push();
    await loadSidebar();
    reportDone(out || "Push complete.");
  } catch (err) {
    const message = String(err);
    if (isNonFastForwardRejection(message)) {
      opFailed("Push rejected — your branch is behind", err, [
        { label: "Pull", run: () => void runPullDefault() },
        { label: "Force Push (--force-with-lease)", danger: true, run: () => void pushForceAction() },
      ]);
    } else {
      opFailed("Push failed", err);
    }
  } finally {
    setActionsBusy(false);
  }
}

async function pushForceAction(): Promise<void> {
  if (!state.repoPath) return;
  setActionsBusy(true, "#push-btn");
  setStatus("Force pushing…");
  try {
    const out = await pushForce();
    await loadSidebar();
    reportDone(out || "Force push complete.");
  } catch (err) {
    opFailed("Force push failed", err);
  } finally {
    setActionsBusy(false);
  }
}

async function stashAction(): Promise<void> {
  if (!state.repoPath) return;
  setActionsBusy(true, "#stash-btn");
  setStatus("Stashing…");
  try {
    const out = await stash();
    if (state.view === "changes") await loadChanges();
    await loadSidebar();
    reportDone(out || "Stashed.");
  } catch (err) {
    opFailed("Stash failed", err);
  } finally {
    setActionsBusy(false);
  }
}

async function popAction(): Promise<void> {
  if (!state.repoPath) return;
  setActionsBusy(true, "#pop-btn");
  setStatus("Popping stash…");
  try {
    const out = await stashPop();
    if (state.view === "changes") await loadChanges();
    await loadSidebar();
    reportDone(out || "Popped stash.");
  } catch (err) {
    opFailed("Pop failed", err);
  } finally {
    setActionsBusy(false);
  }
}

// Fetch all remotes, then reload refs/history so every branch's ahead/behind
// (and the Push/Pull badges) reflect the remote — showing what needs a pull.
async function refreshAllAction(): Promise<void> {
  if (!state.repoPath) return;
  setActionsBusy(true, "#refresh-btn");
  setStatus("Fetching all remotes…");
  try {
    const out = (await fetchAll()).trim();
    markRemoteFetched();
    await Promise.all([loadSidebar(), refreshHistory()]);
    if (state.view === "changes") await loadChanges();
    reportDone(out || "Refreshed.");
  } catch (err) {
    opFailed("Refresh failed", err);
  } finally {
    setActionsBusy(false);
  }
}

async function createBranchAction(name: string): Promise<void> {
  setStatus(`Creating ${name}…`);
  try {
    await createBranch(name);
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    reportDone(`Created and switched to ${name}`);
  } catch (err) {
    opFailed("Create branch failed", err);
  }
}

// --- Branch right-click menu ------------------------------------------------

// Build and open the actions menu for a right-clicked branch.
function onBranchMenu(b: BranchRef, x: number, y: number): void {
  const current = state.refs.head;
  const items: MenuItem[] = [];
  // Every operation in this menu acts on `b`, so they all route through one
  // wrapper that spins `b`'s sidebar row for the duration.
  const onBranch = (label: string, op: () => Promise<string>, refreshLog: boolean) =>
    void runBranchOp(label, op, refreshLog, b.name);

  if (!b.is_head) items.push({ label: "Checkout", run: () => void checkoutBranchAction(b) });
  items.push({ separator: true });
  items.push({
    label: "New Branch here…",
    prompt: {
      placeholder: "New branch name",
      onSubmit: (name) => onBranch(`Creating ${name}`, () => createBranchAt(name, b.target), true),
    },
  });
  items.push({
    label: "New Tag here…",
    prompt: {
      placeholder: "New tag name",
      onSubmit: (name) => onBranch(`Tagging ${b.name} as ${name}`, () => createTagAt(name, b.target), false),
    },
  });

  if (!b.is_head && current) {
    items.push({ separator: true });
    items.push({
      label: `Merge into ${current}`,
      run: () => onBranch(`Merging ${b.name} into ${current}`, () => mergeBranch(b.name), true),
    });
    items.push({
      label: `Rebase ${current} onto ${b.name}`,
      run: () =>
        void confirmThenRun(
          `Rebase ${current} onto ${b.name}? This rewrites commits on ${current}.`,
          `Rebasing ${current} onto ${b.name}`,
          () => rebaseOnto(b.name),
        ),
    });
    items.push({
      label: `Interactively Rebase ${current} onto ${b.name}…`,
      run: () => void openInteractiveRebase(b.name, b.name),
    });
  }

  items.push({ separator: true });
  items.push({ label: "Fetch", run: () => onBranch(`Fetching updates for ${b.name}`, () => fetchBranch(b.name), false) });
  items.push({
    label: "Fetch and Update (fast-forward)",
    run: () => onBranch(`Fetching and updating ${b.name}`, () => fetchAndUpdateBranch(b.name), true),
  });
  items.push({ label: "Push to origin", run: () => onBranch(`Pushing ${b.name}`, () => pushBranch(b.name), false) });
  if (b.behind > 0) {
    items.push({
      label: "Fast-forward to upstream",
      run: () => onBranch(`Fast-forwarding ${b.name}`, () => fastForwardBranch(b.name), true),
    });
  }
  items.push({ label: "Create Pull Request on origin", run: () => void createPullRequestAction(b) });

  items.push({ separator: true });
  items.push({
    label: "Set Upstream…",
    prompt: {
      placeholder: "Upstream (e.g. origin/main)",
      onSubmit: (up) => onBranch(`Setting upstream of ${b.name}`, () => setUpstream(b.name, up), false),
    },
  });
  items.push({ label: "Unset Upstream", run: () => onBranch(`Unsetting upstream of ${b.name}`, () => unsetUpstream(b.name), false) });

  items.push({ separator: true });
  items.push({ label: "Rename…", run: () => void renameBranchAction(b) });
  if (!b.is_head) items.push({ label: "Delete…", danger: true, run: () => void deleteBranchAction(b) });

  items.push({ separator: true });
  items.push({ label: "Copy Branch Name", run: () => void copyText(b.name, `Copied ${b.name}`) });

  showContextMenu(x, y, items);
}

function onBranchBulkMenu(x: number, y: number): void {
  const names = [...state.branchSelection];
  showContextMenu(x, y, [
    {
      label: `Delete ${names.length} Branches…`,
      danger: true,
      run: () => void deleteSelectedBranchesAction(names),
    },
  ]);
}

// Bulk delete, local-only (no per-branch "also delete on remote" — that needs
// an async remote probe per branch, which is a fussier feature on its own).
// Never deletes the checked-out branch; never force-deletes an unmerged one —
// both are silently skipped and called out in the summary, rather than
// interrupting a multi-branch op with one confirmation dialog per branch.
async function deleteSelectedBranchesAction(names: string[]): Promise<void> {
  const headName = state.refs.branches.find((b) => b.is_head)?.name;
  const targets = names.filter((n) => n !== headName);
  if (targets.length === 0) {
    setStatus("Nothing to delete — that's the current branch.");
    return;
  }
  const ok = await confirmDialog(
    `Delete ${targets.length} branch${targets.length === 1 ? "" : "es"} locally?\n\n${targets.join("\n")}`,
  );
  if (!ok) {
    setStatus("Delete cancelled.");
    return;
  }
  setStatus(`Deleting ${targets.length} branches…`);
  for (const name of targets) state.busyRefs.add(name);
  renderSidebarNow();
  // One call: the batch becomes a single undoable action, so Undo restores all
  // of them rather than only whichever happened to go last.
  let failed: string[] = [];
  try {
    ({ failed } = await deleteBranches(targets, false));
  } finally {
    state.busyRefs.clear();
    renderSidebarNow();
  }
  state.branchSelection = new Set();
  await loadSidebar();
  const parts = [`Deleted ${targets.length - failed.length} of ${targets.length} branches.`];
  if (failed.length) parts.push(`Not fully merged, skipped: ${failed.join(", ")}.`);
  if (names.length > targets.length) parts.push("Skipped the current branch.");
  reportDone(parts.join(" "));
}

// Click a stash: show its diff in the detail view. A stash commit's first
// parent is the base it was taken from, so fetchCommitDetail surfaces exactly
// the stashed changes. Switches to History, where the detail pane lives.
async function showStashDetail(s: StashRef): Promise<void> {
  showView("history");
  state.selectedId = null;
  // A stash detail isn't tracked by selectCommit's cache — invalidate it so a
  // later selectCommit for whatever's now showing doesn't wrongly skip itself.
  shownDetailId = null;
  // Clearing `selectedId` isn't enough on its own: without a repaint the log
  // keeps the previous row highlighted, so the graph claims one commit is
  // selected while the pane beside it shows a stash. A stash commit is not on
  // any branch, so there is no row to move the highlight *to* — the honest
  // state is no row highlighted at all.
  logView = renderLog($("#log-pane"), state.rows, null, selectCommit, loadMoreCommits, refLabelsAt, onCommitContextMenu, state.commitSelection, onCommitMultiSelect);
  try {
    detailView?.show(await fetchCommitDetail(`stash@{${s.index}}`));
    setStatus(`Showing stash@{${s.index}} — ${s.message}`);
  } catch (err) {
    readFailed("Failed to load stash", err);
  }
}

// Right-click a stash: apply (with a delete-after checkbox), rename, save the
// diff as a patch, or drop.
function onStashMenu(s: StashRef, x: number, y: number): void {
  const items: MenuItem[] = [
    {
      label: "Apply…",
      run: () =>
        openStashApplyModal(s, (drop) => {
          const verb = drop ? "Popping" : "Applying";
          void runStashOp(`${verb} stash@{${s.index}}`, () => applyStash(s.index, drop));
        }),
    },
    {
      label: "Rename…",
      prompt: {
        placeholder: "Stash message",
        value: s.message,
        onSubmit: (message) => void runStashOp(`Renaming stash@{${s.index}}`, () => renameStash(s.index, message)),
      },
    },
    { label: "Save as Patch…", run: () => void saveStashPatchAction(s) },
    { separator: true },
    { label: "Delete…", danger: true, run: () => void deleteStashAction(s) },
  ];
  showContextMenu(x, y, items);
}

// Right-click a tag. A tag names a commit, so most of these are the commit
// operations aimed at that commit, plus the tag-only ones (details, push,
// delete). Nothing here moves the tag itself — retagging is a delete plus a
// New Tag, which is clearer than a silent `--force`.
function onTagMenu(name: string, target: string, x: number, y: number): void {
  const current = state.refs.head;
  const short = target.slice(0, 7);
  const items: MenuItem[] = [
    { label: "Checkout Commit…", run: () => void checkoutCommitAction(target, `${name} (${short})`) },
    { label: "Show Tag Details…", run: () => openTagDetailsModal(name, fetchTagDetail(name)) },
    { separator: true },
    { label: "Push to 'origin'…", run: () => void runTagOp(`Pushing ${name}`, () => pushTag(name)) },
  ];

  if (current) {
    items.push({ separator: true });
    items.push({
      label: `Merge into '${current}'…`,
      run: () =>
        void runBranchOp(`Merging ${name} into ${current}`, () => mergeBranch(name), true, name),
    });
    items.push({
      label: `Rebase on '${name}'…`,
      run: () =>
        void confirmThenRun(
          `Rebase ${current} onto ${name}? This rewrites commits on ${current}.`,
          `Rebasing ${current} onto ${name}`,
          () => rebaseOnto(name),
        ),
    });
    items.push({
      label: `Interactively Rebase on '${name}'…`,
      run: () => void openInteractiveRebase(name, name),
    });
  }

  items.push({ separator: true });
  items.push({
    label: "New Branch…",
    prompt: {
      placeholder: "New branch name",
      onSubmit: (branch) =>
        void runBranchOp(`Creating ${branch}`, () => createBranchAt(branch, target), true, name),
    },
  });
  items.push({
    label: "New Tag…",
    prompt: {
      placeholder: "New tag name",
      onSubmit: (tag) =>
        void runTagOp(`Tagging ${short} as ${tag}`, () => createTagAt(tag, target)),
    },
  });

  items.push({ separator: true });
  items.push({ label: "Delete…", danger: true, run: () => deleteTagAction(name) });

  items.push({ separator: true });
  items.push({ label: "Copy Tag Name", run: () => void copyText(name, `Copied ${name}`) });

  showContextMenu(x, y, items);
}

// A tag operation: run it, then reload the sidebar so the Tags section reflects
// it. Tags never move HEAD, so the log is left alone.
async function runTagOp(label: string, op: () => Promise<string>): Promise<void> {
  setStatus(`${label}…`);
  try {
    const out = (await op()).trim();
    await loadSidebar();
    reportDone(out || `${label} done.`);
  } catch (err) {
    opFailed(`${label} failed`, err);
  }
}

// Delete a tag, offering to remove it from origin too when it's actually there
// (probed live), the same flow as deleting a branch.
function deleteTagAction(name: string): void {
  const probe = remoteTagExists(name).catch(() => false);
  openDeleteTagModal(name, probe, (deleteRemote) => {
    void runDeleteTag(name, deleteRemote);
  });
}

async function runDeleteTag(name: string, deleteRemote: boolean): Promise<void> {
  setStatus(`Deleting tag ${name}…`);
  try {
    await deleteTag(name);
  } catch (err) {
    opFailed(`Delete tag ${name} failed`, err);
    return;
  }

  let note = `Deleted tag ${name}`;
  if (deleteRemote) {
    try {
      await deleteRemoteTag(name);
      note += " (local and origin)";
    } catch (err) {
      await loadSidebar();
      opFailed(`Deleted local tag ${name}, but deleting it on origin failed`, err);
      return;
    }
  }
  await loadSidebar();
  reportDone(note);
}

// Right-click a remote branch: check it out (as a local tracking branch) or
// copy its name.
function onRemoteMenu(name: string, target: string, x: number, y: number): void {
  const items: MenuItem[] = [
    { label: "Checkout…", run: () => void checkoutRemoteAction(name) },
    { separator: true },
    { label: "Copy Branch Name", run: () => void copyText(name, `Copied ${name}`) },
  ];
  void target;
  showContextMenu(x, y, items);
}

// Check out a remote branch, creating/switching to a local tracking branch.
// Warns first if the working tree has uncommitted changes (like branch checkout).
async function checkoutRemoteAction(name: string): Promise<void> {
  if (state.localChanges > 0) {
    const n = state.localChanges;
    const ok = await confirmDialog(
      `You have ${n} uncommitted change${n === 1 ? "" : "s"}.\n\n` +
        `Check out "${name}"? Conflicting changes will block it.`,
    );
    if (!ok) {
      setStatus("Checkout cancelled.");
      return;
    }
  }
  setStatus(`Checking out ${name}…`);
  try {
    const out = (await withBusyRef(name, () => checkoutRemoteBranch(name))).trim();
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    reportDone(out || `Checked out ${name}`);
  } catch (err) {
    opFailed(`Couldn't check out ${name}`, err);
  }
}

// Run a stash op, then refresh the sidebar and — if it's open — the Local
// Changes view (apply/pop mutate the working tree). Shows git's output.
async function runStashOp(label: string, op: () => Promise<string>): Promise<void> {
  setStatus(`${label}…`);
  try {
    const out = (await op()).trim();
    await loadSidebar();
    if (state.view === "changes") await loadChanges();
    reportDone(out || `${label} done.`);
  } catch (err) {
    opFailed(`${label} failed`, err);
  }
}

async function deleteStashAction(s: StashRef): Promise<void> {
  if (!(await confirmDialog(`Delete stash@{${s.index}}?\n\n${s.message}`))) return;
  await runStashOp(`Deleting stash@{${s.index}}`, () => dropStash(s.index));
}

async function saveStashPatchAction(s: StashRef): Promise<void> {
  setStatus("Saving patch…");
  try {
    const out = await saveStashPatch(s.index, `stash-${s.index}.patch`);
    if (out === null) {
      setStatus("Save cancelled.");
      return;
    }
    reportDone(out || "Saved patch.");
  } catch (err) {
    opFailed("Save failed", err);
  }
}

// Run a branch op, then refresh the sidebar (and history when the op can move
// HEAD or change commits). Shows git's own output on success.
// Show an operation as in progress on the sidebar row it acts on, for as long
// as it runs.
//
// The status bar already spins for any "…" message, but on a fetch or a
// fast-forward the user's attention is on the branch they just right-clicked,
// not on the footer — and those are exactly the operations slow enough to leave
// someone wondering whether the click registered. Cleared in a `finally` so a
// failed operation can't strand a row spinning forever.
async function withBusyRef<T>(ref: string | undefined, run: () => Promise<T>): Promise<T> {
  if (!ref) return run();
  state.busyRefs.add(ref);
  renderSidebarNow();
  try {
    return await run();
  } finally {
    state.busyRefs.delete(ref);
    renderSidebarNow();
  }
}

/// `ref`: the branch/remote row to spin while this runs, when the operation
/// belongs to one.
async function runBranchOp(
  label: string,
  op: () => Promise<string>,
  refreshLog: boolean,
  ref?: string,
): Promise<void> {
  setStatus(`${label}…`);
  try {
    const out = (await withBusyRef(ref, op)).trim();
    if (refreshLog) {
      showView("history");
      await Promise.all([refreshHistory(), loadSidebar()]);
    } else {
      await loadSidebar();
    }
    reportDone(out || `${label} done.`);
  } catch (err) {
    // A failed merge that left conflicts in progress gets a Resolve action.
    await refreshConflictStatus();
    const inConflict = state.conflict?.kind === "merge" && state.conflict.conflicted.length > 0;
    opFailed(
      `${label} failed`,
      err,
      inConflict ? { label: "Resolve Conflicts", run: () => showView("conflict") } : undefined,
    );
  }
}

// Rename a branch. A modal collects the new name and, when the branch exists on
// its remote (probed live via git ls-remote), offers to rename it there too.
function renameBranchAction(b: BranchRef): void {
  const probe = remoteBranchExists(b.name).catch(() => null);
  openRenameBranchModal(b.name, probe, (newName, renameRemote) => {
    void runRename(b, newName, renameRemote);
  });
}

async function runRename(b: BranchRef, newName: string, renameRemote: boolean): Promise<void> {
  const oldName = b.name; // capture before any await (mock may mutate the ref)
  if (newName === oldName) return;
  setStatus(`Renaming ${oldName}…`);
  try {
    await withBusyRef(oldName, () => renameBranch(oldName, newName));
  } catch (err) {
    opFailed("Rename failed", err);
    return;
  }
  let note = `Renamed ${oldName} → ${newName}`;
  if (renameRemote) {
    try {
      // The local rename already landed, so the row now carries the new name.
      await withBusyRef(newName, () => renameRemoteBranch(newName));
      note += " (local and remote)";
    } catch (err) {
      await loadSidebar();
      opFailed(`Renamed local ${b.name}, but remote rename failed`, err);
      return;
    }
  }
  await loadSidebar();
  if (state.view === "history") await refreshHistory();
  reportDone(note);
}

// Delete a branch. A modal confirms and, when the branch genuinely exists on
// its remote (probed live via git ls-remote), offers to also delete it there.
// The local delete is safe (-d) and, if git refuses because it isn't merged,
// offers a force delete behind a second, explicit confirmation.
function deleteBranchAction(b: BranchRef): void {
  const probe = remoteBranchExists(b.name).catch(() => null);
  openDeleteBranchModal(b.name, probe, (deleteRemote) => {
    void runDelete(b, deleteRemote);
  });
}

async function runDelete(b: BranchRef, deleteRemote: boolean): Promise<void> {
  setStatus(`Deleting ${b.name}…`);
  try {
    await withBusyRef(b.name, () => deleteBranch(b.name, false));
  } catch (err) {
    const msg = String(err);
    if (!/not fully merged/i.test(msg)) {
      opFailed("Delete failed", err);
      return;
    }
    const force = await confirmDialog(
      `${b.name} is not fully merged. Force delete? Unmerged commits will be lost.`,
    );
    if (!force) {
      setStatus("Delete cancelled.");
      return;
    }
    try {
      await withBusyRef(b.name, () => deleteBranch(b.name, true));
    } catch (err2) {
      opFailed("Delete failed", err2);
      return;
    }
  }

  let note = `Deleted ${b.name}`;
  if (deleteRemote) {
    try {
      await withBusyRef(b.name, () => deleteRemoteBranch(b.name));
      note += " (local and remote)";
    } catch (err) {
      await loadSidebar();
      opFailed(`Deleted local ${b.name}, but remote delete failed`, err);
      return;
    }
  }
  await loadSidebar();
  reportDone(note);
}

// Open the branch's pull-request page in the browser (URL derived from origin).
async function createPullRequestAction(b: BranchRef): Promise<void> {
  setStatus(`Opening pull request for ${b.name}…`);
  try {
    const url = await createPullRequest(b.name);
    reportDone(`Opened pull request page: ${url}`);
  } catch (err) {
    opFailed("Create pull request failed", err);
  }
}

// Load the commits that would be replayed, then open the interactive-rebase
// editor. Runs the resulting plan against the current branch. `onto` is the
// base the branch is replayed on — a branch name (branch menu) or a commit's
// parent for "rebase to here".
async function openInteractiveRebase(onto: string, ontoLabel: string): Promise<void> {
  const current = state.refs.head ?? "HEAD";
  setStatus(`Preparing rebase of ${current} onto ${ontoLabel}…`);
  try {
    const commits = await fetchRebaseTodo(onto);
    if (commits.length === 0) {
      setStatus(`Nothing to rebase — ${current} has no commits ahead of ${ontoLabel}.`);
      return;
    }
    openRebaseModal(ontoLabel, current, commits, (steps, opts) => {
      void runRebasePlan(onto, ontoLabel, steps, opts);
    });
  } catch (err) {
    readFailed("Rebase preparation failed", err);
  }
}

// Execute a planned rebase: optional backup branch, run it (optionally moving
// dependent refs), then refresh and surface whether it completed or paused.
async function runRebasePlan(
  onto: string,
  ontoLabel: string,
  steps: RebaseStep[],
  opts: RebaseOptions,
): Promise<void> {
  const current = state.refs.head ?? "HEAD";
  setStatus(`Rebasing ${current} onto ${ontoLabel}…`);
  try {
    if (opts.backup) {
      const base = current.replace(/[^\w.-]+/g, "-");
      await createBackupBranch(`${base}-backup-${Date.now()}`);
    }
    const out = (await interactiveRebase(onto, steps, opts.updateRefs)).trim();
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    await refreshRebaseStatus();
    if (!state.rebase?.in_progress) reportDone(out || `Rebased ${current} onto ${ontoLabel}.`);
  } catch (err) {
    await refreshRebaseStatus();
    // A rebase that can't even start (e.g. uncommitted local changes) reports a
    // multi-line reason — surface it in a dialog, not just the status line.
    opFailed("Rebase failed", err);
  }
}

// Interactive rebase of the current branch so `commit` and everything after it
// are in the todo — i.e. replay onto the commit's first parent ("to here").
async function rebaseToHere(commit: CommitRow): Promise<void> {
  await openInteractiveRebase(`${commit.id}~1`, `parent of ${commit.short_id}`);
}

// A one-commit interactive rebase that applies `action` to `commit` alone
// (reword / edit / squash-into-parent / fixup-into-parent / drop). The plan
// replays from the commit's parent; squash/fixup need the parent included too,
// so those replay from the grandparent with the parent kept as a pick.
async function quickRebase(commit: CommitRow, action: RebaseAction, message?: string): Promise<void> {
  const meldsIntoParent = action === "squash" || action === "fixup";
  const onto = meldsIntoParent ? `${commit.id}~2` : `${commit.id}~1`;
  const ontoLabel = meldsIntoParent ? `grandparent of ${commit.short_id}` : `parent of ${commit.short_id}`;
  setStatus(`Preparing ${action} of ${commit.short_id}…`);
  try {
    const commits = await fetchRebaseTodo(onto);
    if (commits.length === 0) {
      setStatus(`Nothing to rebase for ${commit.short_id}.`);
      return;
    }
    const steps: RebaseStep[] = commits.map((c) => ({
      sha: c.sha,
      action: c.sha === commit.id ? action : "pick",
      message: c.sha === commit.id && action === "reword" ? (message ?? c.subject) : null,
    }));
    await runRebasePlan(onto, ontoLabel, steps, { updateRefs: false, backup: false });
  } catch (err) {
    opFailed(`Could not ${action} commit`, err);
  }
}

// --- Bulk commit actions (multi-select in the log) --------------------------

// The multi-selected commits, oldest first — state.rows is newest-first, and
// every bulk action below needs to replay/apply history in chronological
// order.
function selectedCommitsOldestFirst(): CommitRow[] {
  const ids = state.commitSelection;
  return state.rows.filter((r) => ids.has(r.id)).reverse();
}

async function copySelectedShasAction(commits: CommitRow[]): Promise<void> {
  await copyText(commits.map((c) => c.id).join("\n"), `Copied ${commits.length} SHA${commits.length === 1 ? "" : "s"}.`);
}

// Drop every selected commit via an interactive rebase from the oldest one's
// parent to HEAD — valid for any selection, contiguous or not.
async function dropSelectedCommits(commits: CommitRow[]): Promise<void> {
  const oldest = commits[0];
  const onto = `${oldest.id}~1`;
  const ids = new Set(commits.map((c) => c.id));
  setStatus(`Preparing to drop ${commits.length} commits…`);
  try {
    const todo = await fetchRebaseTodo(onto);
    const steps: RebaseStep[] = todo.map((c) => ({ sha: c.sha, action: ids.has(c.sha) ? "drop" : "pick", message: null }));
    await runRebasePlan(onto, `parent of ${oldest.short_id}`, steps, { updateRefs: false, backup: false });
  } catch (err) {
    opFailed("Could not drop commits", err);
  }
}

// Squash every selected commit into one, via the same rebase-plan mechanism:
// the oldest selected commit stays `pick` (the target) and every other
// selected one becomes `squash`, melding forward into it in order. That only
// produces one combined commit if the selection is a contiguous run in the
// rebase todo — a scattered selection would instead squash each into
// whatever unrelated commit happens to precede it, so it's rejected instead.
async function squashSelectedCommits(commits: CommitRow[]): Promise<void> {
  const oldest = commits[0];
  const onto = `${oldest.id}~1`;
  const ids = new Set(commits.map((c) => c.id));
  setStatus(`Preparing to squash ${commits.length} commits…`);
  try {
    const todo = await fetchRebaseTodo(onto);
    const selectedIdxs = todo.map((c, i) => (ids.has(c.sha) ? i : -1)).filter((i) => i >= 0);
    if (selectedIdxs.length !== ids.size) {
      opFailed(
        "Could not squash commits",
        "Some selected commits aren't on a straight line from here to HEAD (e.g. on a different branch), so they can't be rebased together.",
      );
      return;
    }
    const [first, last] = [Math.min(...selectedIdxs), Math.max(...selectedIdxs)];
    if (last - first + 1 !== selectedIdxs.length) {
      opFailed(
        "Could not squash commits",
        "The selected commits aren't consecutive in history. Squash only combines an unbroken run of commits into one — select a contiguous range and try again.",
      );
      return;
    }
    const steps: RebaseStep[] = todo.map((c, i) => ({
      sha: c.sha,
      action: !ids.has(c.sha) ? "pick" : i === first ? "pick" : "squash",
      message: null,
    }));
    await runRebasePlan(onto, `parent of ${oldest.short_id}`, steps, { updateRefs: false, backup: false });
  } catch (err) {
    opFailed("Could not squash commits", err);
  }
}

// Cherry-pick every selected commit, oldest first. A conflict pauses the
// batch on the normal conflict resolver; finishing it resumes with whatever
// is left in `pendingCherryPicks`, aborting cancels the rest (see the
// conflictView onDone hook in init()).
let pendingCherryPicks: CommitRow[] = [];

async function cherryPickSelectedCommits(commits: CommitRow[]): Promise<void> {
  pendingCherryPicks = commits;
  await runNextCherryPick();
}

async function runNextCherryPick(): Promise<void> {
  const next = pendingCherryPicks.shift();
  if (!next) return;
  setStatus(
    `Cherry-picking ${next.short_id}${pendingCherryPicks.length ? ` (${pendingCherryPicks.length} more queued)` : ""}…`,
  );
  try {
    const out = (await cherryPick(next.id)).trim();
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    if (pendingCherryPicks.length) {
      reportDone(out || `Cherry-picked ${next.short_id}.`);
      await runNextCherryPick();
    } else {
      reportDone(out || `Cherry-picked ${next.short_id}.`);
    }
  } catch (err) {
    // A conflict leaves the cherry-pick in progress — hand off to the
    // resolver, which resumes (or cancels) the rest of the queue on its own.
    await Promise.all([refreshConflictStatus(), refreshRebaseStatus()]);
    if (state.conflict?.conflicted.length) {
      showView("conflict");
      setStatus(`${next.short_id} conflicted — resolve it to continue the batch.`);
    } else {
      pendingCherryPicks = [];
      opFailed("Cherry-pick failed", err);
    }
  }
}

// --- Rebase in progress (pause / continue / skip / abort) -------------------

// Refresh the paused-rebase state and (re)paint the banner.
async function refreshRebaseStatus(): Promise<void> {
  try {
    state.rebase = await fetchRebaseStatus();
  } catch {
    state.rebase = null;
  }
  renderRebaseBanner();
}

// Refresh the conflict session and (re)paint the merge-conflict banner. Use
// this only when no snapshot is at hand (loadSidebar already carries one).
async function refreshConflictStatus(): Promise<void> {
  try {
    applyConflictStatus(await conflictStatus());
  } catch {
    applyConflictStatus(null);
  }
}

// Adopt a conflict-status result: repaint the banner, carry the pending commit
// message over to Local Changes, and never strand the user on a resolver view
// for a session that has ended.
function applyConflictStatus(st: ConflictStatus | null): void {
  state.conflict = st && st.kind !== "none" ? st : null;
  renderConflictBanner();
  // Once conflicts are resolved (files staged) a plain commit correctly
  // finishes a merge/cherry-pick/revert, same as the command line — so the
  // pending message should already be sitting in Local Changes, ready to go,
  // whether the user finishes there or comes back to the resolver.
  if (state.conflict?.message) {
    const summary = state.conflict.summary;
    const rest = state.conflict.message.startsWith(summary)
      ? state.conflict.message.slice(summary.length)
      : state.conflict.message;
    changesView?.prefillMessage(summary, rest.replace(/^\s+/, "").trimEnd());
  }
  // A resolved/aborted merge should not strand the user on the conflict view.
  if (state.view === "conflict" && !state.conflict) showView("history");
}

// Title for each non-rebase conflict kind, used by both the banner and error
// dialogs. Rebase conflicts are surfaced by the rebase banner instead.
const CONFLICT_BANNER_TITLE: Record<string, string> = {
  merge: "Merge conflicts",
  "cherry-pick": "Cherry-pick conflicts",
  revert: "Revert conflicts",
};

// A top bar shown while a merge/cherry-pick/revert is in conflict, offering
// Resolve / Abort. Rebase conflicts are surfaced by the rebase banner (which
// links here too).
function renderConflictBanner(): void {
  let banner = document.getElementById("conflict-banner");
  const st = state.conflict;
  const title = st ? CONFLICT_BANNER_TITLE[st.kind] : undefined;
  // No banner while the resolver view itself is open (it would be redundant and
  // its count only refreshes on sidebar reloads).
  const show = Boolean(title) && st!.conflicted.length > 0 && state.view !== "conflict";
  if (!show) {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = el("div", { id: "conflict-banner", class: "rebase-banner conflict-banner" });
    document.body.append(banner);
  }
  clear(banner);
  const info = el("div", { class: "rebase-banner-info" }, [
    el("span", { class: "rebase-banner-title", text: `${title} (${st!.conflicted.length})` }),
    el("span", { class: "rebase-banner-sub", text: st!.summary }),
  ]);
  const resolve = el("button", { class: "btn small", text: "Resolve Conflicts" });
  resolve.addEventListener("click", () => showView("conflict"));
  const abort = el("button", { class: "btn small danger", text: "Abort" });
  abort.addEventListener("click", () => void abortConflictAction());
  banner.append(info, el("div", { class: "rebase-banner-actions" }, [resolve, abort]));
}

async function abortConflictAction(): Promise<void> {
  const ok = await confirmDialog("Abort this operation? All conflict resolutions will be discarded.");
  if (!ok) return;
  try {
    const out = await abortConflict();
    conflictView?.reset(); // forget partial choices so a re-merge starts fresh
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    reportDone(out.trim() || "Aborted.");
  } catch (err) {
    opFailed("Abort failed", err);
  }
}

// A top bar shown only while a rebase is paused: what it stopped for, on which
// commit, any conflicts, and Continue / Skip / Abort.
function renderRebaseBanner(): void {
  let banner = document.getElementById("rebase-banner");
  const st = state.rebase;
  if (!st?.in_progress) {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = el("div", { id: "rebase-banner", class: "rebase-banner" });
    document.body.append(banner);
  }
  clear(banner);

  const conflict = st.paused_for === "conflict";
  const sha = st.current_sha ? st.current_sha.slice(0, 8) : "";
  const info = el("div", { class: "rebase-banner-info" }, [
    el("span", {
      class: "rebase-banner-title",
      text: conflict
        ? `Rebase stopped on a conflict (${st.done}/${st.total})`
        : `Rebase stopped to edit ${sha} (${st.done}/${st.total})`,
    }),
  ]);
  if (st.current_subject) info.append(el("span", { class: "rebase-banner-sub", text: st.current_subject }));
  if (conflict && st.conflicted_files.length) {
    info.append(el("span", { class: "rebase-banner-files", text: `Conflicts: ${st.conflicted_files.join(", ")}` }));
  } else if (!conflict) {
    info.append(el("span", { class: "rebase-banner-sub", text: "Amend your changes, then Continue." }));
  }

  const actions = el("div", { class: "rebase-banner-actions" });
  if (conflict) {
    const resolve = el("button", { class: "btn small", text: "Resolve Conflicts" });
    resolve.addEventListener("click", () => showView("conflict"));
    actions.append(resolve);
  }
  const cont = el("button", { class: "btn small", text: "Continue" });
  cont.addEventListener("click", () => void rebaseControl("continue"));
  const skip = el("button", { class: "btn small ghost", text: "Skip" });
  skip.addEventListener("click", () => void rebaseControl("skip"));
  const abort = el("button", { class: "btn small danger", text: "Abort" });
  abort.addEventListener("click", () => void rebaseControl("abort"));
  actions.append(cont, skip, abort);

  banner.append(info, actions);
}

async function rebaseControl(kind: "continue" | "skip" | "abort"): Promise<void> {
  const label = kind === "continue" ? "Continuing" : kind === "skip" ? "Skipping" : "Aborting";
  setStatus(`${label} rebase…`);
  try {
    const op = kind === "continue" ? rebaseContinue : kind === "skip" ? rebaseSkip : rebaseAbort;
    const out = (await op()).trim();
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    await refreshRebaseStatus();
    if (!state.rebase?.in_progress) reportDone(out || `${label} done.`);
  } catch (err) {
    await refreshRebaseStatus();
    opFailed(`${label} rebase failed`, err);
  }
}

// --- Commit right-click menu ------------------------------------------------

// Open the context menu for a right-clicked commit, wiring each item to the
// action that runs the git command and refreshes the view.
function onCommitBulkContextMenu(x: number, y: number): void {
  const commits = selectedCommitsOldestFirst();
  const n = commits.length;
  const items: MenuItem[] = [
    { label: `Cherry-pick ${n} Commits`, run: () => void cherryPickSelectedCommits(commits) },
    { label: `Copy ${n} SHAs`, run: () => void copySelectedShasAction(commits) },
    { separator: true },
    { label: `Squash ${n} Commits…`, run: () => void squashSelectedCommits(commits) },
    {
      label: `Drop ${n} Commits…`,
      danger: true,
      run: () =>
        void confirmThenRun(`Drop ${n} commits? This rewrites branch history.`, `Dropping ${n} commits`, async () => {
          await dropSelectedCommits(commits);
          return "";
        }),
    },
  ];
  showContextMenu(x, y, items);
}

function onCommitContextMenu(row: CommitRow, x: number, y: number): void {
  // log.ts already collapsed the selection to just this row on right-click if
  // it wasn't part of it, so >1 here means the click landed inside a real
  // multi-selection.
  if (state.commitSelection.size > 1) {
    onCommitBulkContextMenu(x, y);
    return;
  }
  const rev = row.id;
  const short = row.short_id;
  showCommitMenu(x, y, row, {
    currentBranch: state.refs.head ?? "HEAD",
    copySha: () => void copySha(rev),
    checkoutCommit: () => void checkoutCommitAction(rev, short),
    newBranch: (name) => void runCommitOp(`Creating ${name}`, () => createBranchAt(name, rev), rev),
    newTag: (name) => void tagAction(name, rev, short),
    cherryPick: () => void runCommitOp(`Cherry-picking ${short}`, () => cherryPick(rev)),
    revert: () => void runCommitOp(`Reverting ${short}`, () => revertCommit(rev)),
    reset: (mode) => void resetAction(rev, short, mode),
    rebaseToHere: () => void rebaseToHere(row),
    rewordCommit: (message) => void quickRebase(row, "reword", message),
    editCommit: () => void quickRebase(row, "edit"),
    squashIntoParent: () => void quickRebase(row, "squash"),
    fixupIntoParent: () => void quickRebase(row, "fixup"),
    dropCommit: () =>
      void confirmThenRun(
        `Drop commit ${short}? This rewrites branch history.`,
        `Dropping ${short}`,
        async () => {
          await quickRebase(row, "drop");
          return "";
        },
      ),
  });
}

// Run a HEAD-moving commit op, then reload history + sidebar from the new HEAD.
// Shows git's own output on success (e.g. cherry-pick/revert summaries).
//
// `landRev`: for ops that move HEAD to a SPECIFIC, possibly historical commit
// (detached checkout, "create branch at" an old commit/tag) — select and
// scroll to that exact commit afterwards instead of the default "jump to the
// newest commit", which lands on the wrong row whenever the checked-out
// commit isn't the newest one in the log (e.g. checking out an old release
// tag). Ops that move the current branch's tip (commit/cherry-pick/revert/
// reset/rebase) omit it — their new HEAD genuinely is the newest commit.
async function runCommitOp(label: string, op: () => Promise<string>, landRev?: string): Promise<void> {
  setStatus(`${label}…`);
  try {
    const out = (await op()).trim();
    showView("history");
    if (landRev) await Promise.all([landOnCommit(landRev), loadSidebar()]);
    else await Promise.all([refreshHistory(), loadSidebar()]);
    reportDone(out || `${label} done.`);
  } catch (err) {
    // A failed op (cherry-pick, revert, rebase, …) may have left a conflict
    // in progress — offer Resolve Conflicts instead of just the raw git
    // error, same as runBranchOp already does for a failed merge.
    await Promise.all([refreshConflictStatus(), refreshRebaseStatus()]);
    const inConflict =
      (state.conflict !== null && state.conflict.conflicted.length > 0) ||
      (state.rebase?.in_progress === true && state.rebase.paused_for === "conflict");
    opFailed(
      `${label} failed`,
      err,
      inConflict ? { label: "Resolve Conflicts", run: () => showView("conflict") } : undefined,
    );
  }
}

// Refresh the log, then select and scroll to `rev` — like clicking that
// commit would — instead of defaulting to the newest one. See runCommitOp's
// `landRev`.
async function landOnCommit(rev: string): Promise<void> {
  await refreshHistory();
  const idx = state.rows.findIndex((r) => r.id === rev);
  state.selectedId = rev;
  logView = renderLog($("#log-pane"), state.rows, state.selectedId, selectCommit, loadMoreCommits, refLabelsAt, onCommitContextMenu, state.commitSelection, onCommitMultiSelect);
  if (idx >= 0) {
    const pane = $("#log-pane");
    pane.scrollTop = Math.max(0, idx * GRAPH_METRICS.rowHeight - pane.clientHeight / 2);
  }
  await selectCommit(rev);
}

// Confirm first (destructive/history-rewriting ops), then run.
async function confirmThenRun(
  question: string,
  label: string,
  op: () => Promise<string>,
): Promise<void> {
  if (!(await confirmDialog(question))) {
    setStatus(`${label} cancelled.`);
    return;
  }
  await runCommitOp(label, op);
}

// Detached checkout — warns first if the working tree has uncommitted changes,
// mirroring the branch checkout flow.
async function checkoutCommitAction(rev: string, short: string): Promise<void> {
  if (state.localChanges > 0) {
    const n = state.localChanges;
    const ok = await confirmDialog(
      `You have ${n} uncommitted change${n === 1 ? "" : "s"}.\n\n` +
        `Check out ${short} (detached HEAD)? Conflicting changes will block it.`,
    );
    if (!ok) {
      setStatus("Checkout cancelled.");
      return;
    }
  }
  await runCommitOp(`Checking out ${short}`, () => checkoutCommit(rev), rev);
}

async function resetAction(rev: string, short: string, mode: ResetMode): Promise<void> {
  const question =
    mode === "Hard"
      ? `Hard reset the current branch to ${short}?\n\n` +
        "Uncommitted changes and any commits after it on this branch will be lost."
      : `${mode} reset the current branch to ${short}?`;
  await confirmThenRun(question, `Resetting (${mode.toLowerCase()}) to ${short}`, () =>
    resetTo(rev, mode),
  );
}

// Tagging doesn't move HEAD, so it only refreshes the sidebar (to show the tag)
// and leaves the current view/scroll alone.
async function tagAction(name: string, rev: string, short: string): Promise<void> {
  setStatus(`Tagging ${short} as ${name}…`);
  try {
    await createTagAt(name, rev);
    await loadSidebar();
    reportDone(`Tagged ${short} as ${name}`);
  } catch (err) {
    opFailed("Tag failed", err);
  }
}

async function copySha(rev: string): Promise<void> {
  await copyText(rev, `Copied ${rev.slice(0, 10)} to clipboard`);
}

// Copy `text` to the clipboard. Uses the async clipboard API, falling back to a
// hidden textarea for webviews where it's unavailable.
async function copyText(text: string, note: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el("textarea", { text }) as HTMLTextAreaElement;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      ta.remove();
    }
  }
  setStatus(note);
}

// The Branch button's dropdown: pick a local branch to check out, or create a
// new one from the current HEAD. Rebuilt from current refs each time it opens.
// --- Quick Launch -----------------------------------------------------------

// Everything gitp can do, reachable from one keystroke.
//
// Commands come in three shapes. Most just `run`. Ones that need a target set
// `next`, which returns a second stage whose list is the picker for it (a
// branch, a stash, a file) — see quick-launch.ts. A few open an existing
// dialog, which is simply what their `run` does.
//
// Anything requiring an open repository is left out when none is, rather than
// listed and failing on Enter.

function openQuickLaunch(): void {
  if (isQuickLaunchOpen()) return closeQuickLaunch();
  showQuickLaunch({
    placeholder: state.repoPath ? "Command" : "Open a repository",
    sections: [
      { title: "Recent Repositories", items: recentRepoItems() },
      { title: "Commands", items: state.repoPath ? repoCommands() : openOnlyCommands() },
    ],
  });
}

// `~/…` rather than the absolute path, the way every git client shows it.
//
// Matched structurally rather than against a known home directory, which the
// webview has no way to ask for; a path under some *other* user's home would be
// shortened too, but that only ever affects how it reads, never where it opens.
function tildePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+\//, "~/");
}

function recentRepoItems(opts: { skipActive?: boolean } = {}): QuickItem[] {
  return loadRecentRepos()
    .filter((path) => !(opts.skipActive && path === state.repoPath))
    .map((path) => ({
      kind: "repo" as const,
      label: path.split("/").filter(Boolean).pop() ?? path,
      detail: tildePath(path),
      run: () => void openRecentRepo(path),
    }));
}

async function openRecentRepo(path: string): Promise<void> {
  if (path === state.repoPath) {
    setStatus(`Already in ${path}.`);
    return;
  }
  // Already a tab: switch rather than reopening, which would be a no-op that
  // silently skips loading the log.
  if (state.repos.some((r) => r.path === path)) {
    await switchRepo(path);
    return;
  }
  try {
    await loadRepo(path);
  } catch {
    // loadRepo reports its own failure; drop the entry so a repo that has been
    // moved or deleted stops being offered.
    forgetRecentRepo(path);
  }
}

function openOnlyCommands(): QuickItem[] {
  return [
    { kind: "command", label: "Open Repository…", run: () => void browseAndOpen() },
    { kind: "command", label: "Terminal", run: toggleTerminal },
  ];
}

async function browseAndOpen(): Promise<void> {
  const path = await browseForRepo();
  if (path) await loadRepo(path);
}

// The branches, stashes and files a target picker offers, as palette items.
function branchStage(chip: string, onPick: (b: BranchRef) => void, skipHead = false): QuickStage {
  return {
    chip,
    placeholder: "branch",
    emptyNote: skipHead
      ? "No other local branches — this repository has only the one you're on."
      : "This repository has no local branches.",
    sections: [
      {
        title: "Local Branches",
        items: state.refs.branches
          .filter((b) => !(skipHead && b.is_head))
          .map((b) => ({
            kind: "branch" as const,
            label: b.name,
            detail: b.is_head ? "current" : undefined,
            run: () => onPick(b),
          })),
      },
    ],
  };
}

// Every file tracked at the selected commit (or HEAD) — the whole repository,
// not just what the current commit happens to touch.
async function fileStage(chip: string, mode: "blame" | "history"): Promise<QuickStage> {
  const paths = await fetchCommitTree(fileRev());
  return {
    chip,
    placeholder: "file",
    emptyNote: "This commit has no tracked files.",
    sections: [
      {
        title: "Files",
        items: paths.map((path) => ({
          kind: "file" as const,
          // Filename first, directory as the dimmed detail — a palette is
          // searched by name, and full paths would push every name off-screen.
          label: path.split("/").pop() ?? path,
          detail: path,
          run: () => void openFileIn(path, mode),
        })),
      },
    ],
  };
}

function fileRev(): string {
  return state.selectedId ?? "HEAD";
}

// Show `path` in Blame or History view.
//
// Those views live in the detail pane, which renders a file of the *selected
// commit* — so we first jump to the newest commit that touched this path. That
// isn't a workaround so much as the right answer: "blame this file" means as of
// its last change, not as of whichever commit happened to be selected.
async function openFileIn(path: string, mode: "blame" | "history"): Promise<void> {
  const label = mode === "blame" ? "Blame" : "History";
  setStatus(`Loading ${label.toLowerCase()} of ${path}…`);
  try {
    const history = await fetchFileHistory(fileRev(), path);
    const newest = history[0]?.id;
    if (!newest) {
      setStatus(`No commit reachable from here touches ${path}.`);
      return;
    }
    if (state.view !== "history") showView("history");
    await selectCommit(newest);
    if (detailView?.openFile(path, mode)) setStatus(`${label} of ${path} @ ${newest.slice(0, 7)}`);
    else setStatus(`${path} isn't part of ${newest.slice(0, 7)} — nothing to show.`);
  } catch (err) {
    readFailed(`${label} of ${path} failed`, err);
  }
}

function repoCommands(): QuickItem[] {
  const head = state.refs.head;
  const items: QuickItem[] = [
    {
      kind: "command",
      label: "Blame…",
      next: () => fileStage("Blame", "blame"),
    },
    {
      kind: "command",
      label: "Checkout Branch",
      next: () => branchStage("Checkout Branch", (b) => void checkoutBranchAction(b), true),
    },
    {
      kind: "command",
      label: "Create Branch…",
      run: () => promptFor("New branch name", (name) => void createBranchAction(name)),
    },
    {
      kind: "command",
      label: "Create Pull Request on 'origin'",
      next: () => branchStage("Create Pull Request", (b) => void createPullRequestAction(b)),
    },
    {
      kind: "command",
      label: "Create Tag…",
      run: () =>
        promptFor("New tag name", (name) => {
          // Tag the selected commit, or the branch tip when nothing is selected
          // (opening the palette straight after launch, say).
          const rev = state.selectedId ?? headTarget();
          if (!rev) return setStatus("Nothing to tag — no commit is selected.");
          void tagAction(name, rev, rev.slice(0, 7));
        }),
    },
    {
      kind: "command",
      label: "Delete Branch…",
      next: () =>
        branchStage("Delete Branch", (b) => {
          setStatus(`Delete ${b.name}…`);
          deleteBranchAction(b);
        }, true),
    },
    {
      kind: "command",
      label: "Fast-forward",
      next: () =>
        branchStage("Fast-forward", (b) =>
          void runBranchOp(`Fast-forwarding ${b.name}`, () => fastForwardBranch(b.name), true, b.name),
        ),
    },
    { kind: "command", label: "Fetch…", run: openFetchOptions },
    {
      kind: "command",
      label: "File History…",
      next: () => fileStage("File History", "history"),
    },
    { kind: "command", label: "Local Changes", run: () => showView("changes") },
    { kind: "command", label: "Log (All Commits)", run: () => showView("history") },
    {
      kind: "command",
      label: "Pull…",
      next: () => pullStage(),
    },
    { kind: "command", label: "Push", run: () => void pushAction() },
    { kind: "command", label: "Push (force-with-lease)", run: () => void pushForceAction() },
    {
      kind: "command",
      label: "Rebase…",
      next: () =>
        branchStage("Rebase onto", (b) =>
          void confirmThenRun(
            `Rebase ${head} onto ${b.name}? This rewrites commits on ${head}.`,
            `Rebasing ${head} onto ${b.name}`,
            () => rebaseOnto(b.name),
          ),
        true),
    },
    {
      kind: "command",
      label: "Rebase Interactively…",
      next: () => branchStage("Interactive Rebase onto", (b) => void openInteractiveRebase(b.name, b.name), true),
    },
    { kind: "command", label: "Clean up (prune remotes, delete gone branches)", run: () => void cleanUpAction() },
    { kind: "command", label: "Refresh (fetch all remotes)", run: () => void refreshAllAction() },
    {
      kind: "command",
      label: "Rename Branch…",
      next: () =>
        branchStage("Rename Branch", (b) => {
          setStatus(`Rename ${b.name}…`);
          renameBranchAction(b);
        }),
    },
    { kind: "command", label: "Repository Settings…", run: () => showView("config") },
    { kind: "command", label: "Reveal in Finder", run: () => void revealRepo() },
    { kind: "command", label: "Save Stash", run: () => void stashAction() },
    { kind: "command", label: "Switch Repository", next: () => repoStage() },
    { kind: "command", label: "Open Repository…", run: () => void browseAndOpen() },
    { kind: "command", label: "Close Repository", run: () => void closeRepoTab(state.repoPath) },
    { kind: "command", label: "Terminal", run: toggleTerminal },
    {
      kind: "command",
      label: "Checkout Remote Branch",
      next: () => remoteStage(),
      },
    {
      kind: "command",
      label: "Fetch Branch…",
      next: () =>
        branchStage("Fetch Branch", (b) =>
          void runBranchOp(`Fetching updates for ${b.name}`, () => fetchBranch(b.name), false, b.name),
        ),
    },
    {
      kind: "command",
      label: "Fetch and Update Branch…",
      next: () =>
        branchStage("Fetch and Update", (b) =>
          void runBranchOp(`Fetching and updating ${b.name}`, () => fetchAndUpdateBranch(b.name), true, b.name),
        ),
    },
    {
      kind: "command",
      label: "Push Branch…",
      next: () =>
        branchStage("Push Branch", (b) =>
          void runBranchOp(`Pushing ${b.name}`, () => pushBranch(b.name), false, b.name),
        ),
    },
    {
      kind: "command",
      label: "Set Upstream…",
      next: () =>
        branchStage("Set Upstream of", (b) =>
          promptFor("Upstream (e.g. origin/main)", (up) =>
            void runBranchOp(`Setting upstream of ${b.name}`, () => setUpstream(b.name, up), false, b.name),
          ),
        ),
    },
    {
      kind: "command",
      label: "Unset Upstream…",
      next: () =>
        branchStage("Unset Upstream of", (b) =>
          void runBranchOp(`Unsetting upstream of ${b.name}`, () => unsetUpstream(b.name), false, b.name),
        ),
    },
    { kind: "command", label: "Stage All Changes", run: () => void stageAllAction() },
    { kind: "command", label: "Unstage All Changes", run: () => void unstageAllAction() },
    ...commitCommands(),
  ];

  if (!head) {
    // Detached HEAD: merging and rebasing "into the current branch" has no
    // meaning to offer.
    return items.filter((i) => !i.label.startsWith("Rebase") && !i.label.startsWith("Merge"));
  }
  items.push({
    kind: "command",
    label: `Merge into ${head}`,
    next: () =>
      branchStage(`Merge into ${head}`, (b) =>
        void runBranchOp(`Merging ${b.name} into ${head}`, () => mergeBranch(b.name), true, b.name),
      true),
  });
  if (state.refs.stashes.length) {
    items.push(
      { kind: "command", label: "Apply Stash…", next: () => stashStage("Apply Stash", applyStashPicked) },
      { kind: "command", label: "Pop Stash", run: () => void popAction() },
      {
        kind: "command",
        label: "Drop Stash…",
        next: () =>
          stashStage("Drop Stash", (st) => {
            setStatus(`Drop stash@{${st.index}}…`);
            void deleteStashAction(st);
          }),
      },
      {
        kind: "command",
        label: "Rename Stash…",
        next: () =>
          stashStage("Rename Stash", (st) =>
            promptFor("Stash message", (message) =>
              void runStashOp(`Renaming stash@{${st.index}}`, () => renameStash(st.index, message)),
            ),
          ),
      },
      {
        kind: "command",
        label: "Save Stash as Patch…",
        next: () =>
          stashStage("Save as Patch", (st) => {
            setStatus(`Save stash@{${st.index}} as a patch…`);
            void saveStashPatchAction(st);
          }),
      },
    );
  }
  if (undoLabels.undo) items.push({ kind: "command", label: `Undo ${undoLabels.undo}`, run: () => void undoAction() });
  if (undoLabels.redo) items.push({ kind: "command", label: `Redo ${undoLabels.redo}`, run: () => void redoAction() });
  items.sort((a, b) => a.label.localeCompare(b.label));
  return items;
}

// `open_in_editor`/`reveal` succeed or fail entirely in the OS, so without a
// status line a failed reveal is indistinguishable from a dead menu entry.
async function revealRepo(): Promise<void> {
  try {
    await revealPath(state.repoPath);
    setStatus(`Revealed ${state.repoPath}`);
  } catch (err) {
    readFailed("Couldn't reveal the repository", err);
  }
}

// Fetch with pruning, then delete every local branch whose upstream is gone —
// the tidy-up after a batch of pull requests has been merged and their remote
// branches deleted.
//
// The deletion is forced (`git branch -D`), because a branch merged via a
// squash or rebase merge does not look merged to git and `-d` would refuse it.
// That is the whole point of the command, and also why it confirms with the
// full list first: forced deletion of work that only exists locally is not
// recoverable from the branch itself.
async function cleanUpAction(): Promise<void> {
  if (!state.repoPath) return;
  setActionsBusy(true, "#refresh-btn");
  setStatus("Fetching and pruning…");
  try {
    await fetchAll();
    const gone = await goneBranches();
    if (gone.length === 0) {
      await loadSidebar();
      setStatus("Nothing to clean up — no branches have a deleted upstream.");
      return;
    }
    const ok = await confirmDialog(
      `Delete ${gone.length} local branch${gone.length === 1 ? "" : "es"} whose upstream is gone?\n\n` +
        `${gone.join("\n")}\n\n` +
        `This is a forced delete — any commits on them that were never pushed will be lost.`,
    );
    if (!ok) {
      await loadSidebar();
      setStatus("Clean up cancelled — pruned remotes, kept every branch.");
      return;
    }

    for (const name of gone) state.busyRefs.add(name);
    renderSidebarNow();
    // One call, so the whole batch is a single undoable action — Undo brings
    // back every branch it removed, not just the last.
    let failed: string[] = [];
    try {
      ({ failed } = await deleteBranches(gone, true));
    } finally {
      state.busyRefs.clear();
      renderSidebarNow();
    }

    state.branchSelection = new Set();
    await Promise.all([loadSidebar(), refreshHistory()]);
    const deleted = gone.length - failed.length;
    reportDone(
      failed.length
        ? `Cleaned up ${deleted} of ${gone.length} branches — Undo restores them. Failed: ${failed.join(", ")}.`
        : `Cleaned up ${deleted} branch${deleted === 1 ? "" : "es"} — Undo restores them.`,
    );
  } catch (err) {
    opFailed("Clean up failed", err);
  } finally {
    setActionsBusy(false);
  }
}

function headTarget(): string | null {
  return state.refs.branches.find((b) => b.is_head)?.target ?? null;
}

function repoStage(): QuickStage {
  return {
    chip: "Switch Repository",
    placeholder: "repository",
    emptyNote: "No other repositories opened yet.",
    // Offering the repo you're already in would be a row that does nothing.
    sections: [{ title: "Recent Repositories", items: recentRepoItems({ skipActive: true }) }],
  };
}

function stashStage(chip: string, onPick: (stash: StashRef) => void): QuickStage {
  return {
    chip,
    placeholder: "stash",
    emptyNote: "This repository has no stashes.",
    sections: [
      {
        title: "Stashes",
        items: state.refs.stashes.map((st) => ({
          kind: "option" as const,
          label: st.message,
          detail: `stash@{${st.index}}`,
          run: () => onPick(st),
        })),
      },
    ],
  };
}

// The same apply/pop choice the stash context menu offers.
//
// Commands that open a dialog say so in the status bar first. Without it a
// dialog that fails to appear for any reason is indistinguishable from a
// command that never ran, which leaves nothing to report but "it did nothing".
function applyStashPicked(st: StashRef): void {
  setStatus(`Apply stash@{${st.index}}…`);
  openStashApplyModal(st, (drop) => {
    const verb = drop ? "Popping" : "Applying";
    void runStashOp(`${verb} stash@{${st.index}}`, () => applyStash(st.index, drop));
  });
}

function remoteStage(): QuickStage {
  return {
    chip: "Checkout Remote Branch",
    placeholder: "remote branch",
    emptyNote: "No remote-tracking branches — fetch a remote first.",
    sections: [
      {
        title: "Remote Branches",
        items: state.refs.remotes.map((r) => ({
          kind: "branch" as const,
          label: r.name,
          run: () => void checkoutRemoteAction(r.name),
        })),
      },
    ],
  };
}

// Operations on the commit the log has selected. Its short SHA goes in every
// label: these rewrite or move history, and "Revert" with no indication of
// *what* is being reverted is the kind of ambiguity a palette must not have.
function commitCommands(): QuickItem[] {
  const rev = state.selectedId;
  if (!rev) return [];
  const row = state.rows.find((r) => r.id === rev);
  const short = row?.short_id ?? rev.slice(0, 7);
  const items: QuickItem[] = [
    { kind: "command", label: `Copy SHA of ${short}`, run: () => void copySha(rev) },
    { kind: "command", label: `Checkout Commit ${short}`, run: () => void checkoutCommitAction(rev, short) },
    {
      kind: "command",
      label: `Cherry-pick ${short}`,
      run: () => void runCommitOp(`Cherry-picking ${short}`, () => cherryPick(rev)),
    },
    {
      kind: "command",
      label: `Revert ${short}`,
      run: () => void runCommitOp(`Reverting ${short}`, () => revertCommit(rev)),
    },
    { kind: "command", label: `Reset to ${short}…`, next: () => resetStage(rev, short) },
    {
      kind: "command",
      label: `New Branch at ${short}…`,
      run: () =>
        promptFor("New branch name", (name) =>
          void runCommitOp(`Creating ${name}`, () => createBranchAt(name, rev), rev),
        ),
    },
  ];
  // The interactive-rebase shortcuts need the full row (they replay the range
  // from this commit), so they're only offered for a commit in the loaded log.
  if (row) {
    items.push(
      {
        kind: "command",
        label: `Reword ${short}…`,
        run: () => promptFor("New commit message", (message) => void quickRebase(row, "reword", message)),
      },
      { kind: "command", label: `Edit ${short}`, run: () => void quickRebase(row, "edit") },
      { kind: "command", label: `Squash ${short} into Parent`, run: () => void quickRebase(row, "squash") },
      { kind: "command", label: `Fixup ${short} into Parent`, run: () => void quickRebase(row, "fixup") },
      {
        kind: "command",
        label: `Drop Commit ${short}`,
        run: () =>
          void confirmThenRun(
            `Drop commit ${short}? This rewrites branch history.`,
            `Dropping ${short}`,
            async () => {
              await quickRebase(row, "drop");
              return "";
            },
          ),
      },
      { kind: "command", label: `Rebase to ${short}`, run: () => void rebaseToHere(row) },
    );
  }
  return items;
}

function resetStage(rev: string, short: string): QuickStage {
  const modes: [ResetMode, string][] = [
    ["Soft", "Soft — keep the working tree and the index"],
    ["Mixed", "Mixed — keep the working tree, reset the index"],
    ["Hard", "Hard — discard all local changes"],
  ];
  return {
    chip: `Reset to ${short}`,
    placeholder: "mode",
    sections: [
      {
        title: "Modes",
        items: modes.map(([mode, label]) => ({
          kind: "option" as const,
          label,
          run: () => void resetAction(rev, short, mode),
        })),
      },
    ],
  };
}

// Stage/unstage everything, then show the result — running them from the
// palette while looking at the log would otherwise change nothing on screen.
async function stageAllAction(): Promise<void> {
  setStatus("Staging all changes…");
  try {
    await stageAll();
    showView("changes");
    await Promise.all([loadChanges(), loadSidebar()]);
    reportDone("Staged all changes.");
  } catch (err) {
    opFailed("Stage all failed", err);
  }
}

async function unstageAllAction(): Promise<void> {
  setStatus("Unstaging all changes…");
  try {
    await unstageAll();
    showView("changes");
    await Promise.all([loadChanges(), loadSidebar()]);
    reportDone("Unstaged all changes.");
  } catch (err) {
    opFailed("Unstage all failed", err);
  }
}

function pullStage(): QuickStage {
  return {
    chip: "Pull",
    placeholder: "method",
    sections: [
      {
        // The same four methods the Pull button's caret menu offers, named the
        // same way, so the palette can't drift from it.
        title: "Methods",
        items: PULL_DEFAULTS.map((mode) => ({
          kind: "option" as const,
          label: PULL_DEFAULT_LABEL[mode],
          run: () => void runPullMethod(mode),
        })),
      },
    ],
  };
}

function openFetchOptions(): void {
  setStatus("Choose what to fetch…");
  // Remote *names* aren't a field of their own — derive them from the
  // remote-tracking branches the sidebar already has.
  const names = [...new Set(state.refs.remotes.map((r) => r.remote))].sort();
  openFetchDialog(names, (remote) => {
    if (remote === null) void refreshAllAction();
    else void runBranchOp(`Fetching ${remote}`, () => fetchRemote(remote), true, remote);
  });
}

// A one-field prompt, reusing the context menu's inline input at the centre of
// the window so a palette command that needs a name doesn't need its own modal.
function promptFor(placeholder: string, onSubmit: (value: string) => void): void {
  showContextMenu(window.innerWidth / 2 - 120, window.innerHeight / 3, [
    { label: placeholder, prompt: { placeholder, onSubmit } },
  ]);
}

function setupBranchMenu(): void {
  const btn = $("#branch-btn");
  const menu = $("#branch-menu");
  const close = () => {
    menu.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.classList.contains("hidden")) buildBranchMenu(menu, close);
    const nowHidden = menu.classList.toggle("hidden");
    btn.setAttribute("aria-expanded", String(!nowHidden));
  });
  document.addEventListener("click", (e) => {
    if (!$("#branch-wrap").contains(e.target as Node)) close();
  });
}

function buildBranchMenu(menu: HTMLElement, close: () => void): void {
  clear(menu);

  if (state.refs.branches.length === 0) {
    menu.append(el("div", { class: "menu-item", text: "No branches" }));
  }
  for (const b of state.refs.branches) {
    const item = el("button", {
      class: `menu-item${b.is_head ? " head" : ""}`,
      text: b.is_head ? `● ${b.name}` : b.name,
    });
    item.addEventListener("click", () => {
      close();
      void checkoutBranchAction(b);
    });
    menu.append(item);
  }

  menu.append(el("div", { class: "menu-sep" }));
  const input = el("input", {
    placeholder: "New branch name",
    spellcheck: "false",
  }) as HTMLInputElement;
  const create = el("button", { class: "btn small", text: "Create" });
  const submit = () => {
    const name = input.value.trim();
    if (!name) return;
    close();
    void createBranchAction(name);
  };
  create.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  menu.append(el("div", { class: "menu-newbranch" }, [input, create]));
  requestAnimationFrame(() => input.focus());
}

// The Pull caret's dropdown: pick a pull method to run once, or hover a row to
// set it as the plain Pull button's default (GitKraken-style).
function setupPullMenu(): void {
  const btn = $("#pull-caret-btn");
  const menu = $("#pull-menu");
  const close = () => {
    menu.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    buildPullMenu(menu, close);
    const nowHidden = menu.classList.toggle("hidden");
    btn.setAttribute("aria-expanded", String(!nowHidden));
  });
  document.addEventListener("click", (e) => {
    if (!$("#pull-wrap").contains(e.target as Node)) close();
  });
}

function buildPullMenu(menu: HTMLElement, close: () => void): void {
  clear(menu);
  const current = loadPullDefault();
  for (const mode of PULL_DEFAULTS) {
    const isDefault = mode === current;
    const row = el("div", { class: `pull-item${isDefault ? " default" : ""}`, role: "menuitemradio" });
    const setDefault = el("button", { class: "pull-set-default", text: "Set as default" });
    setDefault.addEventListener("click", (e) => {
      e.stopPropagation();
      savePullDefault(mode);
      buildPullMenu(menu, close); // refresh radios without closing
    });
    row.append(
      el("span", { class: "pull-radio" }),
      el("span", { class: "pull-label", text: PULL_DEFAULT_LABEL[mode] }),
      ...(isDefault ? [] : [setDefault]),
    );
    row.addEventListener("click", () => {
      close();
      void runPullMethod(mode);
    });
    menu.append(row);
  }
}

// The embedded terminal ran a command (Enter pressed); refresh anything that a
// commit/checkout/stash would have changed.
function onTerminalCommand(): void {
  if (!state.repoPath) return;
  void loadSidebar();
  if (state.view === "history") void refreshHistory();
  else if (state.view === "changes") void loadChanges();
}

function toggleTerminal(): void {
  const panel = $("#terminal-panel");
  const hidden = panel.classList.toggle("hidden");
  // The divider only makes sense while the panel it resizes is on screen.
  $("#terminal-divider").classList.toggle("hidden", hidden);
  if (hidden) return;

  if (!terminal) terminal = setupTerminal($("#terminal-host"), onTerminalCommand);
  terminal.setCwd(state.repoPath || ".");
  renderTerminalCwd();
  requestAnimationFrame(() => {
    terminal?.fit();
    // Opening the terminal means wanting to type in it; without this you have to
    // click into it first.
    terminal?.focus();
  });
}

// Show which directory the shell is in — the terminal follows the active repo.
//
// Shortened to the last two segments rather than clipped with CSS: `direction:
// rtl` keeps the useful tail visible but reorders neutral characters, which
// renders "/Users/you/code/app" as "Users/you/code/app/" — the leading slash
// jumps to the end. The full path stays in the tooltip.
function renderTerminalCwd(): void {
  const slot = $("#terminal-cwd");
  const path = state.repoPath || "";
  slot.textContent = shortenPath(path);
  slot.title = path || "Working directory";
}

function shortenPath(path: string): string {
  if (!path) return "";
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

// Drag the divider above the terminal to resize it; the panel grows upward, so
// dragging up makes it taller.
function setupTerminalResizer(): void {
  const divider = $("#terminal-divider");
  const app = $("#app");
  const MIN = 80;
  // Leave the rest of the window usable no matter how far the drag goes.
  const MAX_FRACTION = 0.8;
  let dragging = false;

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const rect = app.getBoundingClientRect();
    // A collapsed or minimised window measures zero, and clamping against that
    // would snap the panel to its minimum and lose the user's chosen height.
    if (rect.height <= 0) return;
    // The status bar sits below the terminal, so measure from the panel's own
    // bottom rather than the window's.
    const bottom = $("#terminal-panel").getBoundingClientRect().bottom;
    const max = rect.height * MAX_FRACTION;
    const height = Math.max(MIN, Math.min(max, bottom - e.clientY));
    app.style.setProperty("--term-h", `${height}px`);
    terminal?.fit();
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove("dragging");
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    terminal?.fit();
  };

  divider.addEventListener("mousedown", (e) => {
    dragging = true;
    divider.classList.add("dragging");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    e.preventDefault();
  });
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", stop);
}

// Drag the divider to resize the log pane; the detail pane below fills the rest.
function setupPaneResizer(): void {
  const view = $("#history-view");
  const divider = $("#pane-divider");
  const MIN_LOG = 160;
  const MIN_DETAIL = 200;
  let dragging = false;

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const rect = view.getBoundingClientRect();
    const max = rect.height - MIN_DETAIL - 6;
    const height = Math.max(MIN_LOG, Math.min(max, e.clientY - rect.top));
    view.style.setProperty("--log-h", `${height}px`);
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove("dragging");
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  };

  divider.addEventListener("mousedown", (e) => {
    dragging = true;
    divider.classList.add("dragging");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    e.preventDefault();
  });
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", stop);
}

// Drag the sidebar divider to resize the sidebar; the main panel fills the rest.
function setupSidebarResizer(): void {
  const content = $(".content");
  const divider = $("#sidebar-divider");
  const MIN = 180;
  const MAX = 480;
  let dragging = false;

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const rect = content.getBoundingClientRect();
    const width = Math.max(MIN, Math.min(MAX, e.clientX - rect.left));
    content.style.setProperty("--sidebar-w", `${width}px`);
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove("dragging");
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  };

  divider.addEventListener("mousedown", (e) => {
    dragging = true;
    divider.classList.add("dragging");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  });
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", stop);
}

// The settings gear opens a small menu; "Git Config" jumps to the config view.
function setupSettingsMenu(): void {
  const btn = $("#settings-btn");
  const menu = $("#settings-menu");
  const close = () => {
    menu.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const nowHidden = menu.classList.toggle("hidden");
    btn.setAttribute("aria-expanded", String(!nowHidden));
  });
  menu.querySelector('[data-action="git-config"]')?.addEventListener("click", () => {
    close();
    setConfigTab("git");
    showView("config");
  });
  menu.querySelector('[data-action="dotfiles"]')?.addEventListener("click", () => {
    close();
    setConfigTab("dotfiles");
    showView("config");
  });
  for (const choice of menu.querySelectorAll<HTMLElement>("[data-theme-choice]")) {
    choice.addEventListener("click", () => {
      applyTheme(choice.dataset.themeChoice as ThemeChoice);
      updateThemeMenu();
      close();
    });
  }
  updateThemeMenu();
  document.addEventListener("click", (e) => {
    if (!$("#settings").contains(e.target as Node)) close();
  });
}

function wireUi(): void {
  $("#open-btn").addEventListener("click", () => {
    const path = $<HTMLInputElement>("#repo-input").value.trim();
    if (path) void loadRepo(path);
  });
  $("#browse-btn").addEventListener("click", async () => {
    const path = await browseForRepo();
    if (path) void loadRepo(path);
    else if (!isTauri()) setStatus("The folder picker is only available in the desktop app.");
  });
  $<HTMLInputElement>("#repo-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#open-btn").click();
  });
  for (const tab of document.querySelectorAll<HTMLElement>(".tab")) {
    tab.addEventListener("click", () => showView((tab.dataset.tab as View) ?? "history"));
  }
  $("#undo-btn").addEventListener("click", () => void undoAction());
  $("#redo-btn").addEventListener("click", () => void redoAction());
  $("#pull-btn").addEventListener("click", () => void runPullDefault());
  setupPullMenu();
  updatePullButtonTitle();
  $("#push-btn").addEventListener("click", () => void pushAction());
  $("#stash-btn").addEventListener("click", () => void stashAction());
  $("#pop-btn").addEventListener("click", () => void popAction());
  $("#refresh-btn").addEventListener("click", () => void refreshAllAction());
  // Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y = redo. Ignored while
  // typing so the native text-editing undo (commit message, conflict editor)
  // still works.
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    e.preventDefault();
    if (key === "y" || e.shiftKey) void redoAction();
    else void undoAction();
  });
  setupBranchMenu();
  $("#quick-launch-btn").addEventListener("click", openQuickLaunch);
  // Cmd/Ctrl+K opens Quick Launch. Deliberately live while typing in an input
  // too — the point of a palette is that it's always one keystroke away — but
  // not inside the embedded terminal or the conflict editor, where the key
  // belongs to what's focused.
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
    // `e.target` is only an Element when something focusable has focus; with
    // focus on the document itself there is nothing to defer to.
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (t?.isContentEditable || t?.closest("#terminal-host")) return;
    e.preventDefault();
    openQuickLaunch();
  });
  $("#terminal-toggle").addEventListener("click", toggleTerminal);
  $("#terminal-close").addEventListener("click", toggleTerminal);
  $("#terminal-clear").addEventListener("click", () => {
    terminal?.clear();
    terminal?.focus();
  });
  setupTerminalResizer();
  // On the "system" setting nothing calls applyTheme when the OS flips, so the
  // terminal would keep the old palette.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (currentTheme() === "system") terminal?.syncTheme();
  });
  window.addEventListener("resize", () => terminal?.fit());
  setupPaneResizer();
  setupSidebarResizer();
  setupSettingsMenu();
  setupExternalChangeRefresh();
  setupLogKeyboardNav();
  setupFetchAgeIndicator();
  setupBranchToggle();
  setupLogSearch();
  $("#config-seg-git").addEventListener("click", () => {
    if (configTab === "git") return;
    setConfigTab("git");
    void refreshConfig();
  });
  $("#config-seg-dotfiles").addEventListener("click", () => {
    if (configTab === "dotfiles") return;
    setConfigTab("dotfiles");
    void refreshConfig();
  });
}

// Live commit search: debounced so typing doesn't fire a query per keystroke;
// Escape clears it and returns to the normal paged log.
function setupLogSearch(): void {
  const input = $<HTMLInputElement>("#log-search");
  let timer: number | undefined;
  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void updateLogView(), 150);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) {
      input.value = "";
      void updateLogView();
    }
  });
}

// Wire the All-branches / Current segmented toggle above the log. Switching
// reloads the history from the new walk.
function setupBranchToggle(): void {
  const all = $("#branches-all");
  const current = $("#branches-current");
  // Reflect the persisted choice (already loaded into state) in the buttons.
  all.classList.toggle("active", state.allBranches);
  current.classList.toggle("active", !state.allBranches);
  const set = (allBranches: boolean) => {
    if (state.allBranches === allBranches) return;
    state.allBranches = allBranches;
    saveAllBranches(allBranches);
    all.classList.toggle("active", allBranches);
    current.classList.toggle("active", !allBranches);
    void refreshHistory();
  };
  all.addEventListener("click", () => set(true));
  current.addEventListener("click", () => set(false));
}

async function init(): Promise<void> {
  applyTheme(currentTheme());
  state.allBranches = loadAllBranches(); // before wireUi so the toggle reflects it
  wireUi();
  detailView = setupDetail($("#detail-pane"), {
    onSelectCommit: (id) => void jumpToCommit(id, id.slice(0, 10)),
    refsAt,
    fetchTree: fetchCommitTree,
    fetchBlame,
    fetchFileHistory,
    initialTab: loadDetailTab(),
    onTabChange: saveDetailTab,
  });
  changesView = setupChanges($("#changes-pane"), {
    fetchStatus: fetchStatusSummary,
    fetchFileDiff,
    stage,
    unstage,
    stageAll,
    unstageAll,
    stageHunk,
    unstageHunk,
    discardHunk,
    discardFiles,
    stashFiles,
    saveFilesPatch,
    addToGitignore,
    revealPath,
    openInEditor,
    repoRoot: () => state.repoPath || null,
    confirm: confirmDialog,
    fetchHead: async () => {
      try {
        return await fetchCommitDetail("HEAD");
      } catch {
        return null;
      }
    },
    commit: commitChanges,
    // Staging doesn't change refs or history, so just update the badge — no ref
    // walk or log rebuild (that's what made each stage/unstage feel slow).
    onChanged: (count) => {
      // A snapshot-driven refresh already set this and repainted; re-rendering
      // the whole ref tree again for an unchanged count is pure waste.
      if (state.localChanges === count) return;
      state.localChanges = count;
      renderSidebarNow();
    },
    onCommitted: () => {
      void loadSidebar();
      void refreshHistory();
    },
    setStatus,
    reportDone,
    reportError: opFailed,
  });
  conflictView = setupConflict($("#conflict-pane"), {
    fetchStatus: conflictStatus,
    fetchSides: conflictSides,
    resolve: resolveConflict,
    resolveSide: resolveConflictSide,
    openInEditor,
    abort: abortConflict,
    finish: finishConflict,
    confirm: confirmDialog,
    setStatus,
    reportDone,
    reportError: opFailed,
    onDone: async (msg, aborted) => {
      // An abort mid-batch cancels the rest — resolving that one commit's
      // conflict clearly wasn't wanted, so continuing to apply the remaining
      // queued commits without asking would be surprising.
      if (aborted) pendingCherryPicks = [];
      showView("history");
      try {
        await Promise.all([refreshHistory(), loadSidebar()]);
        reportDone(msg.trim() || "Done.");
      } catch (err) {
        // Never leave a silently blank pane — surface what went wrong.
        opFailed("Finished, but refreshing the view failed", err);
        return;
      }
      if (!aborted && pendingCherryPicks.length) await runNextCherryPick();
    },
  });
  if (isTauri()) {
    if (!(await restoreWorkspace())) {
      setStatus("Enter a repository path and press Open.");
      detailView?.showEmpty();
      renderSidebarNow();
    }
  } else {
    applyWorkspace(await listRepos());
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    setStatus("Preview mode (mock data). Open the desktop app for a real repo.");
  }
}

void init();
