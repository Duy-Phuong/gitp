import "./styles.css";
import {
  activateRepo,
  browseForRepo,
  checkoutBranch,
  checkoutCommit,
  cherryPick,
  closeRepo,
  commitChanges,
  confirmDialog,
  createBranch,
  createBranchAt,
  createTagAt,
  fetchBlame,
  fetchCommitDetail,
  fetchCommitTree,
  fetchConfig,
  fetchFileHistory,
  fetchLocalChangeCount,
  fetchLogPage,
  fetchRefs,
  fetchStatus,
  isTauri,
  listRepos,
  openRepo,
  pull,
  push,
  rebaseOnto,
  resetTo,
  revertCommit,
  saveConfig,
  stage,
  stageAll,
  stash,
  stashPop,
  unstage,
  unstageAll,
} from "./api";
import { ensureAvatars } from "./avatar";
import { clear, el } from "./dom";
import { GRAPH_METRICS } from "./graph";
import { renderLog, type RefLabel } from "./views/log";
import { showCommitMenu, closeCommitMenu } from "./views/commit-menu";
import { setupDetail, type DetailHandle } from "./views/detail";
import { setupChanges, type ChangesHandle } from "./views/changes";
import { renderConfig } from "./views/config";
import { renderSidebar, type SidebarView } from "./views/sidebar";
import { setupTerminal, type TerminalHandle } from "./views/terminal";
import type { BranchRef, CommitRow, ConfigScope, Refs, RepoTab, ResetMode, Workspace } from "./types";

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
let detailView: DetailHandle | null = null;
let changesView: ChangesHandle | null = null;
let loadingMore = false;

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

