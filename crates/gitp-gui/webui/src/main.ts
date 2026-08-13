import "./styles.css";
import {
  activateRepo,
  browseForRepo,
  checkoutBranch,
  closeRepo,
  confirmDialog,
  fetchCommitDetail,
  fetchConfig,
  fetchLocalChangeCount,
  fetchLogPage,
  fetchRefs,
  fetchWorkingChanges,
  isTauri,
  listRepos,
  openRepo,
  saveConfig,
} from "./api";
import { clear, el } from "./dom";
import { GRAPH_METRICS } from "./graph";
import { renderLog } from "./views/log";
import { renderDetail, renderDetailEmpty } from "./views/detail";
import { renderChanges } from "./views/changes";
import { renderConfig } from "./views/config";
import { renderSidebar, type SidebarView } from "./views/sidebar";
import { setupTerminal, type TerminalHandle } from "./views/terminal";
import type { BranchRef, CommitRow, ConfigScope, Refs, RepoTab, Workspace } from "./types";

type View = "history" | "changes" | "config";

const EMPTY_REFS: Refs = { head: null, branches: [], remotes: [], tags: [], stashes: [] };

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
  sbCollapsed: new Set(),
};
let terminal: TerminalHandle | null = null;
let loadingMore = false;

const $ = <T extends HTMLElement>(sel: string): T => {
  const node = document.querySelector<T>(sel);
  if (!node) throw new Error(`missing element: ${sel}`);
  return node;
};

function setStatus(message: string): void {
  $("#statusbar").textContent = message;
}

// Open a repo as a new tab (or switch to it if already open), then show its log.
async function loadRepo(path: string): Promise<void> {
  try {
    applyWorkspace(await openRepo(path));
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    setStatus(`Opened ${state.repoPath} · ${state.total} commits`);
  } catch (err) {
    setStatus(`Failed to open repo: ${String(err)}`);
  }
}

// Adopt the backend's workspace as the source of truth for the tab bar and the
// active repo. Does not itself load history — callers decide when to refresh.
function applyWorkspace(ws: Workspace): void {
  state.repos = ws.repos;
  const active = ws.active != null ? ws.repos[ws.active] : undefined;
  state.repoPath = active?.path ?? "";
  renderRepoTabs();
  $<HTMLInputElement>("#repo-input").value = state.repoPath;
  if (state.repoPath) terminal?.setCwd(state.repoPath);
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
    setStatus(`Failed to switch repo: ${String(err)}`);
  }
}

async function closeRepoTab(path: string): Promise<void> {
  const wasActive = path === state.repoPath;
  try {
    applyWorkspace(await closeRepo(path));
    if (state.repos.length === 0) {
      state.rows = [];
      state.total = 0;
      state.selectedId = null;
      state.refs = EMPTY_REFS;
      state.localChanges = 0;
      renderLog($("#log-pane"), [], null, selectCommit, loadMoreCommits);
      renderDetailEmpty($("#detail-pane"));
      renderSidebarNow();
      setStatus("No repository open.");
    } else if (wasActive) {
      showView("history");
      await Promise.all([refreshHistory(), loadSidebar()]);
      setStatus(`Switched to ${state.repoPath} · ${state.total} commits`);
    }
  } catch (err) {
    setStatus(`Failed to close repo: ${String(err)}`);
  }
}

async function refreshHistory(): Promise<void> {
  const page = await fetchLogPage(0, PAGE_SIZE);
  state.rows = page.rows;
  state.total = page.total;
  state.selectedId = state.rows[0]?.id ?? null;
  renderLog($("#log-pane"), state.rows, state.selectedId, selectCommit, loadMoreCommits);
  if (state.selectedId) await selectCommit(state.selectedId);
  else renderDetailEmpty($("#detail-pane"));
}

// Append the next page when the user scrolls near the end of what's loaded.
async function loadMoreCommits(): Promise<void> {
  if (loadingMore || state.rows.length >= state.total) return;
  loadingMore = true;
  try {
    const page = await fetchLogPage(state.rows.length, PAGE_SIZE);
    state.rows = state.rows.concat(page.rows);
    state.total = page.total;
    const host = $("#log-pane");
    const keepScroll = host.scrollTop;
    renderLog(host, state.rows, state.selectedId, selectCommit, loadMoreCommits);
    host.scrollTop = keepScroll;
    setStatus(`${state.rows.length} / ${state.total} commits loaded`);
  } catch (err) {
    setStatus(`Failed to load more commits: ${String(err)}`);
  } finally {
    loadingMore = false;
  }
}

async function selectCommit(id: string): Promise<void> {
  // The log view updates its own highlight on click; here we only load detail.
  state.selectedId = id;
  try {
    const detail = await fetchCommitDetail(id);
    renderDetail($("#detail-pane"), detail);
  } catch (err) {
    setStatus(`Failed to load commit: ${String(err)}`);
  }
}

async function refreshConfig(): Promise<void> {
  const entries = await fetchConfig();
  renderConfig($("#config-editor"), entries, handleConfigSave);
}

