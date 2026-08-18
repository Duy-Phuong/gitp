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
  createPullRequest,
  createTagAt,
  deleteBranch,
  discardHunk,
  fastForwardBranch,
  fetchAndUpdateBranch,
  fetchBlame,
  fetchBranch,
  fetchCommitDetail,
  fetchCommitTree,
  fetchConfig,
  fetchFileHistory,
  fetchFileDiff,
  fetchLocalChangeCount,
  fetchLogPage,
  createBackupBranch,
  fetchRebaseStatus,
  fetchRebaseTodo,
  fetchRefs,
  fetchStatusSummary,
  interactiveRebase,
  isTauri,
  listRepos,
  mergeBranch,
  openRepo,
  pull,
  push,
  pushBranch,
  rebaseAbort,
  rebaseContinue,
  rebaseSkip,
  rebaseOnto,
  renameBranch,
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
  unstage,
  unstageAll,
  unstageHunk,
} from "./api";
import { ensureAvatars } from "./avatar";
import { clear, el } from "./dom";
import { GRAPH_METRICS } from "./graph";
import { renderLog, type RefLabel } from "./views/log";
import { showCommitMenu, closeCommitMenu } from "./views/commit-menu";
import { showContextMenu, type MenuItem } from "./views/context-menu";
import { openRebaseModal, type RebaseOptions } from "./views/rebase";
import { openStashApplyModal } from "./views/stash-apply";
import { setupDetail, type DetailHandle } from "./views/detail";
import { setupChanges, type ChangesHandle } from "./views/changes";
import { renderConfig } from "./views/config";
import { renderSidebar, type SidebarView } from "./views/sidebar";
import { setupTerminal, type TerminalHandle } from "./views/terminal";
import type {
  BranchRef,
  CommitRow,
  ConfigScope,
  RebaseAction,
  RebaseStatus,
  RebaseStep,
  Refs,
  RepoTab,
  ResetMode,
  StashRef,
  Workspace,
} from "./types";

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
  rebase: RebaseStatus | null;
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
  rebase: null,
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
  // Surface (or clear) a paused-rebase banner whenever refs are reloaded.
  void refreshRebaseStatus();
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
      onBranchMenu: (b, x, y) => onBranchMenu(b, x, y),
      onStashClick: (s) => void showStashDetail(s),
      onStashMenu: (s, x, y) => onStashMenu(s, x, y),
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

// --- Branch right-click menu ------------------------------------------------

// The short (leaf) name of a branch, for prefilling the Rename input.
function branchLeafName(name: string): string {
  const i = name.lastIndexOf("/");
  return i === -1 ? name : name.slice(i + 1);
}

