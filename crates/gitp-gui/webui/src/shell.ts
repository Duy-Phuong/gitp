// The app shell: the open repository tabs, which view is on screen, the
// history log and its paging, the sidebar, the rebase / conflict banners — and
// refreshing all of it from the backend.
//
// Every action module builds on this one. What a right-click (or a branch
// double-click) does is plugged in by main.ts through setRefActions, so that
// this module never imports the actions back.

import {
  activateRepo,
  closeRepo,
  moveRepo,
  confirmDialog,
  fetchAll,
  fetchCommitDetail,
  fetchLogPage,
  undoState,
  historyFingerprint,
  logIndexOf,
  searchLog,
  fetchRebaseStatus,
  openRepo,
  rebaseAbort,
  rebaseContinue,
  rebaseSkip,
  conflictStatus,
  abortConflict,
  workspaceSnapshot,
  bisectMark,
  bisectReset,
  listWorktrees,
  listSubmodules,
  listRemotes,
} from "./api";
import { ensureAvatars } from "./avatar";
import { clear, el, $ } from "./dom";
import { logRowTop, renderLog, setBisectMarks, setStashNodes, setWipRow } from "./views/log";
import { bisectBannerText } from "./bisect-text";
import { closeCommitMenu } from "./views/commit-menu";
import { showContextMenu, showPrompt } from "./views/context-menu";
import { tabDragHandle } from "./views/tab-drag";
import { renderSidebar, type SidebarView, type SidebarCallbacks } from "./views/sidebar";
import type { BisectMark, CommitRow, ConflictStatus, LogPage, LogScope, ReflogEntry, StashRef, Workspace } from "./types";
import { EMPTY_REFS, PAGE_SIZE, state, ui, type View } from "./app-state";
import { opFailed, readFailed, reportDone, setStatus } from "./report";
import { markRemoteFetched, remoteFetchedAt, renderFetchAge } from "./fetch-age";
import {
  loadFavoriteRepos,
  loadGraphPrefs,
  loadTabAliases,
  loadWorkspace,
  rememberRecentRepo,
  saveGraphPrefs,
  saveTabAlias,
  saveWorkspace,
  toggleFavoriteRepo,
  type GraphPrefs,
} from "./prefs";
import { hiddenRefCount, refFilter, withHidden } from "./ref-visibility";
import { rebuildCommitRefs, refLabelsAt } from "./commit-refs";
import { refreshConfig } from "./config-panel";
import { refreshActionButtons } from "./toolbar";
import { cancelComparison, compareSelectedCommits, showComparison } from "./compare";
import { cycledTabIndex } from "./tab-order";

// What a ref or commit row does when it's right-clicked (or, for a branch,
// double-clicked) — set once by main.ts at startup; see the module comment.
interface RefActions {
  checkoutBranchAction: SidebarCallbacks["onBranchCheckout"];
  onBranchMenu: SidebarCallbacks["onBranchMenu"];
  onBranchBulkMenu: SidebarCallbacks["onBranchBulkMenu"];
  onStashMenu: SidebarCallbacks["onStashMenu"];
  onRemoteMenu: SidebarCallbacks["onRemoteMenu"];
  onAddRemote: SidebarCallbacks["onAddRemote"];
  onRemotesMenu: SidebarCallbacks["onRemotesMenu"];
  onRemoteFolderMenu: SidebarCallbacks["onRemoteFolderMenu"];
  onTagMenu: SidebarCallbacks["onTagMenu"];
  onCommitContextMenu: (row: CommitRow, x: number, y: number) => void;
  onWorktreeMenu: SidebarCallbacks["onWorktreeMenu"];
  onSubmoduleOpen: SidebarCallbacks["onSubmoduleOpen"];
  onSubmoduleMenu: SidebarCallbacks["onSubmoduleMenu"];
  onAddSubmodule: SidebarCallbacks["onAddSubmodule"];
  // The detached-HEAD banner's "Create Branch Here…".
  createBranchAt: (name: string, rev: string) => void;
  onSectionMenu: SidebarCallbacks["onSectionMenu"];
}

let refActions: RefActions;

export function setRefActions(actions: RefActions): void {
  refActions = actions;
}

// Open a repo as a new tab (or switch to it if already open), then show its log.
export async function loadRepo(path: string): Promise<void> {
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
export async function restoreWorkspace(): Promise<boolean> {
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
export function applyWorkspace(ws: Workspace): void {
  state.repos = ws.repos;
  const active = ws.active != null ? ws.repos[ws.active] : undefined;
  const changed = (active?.path ?? "") !== state.repoPath;
  state.repoPath = active?.path ?? "";
  if (changed) {
    resetRepoViews();
    state.graph = loadGraphPrefs(state.repoPath);
  }
  rememberRecentRepo(state.repoPath);
  renderRepoTabs();
  $("#action-bar").classList.toggle("hidden", state.repos.length === 0);
  $<HTMLInputElement>("#repo-input").value = state.repoPath;
  ui.terminal?.showRepo(state.repoPath);
  saveWorkspace();
}

// Forget every piece of per-repo view state when the active repo changes: the
// staging view's selection/commit message/Amend, the resolver's partial
// choices, a paused cherry-pick batch or plan, and the conflict-message prefill. The
// views are singletons, so without this repo A's state leaks into repo B —
// up to amending B's HEAD with A's message.
function resetRepoViews(): void {
  ui.changesView?.reset();
  ui.conflictView?.reset();
  ui.reflogView?.reset();
  ui.activityView?.reset();
  ui.pendingCherryPicks = [];
  ui.pickPlanRepo = "";
  conflictPrefill = null;
}

function renderRepoTabs(): void {
  const host = $("#repo-tabs");
  host.classList.toggle("hidden", state.repos.length === 0);
  clear(host);
  const favorites = loadFavoriteRepos();
  const aliases = loadTabAliases();
  for (const repo of state.repos) {
    const active = repo.path === state.repoPath;
    const alias = aliases[repo.path];
    const tab = el("div", { class: `repo-tab${active ? " active" : ""}`, title: repo.path }, [
      alias ?? repo.name,
    ]);
    if (favorites.includes(repo.path)) {
      tab.prepend(el("span", { class: "repo-tab-star", title: "Favorite", "aria-label": "Favorite" }, ["★"]));
    }
    tab.addEventListener("click", () => void switchRepo(repo.path));
    tabDragHandle(tab, (to) => void moveRepoTab(repo.path, to));
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const starred = favorites.includes(repo.path);
      showContextMenu(e.clientX, e.clientY, [
        { label: starred ? "Remove from Favorites" : "Add to Favorites", run: () => toggleFavorite(repo.path) },
        {
          label: "Rename Tab…",
          prompt: { placeholder: "Tab name", value: alias ?? repo.name, onSubmit: (name) => renameTab(repo.path, name) },
        },
        ...(alias ? [{ label: "Reset Name", run: () => renameTab(repo.path, null) }] : []),
        { separator: true },
        { label: "Close", run: () => void closeRepoTab(repo.path) },
      ]);
    });
    const close = el("span", { class: "repo-tab-close", title: "Close" }, ["×"]);
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      void closeRepoTab(repo.path);
    });
    tab.append(close);
    host.append(tab);
  }
}

