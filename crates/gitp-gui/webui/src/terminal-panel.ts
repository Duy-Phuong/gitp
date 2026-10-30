// The embedded terminal panel: showing / hiding it, its tabs, and refreshing
// after a command.
//
// Each repo has its own strip of shell tabs. Switching repos swaps the strip,
// but the other repo's shells keep running — a build or a dev server started
// there carries on in the background. Closing a repo tab kills its shells.

import { $, clear, el } from "./dom";
import { setupTerminal, type TerminalHandle } from "./views/terminal";
import { state, ui, type TerminalPanel } from "./app-state";
import { loadChanges, loadSidebar, refreshHistory, renderTerminalCwd } from "./shell";
import { tabNumber } from "./terminal-text";

interface TermTab {
  num: number;
  title: string;
  // The tab's own box inside #terminal-host; only the active one is shown.
  box: HTMLElement;
  handle: TerminalHandle;
}

interface RepoTerms {
  tabs: TermTab[];
  active: TermTab | null;
}

// Tabs by repo path ("" while no repo is open).
const repos = new Map<string, RepoTerms>();
// The repo whose tabs are on screen.
let shown = "";
// The shell's name for titling tabs (`zsh 2`) — known once one has started,
// and the same for every tab after that.
let shellName = "shell";

// The embedded terminal ran a command (Enter pressed); refresh anything that a
// commit/checkout/stash would have changed.
function onTerminalCommand(): void {
  if (!state.repoPath) return;
  void loadSidebar();
  if (state.view === "history") void refreshHistory();
  else if (state.view === "changes") void loadChanges();
  else if (state.view === "conflict") void ui.conflictView?.reload();
}

function termsOf(path: string): RepoTerms {
  let terms = repos.get(path);
  if (!terms) {
    terms = { tabs: [], active: null };
    repos.set(path, terms);
  }
  return terms;
}

const activeTab = (): TermTab | null => repos.get(shown)?.active ?? null;

const panelOpen = (): boolean => !$("#terminal-panel").classList.contains("hidden");

function setPanelOpen(open: boolean): void {
  $("#terminal-panel").classList.toggle("hidden", !open);
  // The divider only makes sense while the panel it resizes is on screen.
  $("#terminal-divider").classList.toggle("hidden", !open);
}

// Show only the shown repo's active tab, sized to the panel. Sizing waits a
// frame: a box that was display:none has no size until it's laid out.
function layout(focus = false): void {
  const active = activeTab();
  for (const [path, terms] of repos) {
    for (const tab of terms.tabs) tab.box.classList.toggle("hidden", path !== shown || tab !== active);
  }
  renderTabs();
  if (!active || !panelOpen()) return;
  requestAnimationFrame(() => {
    active.handle.fit();
    if (focus) active.handle.focus();
  });
}

// Start a shell in `path`'s folder as a new tab, and make it the active one.
function newTab(path: string): TermTab {
  const terms = termsOf(path);
  const num = tabNumber(terms.tabs.map((t) => t.num));
  const box = el("div", { class: "terminal-tab-host" });
  $("#terminal-host").append(box);
  // `handle` is set below: its callbacks need `tab`, and may run before
  // setupTerminal returns (the browser preview names the shell at once).
  const tab: TermTab = { num, title: `${shellName} ${num}`, box, handle: null! };
  terms.tabs.push(tab);
  terms.active = tab;
  // On screen before xterm opens in it, so it measures a real size — unless
  // it belongs to a repo that isn't.
  for (const other of terms.tabs) other.box.classList.toggle("hidden", path !== shown || other !== tab);
  tab.handle = setupTerminal(box, {
    cwd: path || ".",
    onCommand: onTerminalCommand,
    onShell: (name) => {
      shellName = name;
      tab.title = `${name} ${num}`;
      if (path === shown) renderTabs();
    },
    // The shell exited (`exit`, Ctrl-D): its tab goes, as in any terminal app.
    onExit: () => closeTab(path, tab),
  });
  return tab;
}

// Kill `tab`'s shell and remove it. The last tab going closes the panel; the
// next open starts a fresh shell.
function closeTab(path: string, tab: TermTab): void {
  const terms = repos.get(path);
  const at = terms?.tabs.indexOf(tab) ?? -1;
  if (!terms || at < 0) return;
  tab.handle.dispose();
  tab.box.remove();
  terms.tabs.splice(at, 1);
  if (terms.active === tab) terms.active = terms.tabs[Math.min(at, terms.tabs.length - 1)] ?? null;
  if (path !== shown) return;
  if (!terms.tabs.length) setPanelOpen(false);
  layout(true);
}

function renderTabs(): void {
  const strip = $("#terminal-tabs");
  clear(strip);
  const terms = repos.get(shown);
  for (const tab of terms?.tabs ?? []) {
    const item = el("div", { class: `terminal-tab${tab === terms?.active ? " active" : ""}` }, [
      el("span", { class: "terminal-tab-name", text: tab.title }),
    ]);
    item.addEventListener("click", () => {
      if (!terms) return;
      terms.active = tab;
      layout(true);
    });
    const close = el("span", { class: "terminal-tab-close", title: "Close this tab (ends its shell)" }, ["×"]);
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(shown, tab);
    });
    item.append(close);
    strip.append(item);
  }
  const add = el("button", { class: "term-btn terminal-tab-add", title: "New terminal tab in this repo's folder", "aria-label": "New terminal tab" }, ["+"]);
  add.addEventListener("click", () => {
    newTab(shown);
    layout(true);
  });
  strip.append(add);
}

const panel: TerminalPanel = {
  fit: () => activeTab()?.handle.fit(),
  focus: () => activeTab()?.handle.focus(),
  clear: () => activeTab()?.handle.clear(),
  syncTheme: () => {
    for (const terms of repos.values()) for (const tab of terms.tabs) tab.handle.syncTheme();
  },
  showRepo: (path) => {
    if (path === shown) return;
    shown = path;
    // An open panel shows a shell: a repo without one yet gets its first here.
    if (panelOpen() && !termsOf(path).tabs.length) newTab(path);
    layout();
  },
  closeRepo: (path) => {
    for (const tab of repos.get(path)?.tabs ?? []) {
      tab.handle.dispose();
      tab.box.remove();
    }
    repos.delete(path);
    if (path === shown) layout();
  },
};

export function setupTerminalPanel(): void {
  ui.terminal = panel;
  shown = state.repoPath;
  renderTabs();
}

// Start the shell in the still-hidden panel as soon as a repo is open. A shell
// with a heavy rc file can take seconds to load, and keys typed meanwhile are
// echoed raw (Delete shows as ^?) — by the time the panel is opened it's ready.
export function warmTerminal(): void {
  if (state.repoPath && !termsOf(state.repoPath).tabs.length) {
    newTab(state.repoPath);
    renderTabs();
  }
}

export function toggleTerminal(): void {
  const open = !panelOpen();
  setPanelOpen(open);
  if (!open) return;

  if (!termsOf(shown).tabs.length) newTab(shown);
  renderTerminalCwd();
  // Opening the terminal means wanting to type in it; without the focus you
  // have to click into it first.
  layout(true);
}