async function handleConfigSave(scope: ConfigScope, name: string, value: string): Promise<void> {
  try {
    await saveConfig(scope, name, value);
    setStatus(`Saved ${name} (${scope})`);
    await refreshConfig();
  } catch (err) {
    setStatus(`Failed to save ${name}: ${String(err)}`);
  }
}

// Switch the main panel between history, local changes, and config; keeps the
// topbar tabs and sidebar nav highlight in sync, and loads the view's data.
function showView(view: View): void {
  state.view = view;
  $("#history-view").classList.toggle("hidden", view !== "history");
  $("#changes-view").classList.toggle("hidden", view !== "changes");
  $("#config-view").classList.toggle("hidden", view !== "config");
  for (const el of document.querySelectorAll<HTMLElement>(".tab")) {
    el.classList.toggle("active", el.dataset.tab === view);
  }
  renderSidebarNow();
  if (view === "config") void refreshConfig();
  else if (view === "changes") void loadChanges();
}

// Fetch the ref tree + local-change count for the active repo and render the sidebar.
async function loadSidebar(): Promise<void> {
  try {
    const [refs, localChanges] = await Promise.all([fetchRefs(), fetchLocalChangeCount()]);
    state.refs = refs;
    state.localChanges = localChanges;
  } catch (err) {
    state.refs = EMPTY_REFS;
    setStatus(`Failed to load refs: ${String(err)}`);
  }
  renderSidebarNow();
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

function renderSidebarNow(): void {
  renderBranchIndicator();
  const active = state.repos.find((r) => r.path === state.repoPath);
  renderSidebar(
    $("#sidebar"),
    {
      refs: state.refs,
      localChanges: state.localChanges,
      repoName: active?.name ?? "",
      activeView: state.view,
      filter: state.sbFilter,
      collapsed: state.sbCollapsed,
    },
    {
      onSelectView: (v: SidebarView) => showView(v),
      onFilter: (text) => {
        state.sbFilter = text;
        renderSidebarNow();
      },
      onToggle: (key) => {
        if (state.sbCollapsed.has(key)) state.sbCollapsed.delete(key);
        else state.sbCollapsed.add(key);
        renderSidebarNow();
      },
      onRefJump: (target, label) => void jumpToCommit(target, label),
      onBranchCheckout: (b) => void checkoutBranchAction(b),
    },
  );
}

async function loadChanges(): Promise<void> {
  try {
    const files = await fetchWorkingChanges();
    renderChanges($("#changes-pane"), files);
  } catch (err) {
    setStatus(`Failed to load local changes: ${String(err)}`);
  }
}

// Single-click a branch/remote/tag: show its tip commit, scrolling the log to it
// if that commit is loaded.
async function jumpToCommit(target: string, label: string): Promise<void> {
  showView("history");
  const idx = state.rows.findIndex((r) => r.id === target);
  state.selectedId = target;
  renderLog($("#log-pane"), state.rows, state.selectedId, selectCommit, loadMoreCommits);
  if (idx >= 0) {
    const pane = $("#log-pane");
    pane.scrollTop = Math.max(0, idx * GRAPH_METRICS.rowHeight - pane.clientHeight / 2);
  }
  await selectCommit(target);
  setStatus(idx >= 0 ? `Jumped to ${label}` : `Showing ${label} (tip not in the loaded log)`);
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
    await checkoutBranch(b.name);
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    setStatus(`Checked out ${b.name}`);
  } catch (err) {
    setStatus(`Checkout failed: ${String(err)}`);
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
  if (!hidden) {
    if (!terminal) terminal = setupTerminal($("#terminal-host"), onTerminalCommand);
    terminal.setCwd(state.repoPath || ".");
    requestAnimationFrame(() => terminal?.fit());
  }
}

// Drag the divider to resize the log pane; the detail pane fills the rest.
function setupPaneResizer(): void {
  const view = $("#history-view");
  const divider = $("#pane-divider");
  const MIN_LOG = 260;
  const MIN_DETAIL = 360;
  let dragging = false;

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const rect = view.getBoundingClientRect();
    const max = rect.width - MIN_DETAIL - 6;
    const width = Math.max(MIN_LOG, Math.min(max, e.clientX - rect.left));
    view.style.setProperty("--log-w", `${width}px`);
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
    showView("config");
  });
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
  $("#terminal-toggle").addEventListener("click", toggleTerminal);
  $("#terminal-close").addEventListener("click", toggleTerminal);
  window.addEventListener("resize", () => terminal?.fit());
  setupPaneResizer();
  setupSidebarResizer();
  setupSettingsMenu();
}

async function init(): Promise<void> {
  wireUi();
  if (isTauri()) {
    setStatus("Enter a repository path and press Open.");
    renderDetailEmpty($("#detail-pane"));
    renderSidebarNow();
  } else {
    applyWorkspace(await listRepos());
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    setStatus("Preview mode (mock data). Open the desktop app for a real repo.");
  }
}

void init();