// Star or unstar `path` (see loadFavoriteRepos) and show it on its tab.
export function toggleFavorite(path: string): void {
  const starred = toggleFavoriteRepo(path);
  renderRepoTabs();
  const name = state.repos.find((r) => r.path === path)?.name ?? path;
  setStatus(starred ? `Added ${name} to Favorites.` : `Removed ${name} from Favorites.`);
}

// Show `name` on the tab for `path` instead of its folder, or (null, or the
// folder name itself) go back to the folder name.
function renameTab(path: string, name: string | null): void {
  const folder = state.repos.find((r) => r.path === path)?.name;
  saveTabAlias(path, name === folder ? null : name);
  renderRepoTabs();
}

// Drop the tab for `path` at position `to` (see droppedTabIndex). The new order
// is saved with the workspace, so tabs reopen in it.
async function moveRepoTab(path: string, to: number): Promise<void> {
  try {
    applyWorkspace(await moveRepo(path, to));
  } catch (err) {
    readFailed("Failed to move tab", err);
  }
}

// Ctrl+Tab / Ctrl+Shift+Tab: the next or previous tab, wrapping around.
export function cycleRepoTab(step: 1 | -1): void {
  const n = state.repos.length;
  if (n < 2) return;
  const i = state.repos.findIndex((r) => r.path === state.repoPath);
  void switchRepo(state.repos[cycledTabIndex(n, Math.max(i, 0), step)].path);
}