// Build and open the actions menu for a right-clicked branch.
function onBranchMenu(b: BranchRef, x: number, y: number): void {
  const current = state.refs.head;
  const items: MenuItem[] = [];

  if (!b.is_head) items.push({ label: "Checkout", run: () => void checkoutBranchAction(b) });
  items.push({ separator: true });
  items.push({
    label: "New Branch here…",
    prompt: {
      placeholder: "New branch name",
      onSubmit: (name) => void runBranchOp(`Creating ${name}`, () => createBranchAt(name, b.target), true),
    },
  });
  items.push({
    label: "New Tag here…",
    prompt: {
      placeholder: "New tag name",
      onSubmit: (name) => void runBranchOp(`Tagging ${b.name} as ${name}`, () => createTagAt(name, b.target), false),
    },
  });

  if (!b.is_head && current) {
    items.push({ separator: true });
    items.push({
      label: `Merge into ${current}`,
      run: () => void runBranchOp(`Merging ${b.name} into ${current}`, () => mergeBranch(b.name), true),
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
  items.push({ label: "Fetch", run: () => void runBranchOp(`Fetching updates for ${b.name}`, () => fetchBranch(b.name), false) });
  items.push({
    label: "Fetch and Update (fast-forward)",
    run: () => void runBranchOp(`Fetching and updating ${b.name}`, () => fetchAndUpdateBranch(b.name), true),
  });
  items.push({ label: "Push to origin", run: () => void runBranchOp(`Pushing ${b.name}`, () => pushBranch(b.name), false) });
  if (b.behind > 0) {
    items.push({
      label: "Fast-forward to upstream",
      run: () => void runBranchOp(`Fast-forwarding ${b.name}`, () => fastForwardBranch(b.name), true),
    });
  }
  items.push({ label: "Create Pull Request on origin", run: () => void createPullRequestAction(b) });

  items.push({ separator: true });
  items.push({
    label: "Set Upstream…",
    prompt: {
      placeholder: "Upstream (e.g. origin/main)",
      onSubmit: (up) => void runBranchOp(`Setting upstream of ${b.name}`, () => setUpstream(b.name, up), false),
    },
  });
  items.push({ label: "Unset Upstream", run: () => void runBranchOp(`Unsetting upstream of ${b.name}`, () => unsetUpstream(b.name), false) });

  items.push({ separator: true });
  items.push({
    label: "Rename…",
    prompt: {
      placeholder: "New name",
      value: branchLeafName(b.name),
      onSubmit: (name) => void renameBranchAction(b, name),
    },
  });
  if (!b.is_head) items.push({ label: "Delete…", danger: true, run: () => void deleteBranchAction(b) });

  items.push({ separator: true });
  items.push({ label: "Copy Branch Name", run: () => void copyText(b.name, `Copied ${b.name}`) });

  showContextMenu(x, y, items);
}

// Click a stash: show its diff in the detail view. A stash commit's first
// parent is the base it was taken from, so fetchCommitDetail surfaces exactly
// the stashed changes. Switches to History, where the detail pane lives.
async function showStashDetail(s: StashRef): Promise<void> {
  showView("history");
  state.selectedId = null;
  try {
    detailView?.show(await fetchCommitDetail(`stash@{${s.index}}`));
  } catch (err) {
    setStatus(`Failed to load stash: ${String(err)}`);
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

// Run a stash op, then refresh the sidebar and — if it's open — the Local
// Changes view (apply/pop mutate the working tree). Shows git's output.
async function runStashOp(label: string, op: () => Promise<string>): Promise<void> {
  setStatus(`${label}…`);
  try {
    const out = (await op()).trim();
    await loadSidebar();
    if (state.view === "changes") await loadChanges();
    setStatus(out || `${label} done.`);
  } catch (err) {
    setStatus(`${label} failed: ${String(err)}`);
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
    setStatus(out || "Saved patch.");
  } catch (err) {
    setStatus(`Save failed: ${String(err)}`);
  }
}

// Run a branch op, then refresh the sidebar (and history when the op can move
// HEAD or change commits). Shows git's own output on success.
async function runBranchOp(label: string, op: () => Promise<string>, refreshLog: boolean): Promise<void> {
  setStatus(`${label}…`);
  try {
    const out = (await op()).trim();
    if (refreshLog) {
      showView("history");
      await Promise.all([refreshHistory(), loadSidebar()]);
    } else {
      await loadSidebar();
    }
    setStatus(out || `${label} done.`);
  } catch (err) {
    setStatus(`${label} failed: ${String(err)}`);
  }
}

async function renameBranchAction(b: BranchRef, newName: string): Promise<void> {
  if (newName === b.name) return;
  setStatus(`Renaming ${b.name}…`);
  try {
    await renameBranch(b.name, newName);
    await loadSidebar();
    if (state.view === "history") await refreshHistory();
    setStatus(`Renamed ${b.name} → ${newName}`);
  } catch (err) {
    setStatus(`Rename failed: ${String(err)}`);
  }
}

// Safe delete first; if git refuses because the branch isn't merged, offer a
// force delete behind a second, explicit confirmation.
async function deleteBranchAction(b: BranchRef): Promise<void> {
  if (!(await confirmDialog(`Delete branch ${b.name}?`))) {
    setStatus("Delete cancelled.");
    return;
  }
  try {
    await deleteBranch(b.name, false);
    await loadSidebar();
    setStatus(`Deleted ${b.name}`);
  } catch (err) {
    const msg = String(err);
    if (/not fully merged/i.test(msg)) {
      const force = await confirmDialog(
        `${b.name} is not fully merged. Force delete? Unmerged commits will be lost.`,
      );
      if (!force) {
        setStatus("Delete cancelled.");
        return;
      }
      try {
        await deleteBranch(b.name, true);
        await loadSidebar();
        setStatus(`Force-deleted ${b.name}`);
      } catch (err2) {
        setStatus(`Delete failed: ${String(err2)}`);
      }
    } else {
      setStatus(`Delete failed: ${msg}`);
    }
  }
}

// Open the branch's pull-request page in the browser (URL derived from origin).
async function createPullRequestAction(b: BranchRef): Promise<void> {
  setStatus(`Opening pull request for ${b.name}…`);
  try {
    const url = await createPullRequest(b.name);
    setStatus(`Opened pull request page: ${url}`);
  } catch (err) {
    setStatus(`Create pull request failed: ${String(err)}`);
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
    setStatus(`Rebase preparation failed: ${String(err)}`);
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
    if (!state.rebase?.in_progress) setStatus(out || `Rebased ${current} onto ${ontoLabel}.`);
  } catch (err) {
    await refreshRebaseStatus();
    setStatus(`Rebase failed: ${String(err)}`);
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
    setStatus(`${action} failed: ${String(err)}`);
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

  const cont = el("button", { class: "btn small", text: "Continue" });
  cont.addEventListener("click", () => void rebaseControl("continue"));
  const skip = el("button", { class: "btn small ghost", text: "Skip" });
  skip.addEventListener("click", () => void rebaseControl("skip"));
  const abort = el("button", { class: "btn small danger", text: "Abort" });
  abort.addEventListener("click", () => void rebaseControl("abort"));

  banner.append(info, el("div", { class: "rebase-banner-actions" }, [cont, skip, abort]));
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
    if (!state.rebase?.in_progress) setStatus(out || `${label} done.`);
  } catch (err) {
    await refreshRebaseStatus();
    setStatus(`${label} failed: ${String(err)}`);
  }
}

// --- Commit right-click menu ------------------------------------------------

// Open the context menu for a right-clicked commit, wiring each item to the
// action that runs the git command and refreshes the view.
function onCommitContextMenu(row: CommitRow, x: number, y: number): void {
  const rev = row.id;
  const short = row.short_id;
  showCommitMenu(x, y, row, {
    currentBranch: state.refs.head ?? "HEAD",
    copySha: () => void copySha(rev),
    checkoutCommit: () => void checkoutCommitAction(rev, short),
    newBranch: (name) => void runCommitOp(`Creating ${name}`, () => createBranchAt(name, rev)),
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
    fetchStatus: fetchStatusSummary,
    fetchFileDiff,
    stage,
    unstage,
    stageAll,
    unstageAll,
    stageHunk,
    unstageHunk,
    discardHunk,
    confirm: confirmDialog,
    commit: commitChanges,
    // Staging doesn't change refs or history, so just update the badge — no ref
    // walk or log rebuild (that's what made each stage/unstage feel slow).
    onChanged: (count) => {
      state.localChanges = count;
      renderSidebarNow();
    },
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