function rebuildCommitRefs(): void {
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

function setStatus(message: string): void {
  $("#statusbar").textContent = message;
}

// --- Theme (System / Light / Dark) -----------------------------------------

type ThemeChoice = "system" | "light" | "dark";
const THEME_KEY = "gitp-theme";

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
  $("#action-bar").classList.toggle("hidden", state.repos.length === 0);
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
      detailView?.showEmpty();
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
  await ensureAvatars(state.rows.map((r) => r.author_email));
  rebuildCommitRefs();
  renderLog($("#log-pane"), state.rows, state.selectedId, selectCommit, loadMoreCommits, refLabelsAt, onCommitContextMenu);
  if (state.selectedId) await selectCommit(state.selectedId);
  else detailView?.showEmpty();
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
    await ensureAvatars(state.rows.map((r) => r.author_email));
    rebuildCommitRefs();
    renderLog(host, state.rows, state.selectedId, selectCommit, loadMoreCommits, refLabelsAt, onCommitContextMenu);
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
    detailView?.show(await fetchCommitDetail(id));
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
  closeCommitMenu();
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
  // Refs now known — recompute containment and re-render the open commit + the
  // log so the branch chips appear on every commit.
  detailView?.refresh();
  rebuildCommitRefs();
  if (state.view === "history" && state.rows.length) {
    const pane = $("#log-pane");
    const keep = pane.scrollTop;
    renderLog(pane, state.rows, state.selectedId, selectCommit, loadMoreCommits, refLabelsAt, onCommitContextMenu);
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

function renderSidebarNow(): void {
  renderBranchIndicator();
  refreshActionButtons();
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
    await changesView?.reload();
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
  renderLog($("#log-pane"), state.rows, state.selectedId, selectCommit, loadMoreCommits, refLabelsAt, onCommitContextMenu);
  if (idx >= 0) {
    const pane = $("#log-pane");
    pane.scrollTop = Math.max(0, idx * GRAPH_METRICS.rowHeight - pane.clientHeight / 2);
  }
  await selectCommit(target);
  detailView?.focusCommit();
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

// --- Action bar (Pull / Push / Branch) -------------------------------------

let actionsBusy = false;

// Enable/disable the toolbar buttons based on the in-flight state and what the
// active repo supports: nothing to stash → Stash off; empty stack → Pop off.
function refreshActionButtons(): void {
  const blocked = actionsBusy || !state.repoPath;
  $<HTMLButtonElement>("#pull-btn").disabled = blocked;
  $<HTMLButtonElement>("#push-btn").disabled = blocked;
  $<HTMLButtonElement>("#branch-btn").disabled = blocked;
  $<HTMLButtonElement>("#stash-btn").disabled = blocked || state.localChanges === 0;
  $<HTMLButtonElement>("#pop-btn").disabled = blocked || state.refs.stashes.length === 0;
}

// Disable every toolbar button while a git operation is in flight.
function setActionsBusy(busy: boolean): void {
  actionsBusy = busy;
  refreshActionButtons();
}

async function pullAction(): Promise<void> {
  if (!state.repoPath) return;
  setActionsBusy(true);
  setStatus("Pulling…");
  try {
    const out = await pull();
    await Promise.all([refreshHistory(), loadSidebar()]);
    setStatus(out || "Pull complete.");
  } catch (err) {
    setStatus(`Pull failed: ${String(err)}`);
  } finally {
    setActionsBusy(false);
  }
}

async function pushAction(): Promise<void> {
  if (!state.repoPath) return;
  setActionsBusy(true);
  setStatus("Pushing…");
  try {
    const out = await push();
    await loadSidebar();
    setStatus(out || "Push complete.");
  } catch (err) {
    setStatus(`Push failed: ${String(err)}`);
  } finally {
    setActionsBusy(false);
  }
}

async function stashAction(): Promise<void> {
  if (!state.repoPath) return;
  setActionsBusy(true);
  setStatus("Stashing…");
  try {
    const out = await stash();
    if (state.view === "changes") await loadChanges();
    await loadSidebar();
    setStatus(out || "Stashed.");
  } catch (err) {
    setStatus(`Stash failed: ${String(err)}`);
  } finally {
    setActionsBusy(false);
  }
}

async function popAction(): Promise<void> {
  if (!state.repoPath) return;
  setActionsBusy(true);
  setStatus("Popping stash…");
  try {
    const out = await stashPop();
    if (state.view === "changes") await loadChanges();
    await loadSidebar();
    setStatus(out || "Popped stash.");
  } catch (err) {
    setStatus(`Pop failed: ${String(err)}`);
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
    setStatus(`Created and switched to ${name}`);
  } catch (err) {
    setStatus(`Create branch failed: ${String(err)}`);
  }
}

// --- Commit right-click menu ------------------------------------------------

// Open the context menu for a right-clicked commit, wiring each item to the
// action that runs the git command and refreshes the view.
function onCommitContextMenu(row: CommitRow, x: number, y: number): void {
  const rev = row.id;
  const short = row.short_id;
  showCommitMenu(x, y, row, {
    copySha: () => void copySha(rev),
    checkoutCommit: () => void checkoutCommitAction(rev, short),
    newBranch: (name) => void runCommitOp(`Creating ${name}`, () => createBranchAt(name, rev)),
    newTag: (name) => void tagAction(name, rev, short),
    cherryPick: () => void runCommitOp(`Cherry-picking ${short}`, () => cherryPick(rev)),
    revert: () => void runCommitOp(`Reverting ${short}`, () => revertCommit(rev)),
    reset: (mode) => void resetAction(rev, short, mode),
    rebaseOnto: () =>
      void confirmThenRun(
        `Rebase the current branch onto ${short}? This rewrites commits on the branch.`,
        `Rebasing onto ${short}`,
        () => rebaseOnto(rev),
      ),
  });
}

// Run a HEAD-moving commit op, then reload history + sidebar from the new HEAD.
// Shows git's own output on success (e.g. cherry-pick/revert summaries).
async function runCommitOp(label: string, op: () => Promise<string>): Promise<void> {
  setStatus(`${label}…`);
  try {
    const out = (await op()).trim();
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    setStatus(out || `${label} done.`);
  } catch (err) {
    setStatus(`${label} failed: ${String(err)}`);
  }
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
  await runCommitOp(`Checking out ${short}`, () => checkoutCommit(rev));
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
    setStatus(`Tagged ${short} as ${name}`);
  } catch (err) {
    setStatus(`Tag failed: ${String(err)}`);
  }
}

// Copy the full SHA. Uses the async clipboard API, falling back to a hidden
// textarea for webviews where it's unavailable.
async function copySha(rev: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(rev);
  } catch {
    const ta = el("textarea", { text: rev }) as HTMLTextAreaElement;
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
  setStatus(`Copied ${rev.slice(0, 10)} to clipboard`);
}

// The Branch button's dropdown: pick a local branch to check out, or create a
// new one from the current HEAD. Rebuilt from current refs each time it opens.
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
    spellcheck: false,
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
  $("#pull-btn").addEventListener("click", () => void pullAction());
  $("#push-btn").addEventListener("click", () => void pushAction());
  $("#stash-btn").addEventListener("click", () => void stashAction());
  $("#pop-btn").addEventListener("click", () => void popAction());
  setupBranchMenu();
  $("#terminal-toggle").addEventListener("click", toggleTerminal);
  $("#terminal-close").addEventListener("click", toggleTerminal);
  window.addEventListener("resize", () => terminal?.fit());
  setupPaneResizer();
  setupSidebarResizer();
  setupSettingsMenu();
}

async function init(): Promise<void> {
  applyTheme(currentTheme());
  wireUi();
  detailView = setupDetail($("#detail-pane"), {
    onSelectCommit: (id) => void jumpToCommit(id, id.slice(0, 10)),
    refsAt,
    fetchTree: fetchCommitTree,
    fetchBlame,
    fetchFileHistory,
  });
  changesView = setupChanges($("#changes-pane"), {
    fetchStatus,
    stage,
    unstage,
    stageAll,
    unstageAll,
    commit: commitChanges,
    onChanged: () => void loadSidebar(),
    onCommitted: () => {
      void loadSidebar();
      void refreshHistory();
    },
    setStatus,
  });
  if (isTauri()) {
    setStatus("Enter a repository path and press Open.");
    detailView?.showEmpty();
    renderSidebarNow();
  } else {
    applyWorkspace(await listRepos());
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    setStatus("Preview mode (mock data). Open the desktop app for a real repo.");
  }
}

void init();