export async function switchRepo(path: string): Promise<void> {
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

export async function closeRepoTab(path: string): Promise<void> {
  const wasActive = path === state.repoPath;
  try {
    applyWorkspace(await closeRepo(path));
    ui.terminal?.closeRepo(path);
    if (state.repos.length === 0) {
      state.rows = [];
      rowsRepoPath = "";
      state.total = 0;
      state.headId = null;
      state.selectedId = null;
      state.refs = EMPTY_REFS;
      state.worktrees = [];
      state.submodules = [];
      state.localChanges = 0;
      // No repo: nothing is in progress and nothing can be undone. Left as
      // they were, the banners stay up with buttons that hit "no active repo".
      state.rebase = null;
      state.conflict = null;
      state.bisect = null;
      setBisectMarks(null);
      setWipRow(0, null);
      ui.undoLabels = { undo: null, redo: null };
      renderRebaseBanner();
      renderConflictBanner();
      renderBisectBanner();
      renderDetachedBanner();
      refreshActionButtons();
      renderTerminalCwd();
      ui.logView = renderLog($("#log-pane"), [], null, selectCommit, loadMoreCommits, undefined, undefined, state.commitSelection, onCommitMultiSelect);
      shownDetailId = null;
      ui.detailView?.showEmpty();
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

let loadingMore = false;

// Which repo `state.rows` was loaded from — history from a previous tab must
// never be mistaken for the active repo's (see historyUnchanged).
let rowsRepoPath = "";
// …and with which scope: a different pin lays the same commits out anew.
let rowsScope = "";

// What the log shows for the active repo: the All/Current toggle plus the
// repo's graph settings.
export function logScope(): LogScope {
  const { pinned, hidden, solo } = state.graph;
  return { all_branches: state.allBranches, pinned, hidden, solo };
}

// Adopt and remember new graph settings for the active repo, then show the
// graph they describe.
export function updateGraphPrefs(next: GraphPrefs): void {
  state.graph = next;
  saveGraphPrefs(state.repoPath, next);
  renderSidebarNow();
  void refreshHistory({ keepSelection: true });
}

// The commit id whose detail is currently rendered in detailView. Commits are
// immutable, so re-selecting the same id (e.g. switching back to History)
// never needs to re-fetch and re-diff it — see selectCommit.
let shownDetailId: string | null = null;

// `keepSelection`: preserve the current selection if it's still in the
// reloaded rows, instead of jumping to the newest commit. Mutating actions
// (commit/checkout/merge/reset/…) want the default jump-to-HEAD behavior;
// passive/background refreshes (tab switch, branch click) don't — they'd
// otherwise yank the view away from whatever the user just clicked.
// The fingerprint history was last loaded at, keyed by repo so switching tabs
// can't match against the previous repo's value.
let lastHistoryFingerprint = "";

export async function refreshHistory(opts: { keepSelection?: boolean } = {}): Promise<void> {
  // A passive refresh (window focus, an idle poll, an action that touched only
  // the working tree) almost never has new history to show, but finding that
  // out used to mean pulling a full page — ~264 KB of JSON serialized, sent
  // over IPC and parsed — and then discarding it in historyUnchanged below.
  // Ask the backend for the same fingerprint it uses on its own log cache
  // instead: a few bytes, and it settles the question.
  const repoPath = state.repoPath;
  const scope = logScope();
  const scopeKey = JSON.stringify(scope);
  const fingerprint = `${repoPath}:${scopeKey}:${await historyFingerprint()}`;
  if (repoPath !== state.repoPath) return; // the tab changed under us; its own refresh takes over
  if (opts.keepSelection && fingerprint === lastHistoryFingerprint && state.rows.length) return;
  lastHistoryFingerprint = fingerprint;

  // Nothing loaded for this repo yet (first open, or a tab whose log was never
  // fetched): show row-shaped placeholders rather than a blank pane while the
  // first page comes in.
  if (!state.rows.length || rowsRepoPath !== repoPath) renderLogSkeleton($("#log-pane"));
  const page = await fetchLogPage(0, PAGE_SIZE, scope);
  if (repoPath !== state.repoPath) return;
  // A passive refresh that found history unchanged: keep the rows we already
  // have — including every page loaded by scrolling — and skip the re-render.
  // `state.rows` keeps its identity, so the log's graph-layout cache stays
  // valid too (see getLayout in log.ts), making a tab switch nearly free.
  if (opts.keepSelection && historyUnchanged(page, scopeKey)) return;
  state.rows = page.rows;
  rowsRepoPath = state.repoPath;
  rowsScope = scopeKey;
  state.total = page.total;
  state.headId = page.head;
  setWipRow(state.localChanges, state.headId);
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
  // The open Reflog owns the detail pane (an undo refreshes history under it);
  // showView puts the selection back there on the way out.
  if (state.view === "reflog") return;
  // A comparison of refs stays up across a refresh, re-run in case they moved
  // (two Cmd-clicked commits are re-compared by selectCommit itself).
  const cmp = keep && state.commitSelection.size !== 2 ? ui.detailView?.comparison() : null;
  if (cmp && (await showComparison(cmp.base.rev, cmp.head.rev, cmp.three_dot))) return;
  if (state.selectedId) await selectCommit(state.selectedId);
  else {
    shownDetailId = null;
    ui.detailView?.showEmpty();
  }
}

function renderLogSkeleton(pane: HTMLElement): void {
  clear(pane);
  const box = el("div", { class: "log-skeleton", "aria-hidden": "true" });
  const widths = [62, 48, 71, 55, 66, 44, 58, 69, 51, 63, 47, 60];
  for (const w of widths) {
    const bar = el("div", { class: "log-skeleton-bar" });
    bar.style.width = `${w}%`;
    box.append(el("div", { class: "log-skeleton-row" }, [el("div", { class: "log-skeleton-dot" }), bar]));
  }
  pane.append(box);
}

// Whether the freshly fetched first page matches what we already have loaded —
// same repo, same total, same commits in the same order. Comparing only the
// first page is enough: the log is append-only below it, so an unchanged head
// plus an unchanged total means an unchanged log.
function historyUnchanged(page: LogPage, scopeKey: string): boolean {
  if (rowsRepoPath !== state.repoPath || rowsScope !== scopeKey || page.total !== state.total) return false;
  if (state.rows.length < page.rows.length) return false;
  return page.rows.every((r, i) => state.rows[i]?.id === r.id);
}

// The trimmed commit-search query (empty when the box is empty or absent).
function logSearchQuery(): string {
  const input = document.querySelector<HTMLInputElement>("#log-search");
  return input ? input.value.trim() : "";
}

// Bumped by every updateLogView, so a search that resolves late — `path:` and
// `content:` run git over the whole history, which can take seconds — can tell
// a newer search (or a return to the plain log) has replaced it, and drop out.
let logViewSeq = 0;
// Whether the status line is showing a "Searching commits…" spinner that the
// search it belongs to hasn't replaced yet.
let searchStatusShown = false;

// The "N commits" next to the search box; blank when no search is showing.
function showSearchCount(count: number | null): void {
  const slot = document.querySelector("#log-search-count");
  if (slot) slot.textContent = count === null ? "" : `${count} commit${count === 1 ? "" : "s"}`;
}

// Render the log pane: the paged history normally, or live search results when
// the search box has text — GitKraken-style commit search over the full graph
// (message, author or SHA, narrowed by author: / path: / content: / after: /
// before: terms; see LogSearch in gitp-core).
export async function updateLogView(): Promise<void> {
  const seq = ++logViewSeq;
  const pane = $("#log-pane");
  const query = logSearchQuery();
  if (!query) {
    showSearchCount(null);
    if (searchStatusShown) setStatus("Search cleared.");
    searchStatusShown = false;
    ui.logView = renderLog(pane, state.rows, state.selectedId, selectCommit, loadMoreCommits, refLabelsAt, refActions.onCommitContextMenu, state.commitSelection, onCommitMultiSelect);
    // An empty log (e.g. right after an abort that left an odd state) should read
    // as such rather than as a blank pane.
    if (!state.rows.length) pane.append(el("div", { class: "detail-empty", text: "No commits to show." }));
    return;
  }
  // Only a search that's still going after a moment says so — a status flash
  // on every keystroke of a quick message search would be noise.
  const slow = window.setTimeout(() => {
    if (seq !== logViewSeq) return;
    setStatus("Searching commits…");
    searchStatusShown = true;
  }, 300);
  let results: CommitRow[];
  try {
    results = await searchLog(query, logScope());
  } catch (err) {
    if (seq === logViewSeq) {
      searchStatusShown = false;
      readFailed("Search failed", err);
    }
    return;
  } finally {
    window.clearTimeout(slow);
  }
  // Superseded by a newer search, or the box changed and one is on its way.
  if (seq !== logViewSeq || logSearchQuery() !== query) return;
  await ensureAvatars(results.map((r) => r.author_email));
  if (seq !== logViewSeq) return;
  // No onNeedMore: search returns the complete match set, not a page. No WIP
  // row either: it isn't a search result.
  ui.logView = renderLog(pane, results, state.selectedId, selectCommit, undefined, refLabelsAt, refActions.onCommitContextMenu, state.commitSelection, onCommitMultiSelect, false);
  if (!results.length) {
    pane.append(el("div", { class: "detail-empty", text: `No commits match “${query}”.` }));
  }
  showSearchCount(results.length);
  searchStatusShown = false;
  setStatus(`${results.length} commit${results.length === 1 ? "" : "s"} match “${query}”.`);
}

// Append the next page when the user scrolls near the end of what's loaded.
export async function loadMoreCommits(): Promise<void> {
  if (loadingMore || state.rows.length >= state.total) return;
  loadingMore = true;
  const repoPath = state.repoPath;
  try {
    const page = await fetchLogPage(state.rows.length, PAGE_SIZE, logScope());
    if (repoPath !== state.repoPath) return; // a page of the previous repo
    state.rows = state.rows.concat(page.rows);
    rowsRepoPath = state.repoPath;
    state.total = page.total;
    state.headId = page.head;
    const host = $("#log-pane");
    const keepScroll = host.scrollTop;
    await ensureAvatars(state.rows.map((r) => r.author_email));
    rebuildCommitRefs();
    ui.logView = renderLog(host, state.rows, state.selectedId, selectCommit, loadMoreCommits, refLabelsAt, refActions.onCommitContextMenu, state.commitSelection, onCommitMultiSelect);
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
export function onCommitMultiSelect(ids: Set<string>): void {
  state.commitSelection = ids;
}

export async function selectCommit(id: string): Promise<void> {
  // The log view updates its own highlight on click; here we only load detail.
  state.selectedId = id;
  // Exactly two commits Cmd-clicked: the pane compares them instead.
  if (state.commitSelection.size === 2) {
    shownDetailId = null;
    await compareSelectedCommits();
    return;
  }
  // Any single selection ends a comparison, on screen or still in flight.
  cancelComparison();
  if (ui.detailView?.comparison()) shownDetailId = null;
  // Commits are immutable — re-showing one already on screen (e.g. switching
  // back to History with the same selection) needs no re-fetch/re-diff.
  if (id === shownDetailId) return;
  try {
    const detail = await fetchCommitDetail(id);
    // The selection moved on while this was in flight (easy to do by holding an
    // arrow key) — a later request owns the pane now.
    if (state.selectedId !== id) return;
    shownDetailId = id;
    ui.detailView?.show(detail);
  } catch (err) {
    readFailed("Failed to load commit", err);
  }
}

// Drop a commit multi-selection and repaint the log without it, keeping the
// scroll position.
export async function clearCommitSelection(): Promise<void> {
  if (!state.commitSelection.size) return;
  state.commitSelection = new Set();
  const pane = $("#log-pane");
  const scroll = pane.scrollTop;
  await updateLogView();
  pane.scrollTop = scroll;
}

// Back from a comparison (Esc, or its Close button) to the selected commit,
// dropping the two-commit selection if that's what it compared.
export async function leaveComparison(): Promise<void> {
  await clearCommitSelection();
  if (state.selectedId) await selectCommit(state.selectedId);
  else {
    cancelComparison();
    shownDetailId = null;
    ui.detailView?.showEmpty();
  }
}

// Throttle for the background remote fetch triggered by navigation (below).
// A real fetch is a network round trip (it never prompts, though), so it
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
// interrupt navigation with an error dialog, only a status-bar note; nor with a
// credential prompt, so it runs as a background fetch, which never asks.
async function refreshRemoteQuietly(throttleMs = REMOTE_REFRESH_THROTTLE_MS): Promise<void> {
  if (!state.repoPath || ui.actionsBusy) return;
  const last = remoteFetchedAt.get(state.repoPath);
  if (last !== undefined && Date.now() - last < throttleMs) return;
  // Recorded before the round trip, so a slow or failing fetch can't have every
  // navigation start another one.
  markRemoteFetched();
  try {
    await fetchAll({ background: true });
    await loadSidebar();
  } catch (err) {
    readFailed("Background fetch failed", err);
  }
}

let autoFetchTimer: number | undefined;

// The "Auto-fetch" setting: the same quiet fetch on a timer, for whichever repo
// is active when it fires. A tick is skipped while gitp runs an operation of
// its own or the window is hidden (nobody is looking, and a laptop lid closed
// overnight shouldn't fetch every minute), and when a fetch — navigation,
// Reload — already ran within half an interval. Half, not the full interval,
// because timer drift would otherwise skip every other tick. 0 turns it off.
export function startAutoFetch(minutes: number): void {
  window.clearInterval(autoFetchTimer);
  autoFetchTimer = undefined;
  if (minutes <= 0) return;
  const every = minutes * 60_000;
  autoFetchTimer = window.setInterval(() => {
    if (document.hidden || operationInFlight()) return;
    void refreshRemoteQuietly(every / 2);
  }, every);
}

// Whether gitp is running an operation of its own right now.
export function operationInFlight(): boolean {
  return ui.actionsBusy || (ui.changesView?.isBusy() ?? false);
}

// Switch the main panel between history, the reflog, local changes, config
// and the activity log; keeps the topbar tabs and sidebar nav highlight in sync, and loads
// the view's data.
export function showView(view: View, opts: { refreshHistory?: boolean } = {}): void {
  closeCommitMenu();
  state.view = view;
  $("#history-view").classList.toggle("hidden", view !== "history" && view !== "reflog");
  $("#changes-view").classList.toggle("hidden", view !== "changes");
  $("#config-view").classList.toggle("hidden", view !== "config");
  $("#conflict-view").classList.toggle("hidden", view !== "conflict");
  $("#activity-view").classList.toggle("hidden", view !== "activity");
  // The Reflog lists in the log's place and shares History's detail pane.
  $("#log-col").classList.toggle("hidden", view === "reflog");
  $("#reflog-col").classList.toggle("hidden", view !== "reflog");
  for (const el of document.querySelectorAll<HTMLElement>(".tab")) {
    el.classList.toggle("active", el.dataset.tab === view);
  }
  renderSidebarNow();
  renderConflictBanner(); // entering/leaving the resolver toggles the banner
  renderDetachedBanner(); // History only
  if (view === "config") void refreshConfig();
  else if (view === "changes") void loadChanges();
  else if (view === "conflict") void ui.conflictView?.reload();
  else if (view === "reflog") void ui.reflogView?.reload();
  // The Activity view polls only while it's showing.
  if (view === "activity") ui.activityView?.start();
  else ui.activityView?.stop();
  // Back from the Reflog, which borrowed the detail pane: show the selected
  // commit there again.
  if (view === "history" && state.selectedId && shownDetailId !== state.selectedId) void selectCommit(state.selectedId);
  // Entering History or Local Changes — including via a branch click, which
  // routes through here too (see jumpToCommit/checkoutBranchAction) — reloads
  // the graph (keeping whatever's selected) and, throttled, fetches remotes,
  // so switching over always shows current local + remote state without a
  // manual Reload click.
  if (view === "history" && opts.refreshHistory !== false) void refreshHistory({ keepSelection: true });
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
export async function loadSidebar(opts: { abortIfBusy?: boolean } = {}): Promise<void> {
  let marksChanged = false;
  let wipChanged = false;
  let stashesChanged = false;
  try {
    // Worktrees, submodules and remotes are separate, cheap reads; failing one
    // only hides its section (or, for remotes, the never-fetched ones).
    const [snap, worktrees, submodules, remoteList] = await Promise.all([
      workspaceSnapshot(),
      listWorktrees().catch(() => []),
      listSubmodules().catch(() => []),
      listRemotes().catch(() => []),
    ]);
    // A passive refresh must not land a snapshot taken before an operation the
    // user started while it was in flight: that would repaint the pre-op state
    // over an optimistic staging update, and only the operation's own reload
    // would put it back. Dropping the result costs nothing — the operation
    // refreshes when it finishes.
    if (opts.abortIfBusy && operationInFlight()) return;
    state.refs = snap.refs;
    state.worktrees = worktrees;
    state.submodules = submodules;
    state.remoteList = remoteList;
    state.localChanges = snap.local_changes;
    state.rebase = snap.rebase;
    ui.undoLabels = snap.undo;
    // Hand the staging lists straight to Local Changes so it doesn't re-run
    // `git status` for this same refresh.
    ui.changesView?.applyStatus(snap.status);
    renderRebaseBanner();
    applyConflictStatus(snap.conflict);
    state.bisect = snap.bisect;
    marksChanged = setBisectMarks(state.bisect);
    wipChanged = setWipRow(state.localChanges, state.headId);
    stashesChanged = setStashNodes(state.refs.stashes);
    renderBisectBanner();
    renderDetachedBanner();
    // Whatever moved a ref (an action, undo, a terminal command) added a reflog
    // entry the open Reflog should list.
    if (state.view === "reflog") void ui.reflogView?.reload();
  } catch (err) {
    state.refs = EMPTY_REFS;
    readFailed("Failed to load refs", err);
  }
  renderSidebarNow();
  // Refs now known — recompute containment and re-render the open commit + the
  // log so the branch chips appear on every commit.
  ui.detailView?.refresh();
  const chipsChanged = rebuildCommitRefs();
  const needsRepaint = chipsChanged || marksChanged || wipChanged || stashesChanged || lastPaintedRows !== state.rows || lastPaintedSelection !== state.selectedId;
  if (state.view === "history" && state.rows.length && needsRepaint) {
    const pane = $("#log-pane");
    const keep = pane.scrollTop;
    // With a search active the pane shows results, not the paged log — repaint
    // those, or a sidebar refresh would replace them with the full graph.
    if (logSearchQuery()) void updateLogView();
    else ui.logView = renderLog(pane, state.rows, state.selectedId, selectCommit, loadMoreCommits, refLabelsAt, refActions.onCommitContextMenu, state.commitSelection, onCommitMultiSelect);
    pane.scrollTop = keep;
    lastPaintedRows = state.rows;
    lastPaintedSelection = state.selectedId;
  }
}

// The change count moved without a workspace snapshot (Local Changes staged,
// discarded or stashed something): bring the log's WIP row along. Repainted
// even while Local Changes is on screen, so History is current on the way back.
export function refreshWipRow(): void {
  if (!setWipRow(state.localChanges, state.headId) || !state.rows.length || logSearchQuery()) return;
  const pane = $("#log-pane");
  const keep = pane.scrollTop;
  ui.logView = renderLog(pane, state.rows, state.selectedId, selectCommit, loadMoreCommits, refLabelsAt, refActions.onCommitContextMenu, state.commitSelection, onCommitMultiSelect);
  pane.scrollTop = keep;
}

// What the log pane was last painted from, so a refresh that changed neither
// the rows, the selection, nor the ref chips can leave the DOM alone.
let lastPaintedRows: CommitRow[] | null = null;

let lastPaintedSelection: string | null = null;

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
    // Annotating a tag keeps its commit but changes its tooltip.
    r.tags.map((t) => `${t.name}:${t.target}:${t.message === null ? 0 : 1}`).join(","),
    r.stashes.map((st) => `${st.index}:${st.message}`).join(","),
    r.recent.join(","),
    [...state.sbCollapsed].sort().join(","),
    [...state.branchSelection].sort().join(","),
    state.branchSelectionAnchor ?? "",
    [...state.busyRefs].sort().join(","),
    state.worktrees.map((w) => `${w.path}:${w.head}:${w.branch}:${w.is_current}:${w.locked}:${w.lock_reason}:${w.prunable}`).join(","),
    state.submodules.map((m) => `${m.path}:${m.url}:${m.recorded}:${m.checked_out}:${m.state}`).join(","),
    state.remoteList.map((rm) => `${rm.name}:${rm.url}`).join(","),
    state.graph.pinned ?? "",
    state.graph.hidden.join(","),
    state.graph.solo.join(","),
  ].join("|");
}

let lastSidebarSig: string | null = null;

export function renderSidebarNow(): void {
  renderBranchIndicator();
  // The fetch age is per repo, so it has to follow a tab switch, not just the
  // 30s tick.
  renderFetchAge();
  renderTerminalCwd();
  refreshActionButtons();
  renderHiddenRefs();
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
      worktrees: state.worktrees,
      submodules: state.submodules,
      remoteList: state.remoteList,
      pinned: state.graph.pinned,
      visibility: refFilter(state.graph),
    },
    {
      onSelectView: (v: SidebarView) => (v === "reflog" ? showReflog() : showView(v)),
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
      onBranchCheckout: (b) => void refActions.checkoutBranchAction(b),
      onBranchMenu: (b, x, y) => refActions.onBranchMenu(b, x, y),
      onBranchMultiSelect: (names, anchor) => {
        state.branchSelection = names;
        state.branchSelectionAnchor = anchor;
        renderSidebarNow();
      },
      onBranchBulkMenu: (x, y) => refActions.onBranchBulkMenu(x, y),
      onStashClick: (s) => void showStashDetail(s),
      onStashMenu: (s, x, y) => refActions.onStashMenu(s, x, y),
      onRemoteMenu: (name, target, x, y) => refActions.onRemoteMenu(name, target, x, y),
      onAddRemote: () => refActions.onAddRemote(),
      onRemotesMenu: (x, y) => refActions.onRemotesMenu(x, y),
      onRemoteFolderMenu: (remote, x, y) => refActions.onRemoteFolderMenu(remote, x, y),
      onTagMenu: (name, target, x, y) => refActions.onTagMenu(name, target, x, y),
      onWorktreeOpen: (w) => void loadRepo(w.path),
      onWorktreeMenu: (w, x, y) => refActions.onWorktreeMenu(w, x, y),
      onSubmoduleOpen: (sm) => refActions.onSubmoduleOpen(sm),
      onSubmoduleMenu: (sm, x, y) => refActions.onSubmoduleMenu(sm, x, y),
      onToggleHidden: (refname) => updateGraphPrefs(withHidden(state.graph, [refname], !state.graph.hidden.includes(refname))),
      onSectionMenu: (key, x, y) => refActions.onSectionMenu(key, x, y),
      onAddSubmodule: () => refActions.onAddSubmodule(),
    },
  );
}

// "N refs hidden · Show all" above the log while Hide or Solo leaves refs out
// of the graph.
function renderHiddenRefs(): void {
  const slot = $("#log-hidden-refs");
  const n = state.repoPath ? hiddenRefCount(refFilter(state.graph), state.refs) : 0;
  slot.classList.toggle("hidden", n === 0);
  clear(slot);
  if (n === 0) return;
  const showAll = el("button", { text: "Show all" });
  showAll.addEventListener("click", () => updateGraphPrefs({ ...state.graph, hidden: [], solo: [] }));
  slot.append(`${n} ref${n === 1 ? "" : "s"} hidden · `, showAll);
}

// Show which directory the shell is in — the terminal follows the active repo.
//
// Shortened to the last two segments rather than clipped with CSS: `direction:
// rtl` keeps the useful tail visible but reorders neutral characters, which
// renders "/Users/you/code/app" as "Users/you/code/app/" — the leading slash
// jumps to the end. The full path stays in the tooltip.
export function renderTerminalCwd(): void {
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

export async function loadChanges(): Promise<void> {
  try {
    await ui.changesView?.reload();
  } catch (err) {
    readFailed("Failed to load local changes", err);
  }
}

// Single-click a branch/remote/tag: show its tip commit, scrolling the log to it
// if that commit is loaded.
export async function jumpToCommit(target: string, label: string): Promise<void> {
  // Not the usual refresh-on-entry: if history changed, it would replace the
  // rows with page 1 and move the selection to the newest commit — undoing
  // the jump that's about to happen.
  showView("history", { refreshHistory: false });
  state.selectedId = target;
  let idx = state.rows.findIndex((r) => r.id === target);
  // Not on screen yet. The log is paged — only the newest PAGE_SIZE commits are
  // loaded — so on any real repository a tag or an older branch points *below*
  // what's loaded, and clicking one used to leave the graph exactly where it
  // was with nothing selected. Find out how far down it is and load to there.
  if (idx < 0) idx = await loadDownTo(target, label);

  ui.logView = renderLog($("#log-pane"), state.rows, state.selectedId, selectCommit, loadMoreCommits, refLabelsAt, refActions.onCommitContextMenu, state.commitSelection, onCommitMultiSelect);
  if (idx >= 0) {
    const pane = $("#log-pane");
    pane.scrollTop = Math.max(0, logRowTop(idx) - pane.clientHeight / 2);
  }
  await selectCommit(target);
  ui.detailView?.focusCommit();
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
  const repoPath = state.repoPath;
  try {
    const idx = await logIndexOf(target, logScope());
    if (idx == null || repoPath !== state.repoPath) return -1;
    if (idx < state.rows.length) return idx;

    const missing = idx + 1 - state.rows.length;
    setStatus(`Loading ${missing.toLocaleString()} more commits to reach ${label}…`);
    const page = await fetchLogPage(state.rows.length, Math.max(missing, PAGE_SIZE), logScope());
    if (repoPath !== state.repoPath) return -1;
    state.rows = state.rows.concat(page.rows);
    rowsRepoPath = state.repoPath;
    state.total = page.total;
    state.headId = page.head;
    await ensureAvatars(state.rows.map((r) => r.author_email));
    rebuildCommitRefs();
    return state.rows.findIndex((r) => r.id === target);
  } catch (err) {
    readFailed(`Couldn't locate ${label}`, err);
    return -1;
  }
}

// Click a stash: show its diff in the detail view. A stash commit's first
// parent is the base it was taken from, so fetchCommitDetail surfaces exactly
// the stashed changes. Switches to History, where the detail pane lives.
export async function showStashDetail(s: StashRef): Promise<void> {
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
  ui.logView = renderLog($("#log-pane"), state.rows, null, selectCommit, loadMoreCommits, refLabelsAt, refActions.onCommitContextMenu, state.commitSelection, onCommitMultiSelect);
  try {
    ui.detailView?.show(await fetchCommitDetail(`stash@{${s.index}}`));
    setStatus(`Showing stash@{${s.index}} — ${s.message}`);
  } catch (err) {
    readFailed("Failed to load stash", err);
  }
}

// Open the Reflog view on `refname`: HEAD's, or a branch's (`refs/heads/<name>`).
export function showReflog(refname = "HEAD"): void {
  ui.reflogView?.setRef(refname);
  showView("reflog");
}

// The Reflog entry whose commit the detail pane was last asked for, so a slow
// fetch for an earlier one can't overwrite it.
let reflogDetailId: string | null = null;

// Show a Reflog entry's commit in the detail pane. Like a stash, it needn't be
// a row of the log, so selectCommit's cache must not claim the pane.
export async function showReflogDetail(entry: ReflogEntry): Promise<void> {
  shownDetailId = null;
  reflogDetailId = entry.new_id;
  if (entry.summary === null) {
    ui.detailView?.showEmpty();
    setStatus(`${entry.selector}: commit ${entry.short_id} no longer exists — it has been pruned.`);
    return;
  }
  try {
    const detail = await fetchCommitDetail(entry.new_id);
    if (reflogDetailId !== entry.new_id || state.view !== "reflog") return;
    ui.detailView?.show(detail);
  } catch (err) {
    readFailed("Failed to load commit", err);
  }
}

// Re-read just the undo/redo labels. The staging view reloads only the status
// after an operation — a full workspace snapshot costs a `git status` and a ref
// walk — so the Undo button needs telling separately that it now has something
// to offer.
export async function refreshUndoLabels(): Promise<void> {
  try {
    ui.undoLabels = await undoState();
    refreshActionButtons();
  } catch {
    // Not worth surfacing: the buttons simply keep the state they had.
  }
}

// --- Rebase in progress (pause / continue / skip / abort) -------------------

// Refresh the paused-rebase state and (re)paint the banner.
export async function refreshRebaseStatus(): Promise<void> {
  try {
    state.rebase = await fetchRebaseStatus();
  } catch {
    state.rebase = null;
  }
  renderRebaseBanner();
}

// Refresh the conflict session and (re)paint the merge-conflict banner. Use
// this only when no snapshot is at hand (loadSidebar already carries one).
export async function refreshConflictStatus(): Promise<void> {
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
  const hadConflict = state.conflict !== null;
  state.conflict = st && st.kind !== "none" ? st : null;
  renderConflictBanner();
  // Once conflicts are resolved (files staged) a plain commit correctly
  // finishes a merge/cherry-pick/revert, same as the command line — so the
  // pending message should already be sitting in Local Changes, ready to go,
  // whether the user finishes there or comes back to the resolver. Once per
  // session: re-filling on every snapshot would undo the user clearing it.
  if (state.conflict?.message && conflictPrefill?.summary !== state.conflict.summary) {
    const summary = state.conflict.summary;
    const rest = state.conflict.message.startsWith(summary)
      ? state.conflict.message.slice(summary.length)
      : state.conflict.message;
    const body = rest.replace(/^\s+/, "").trimEnd();
    conflictPrefill = { summary, body };
    ui.changesView?.prefillMessage(summary, body);
  }
  // A queued cherry-pick batch belongs to its own cherry-pick session: a
  // different kind of conflict means it was abandoned (e.g. a terminal abort
  // followed by a merge), so the leftovers must not run after that one.
  if (state.conflict && state.conflict.kind !== "cherry-pick") {
    ui.pendingCherryPicks = [];
    ui.pickPlanRepo = "";
  }
  if (hadConflict && !state.conflict) {
    // The session ended outside the resolver (terminal abort, commit from
    // Local Changes): drop its prefilled message if untouched, the resolver's
    // partial choices, and any batch that was waiting on it.
    if (conflictPrefill) ui.changesView?.clearPrefill(conflictPrefill.summary, conflictPrefill.body);
    conflictPrefill = null;
    ui.conflictView?.reset();
    ui.pendingCherryPicks = [];
    ui.pickPlanRepo = "";
  }
  // A resolved/aborted merge should not strand the user on the conflict view.
  if (state.view === "conflict" && !state.conflict) showView("history");
}

// The merge/cherry-pick/revert message last pre-filled into the commit box,
// so it's done once per session and cleared when that session ends.
let conflictPrefill: { summary: string; body: string } | null = null;

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
    ui.conflictView?.reset(); // forget partial choices so a re-merge starts fresh
    ui.pendingCherryPicks = []; // the rest of a paused batch goes with it
    ui.pickPlanRepo = ""; // …or of a paused plan
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

// Report a failed op that may have left a merge/rebase conflict in progress
// (pull, stash pop/apply): refresh the banners' state first and offer Resolve
// Conflicts, as runCommitOp does. A pull with rebase conflicts shows up as a
// paused rebase, not a conflict session, so check both.
export async function opFailedMaybeConflict(title: string, err: unknown): Promise<void> {
  await Promise.all([refreshConflictStatus(), refreshRebaseStatus(), loadSidebar()]);
  const inConflict =
    (state.conflict !== null && state.conflict.conflicted.length > 0) ||
    (state.rebase?.in_progress === true && state.rebase.paused_for === "conflict");
  opFailed(title, err, inConflict ? { label: "Resolve Conflicts", run: () => showView("conflict") } : undefined);
}

// --- Detached HEAD ------------------------------------------------------------

// A bar in History while HEAD is detached (a commit or tag checked out), where
// new commits belong to no branch and are easy to lose: offer a branch at HEAD,
// or the way back to the last branch. Not while a rebase, bisect or conflict is
// in progress — those detach HEAD on purpose and have banners of their own.
// HEAD's commit comes from the current worktree's entry, the one place the
// refresh already reads it.
function renderDetachedBanner(): void {
  let banner = document.getElementById("detached-banner");
  const here = state.worktrees.find((w) => w.is_current);
  const sha = here && here.branch === null ? here.head : null;
  const busy = state.rebase?.in_progress || state.bisect !== null || state.conflict !== null;
  if (!sha || busy || state.view !== "history") {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = el("div", { id: "detached-banner", class: "rebase-banner" });
    document.body.append(banner);
  }
  clear(banner);

  const short = sha.slice(0, 7);
  const info = el("div", { class: "rebase-banner-info" }, [
    el("span", { class: "rebase-banner-title", text: `You are in a detached HEAD state at ${short}` }),
    el("span", { class: "rebase-banner-sub", text: "Commits made here belong to no branch." }),
  ]);
  const actions = el("div", { class: "rebase-banner-actions" });
  const create = el("button", { class: "btn small", text: "Create Branch Here…" });
  create.addEventListener("click", () => {
    const r = create.getBoundingClientRect();
    showPrompt(r.left, r.top - 48, {
      placeholder: "New branch name",
      onSubmit: (name) => refActions.createBranchAt(name, sha),
    });
  });
  actions.append(create);
  // `recent` skips HEAD and detached checkouts, so its first entry is the
  // branch this checkout left.
  const last = state.refs.branches.find((b) => b.name === state.refs.recent[0]);
  if (last) {
    const back = el("button", { class: "btn small ghost", text: `Checkout ${last.name}` });
    back.addEventListener("click", () => refActions.checkoutBranchAction(last));
    actions.append(back);
  }
  banner.append(info, actions);
}

// --- Bisect in progress (good / bad / skip / reset) --------------------------

// A bar shown while a bisect is in progress: how far along it is and which
// commit is under test, with Good / Bad / Skip / Reset — or, once git has
// narrowed it down, the first bad commit with Show / Reset.
function renderBisectBanner(): void {
  let banner = document.getElementById("bisect-banner");
  const st = state.bisect;
  if (!st) {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = el("div", { id: "bisect-banner", class: "rebase-banner bisect-banner" });
    document.body.append(banner);
  }
  clear(banner);

  const { title, sub } = bisectBannerText(st);
  const info = el("div", { class: "rebase-banner-info" }, [
    el("span", { class: "rebase-banner-title", text: title }),
    el("span", { class: "rebase-banner-sub", text: sub }),
  ]);
  const actions = el("div", { class: "rebase-banner-actions" });
  const reset = el("button", { class: "btn small danger", text: "Reset Bisect" });
  reset.addEventListener("click", () => void bisectStep("reset"));

  const firstBad = st.first_bad;
  if (firstBad) {
    const show = el("button", { class: "btn small", text: "Show" });
    show.addEventListener("click", () => void jumpToCommit(firstBad, firstBad.slice(0, 7)));
    actions.append(show, reset);
    banner.append(info, actions);
    return;
  }

  for (const [mark, label] of [
    ["good", "Good"],
    ["bad", "Bad"],
    ["skip", "Skip"],
  ] as [BisectMark, string][]) {
    const btn = el("button", { class: `btn small${mark === "skip" ? " ghost" : ""}`, text: label });
    btn.title = `Mark ${st.current.slice(0, 7)} as ${mark}`;
    btn.addEventListener("click", () => void bisectStep(mark));
    actions.append(btn);
  }
  actions.append(reset);
  banner.append(info, actions);
}

// Mark `rev` (the commit under test when omitted), or reset the bisect.
export function bisectStep(mark: BisectMark | "reset", rev?: string): Promise<void> {
  if (mark === "reset") return runBisectOp("Resetting bisect", bisectReset);
  const short = (rev ?? state.bisect?.current ?? "HEAD").slice(0, 7);
  return runBisectOp(`Marking ${short} as ${mark}`, () => bisectMark(mark, rev ?? null));
}

// Run a bisect step and reload — each one checks out another commit — then
// follow the commit now under test (or the culprit, once found) in the log.
// A failure is git's own text, e.g. local changes the checkout would overwrite.
export async function runBisectOp(label: string, op: () => Promise<string>): Promise<void> {
  setStatus(`${label}…`);
  try {
    const out = (await op()).trim();
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    const focus = state.bisect ? (state.bisect.first_bad ?? state.bisect.current) : null;
    if (focus) await jumpToCommit(focus, focus.slice(0, 7));
    reportDone(out || `${label} done.`);
  } catch (err) {
    await loadSidebar();
    opFailed(`${label} failed`, err);
  }
}
