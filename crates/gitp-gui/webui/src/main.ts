import "./styles.css";
import {
  fetchCommitDetail,
  fetchConfig,
  fetchLog,
  isTauri,
  openRepo,
  saveConfig,
} from "./api";
import { renderLog } from "./views/log";
import { renderDetail, renderDetailEmpty } from "./views/detail";
import { renderConfig } from "./views/config";
import { setupTerminal, type TerminalHandle } from "./views/terminal";
import type { CommitRow, ConfigScope } from "./types";

interface State {
  repoPath: string;
  rows: CommitRow[];
  selectedId: string | null;
}

const state: State = { repoPath: "", rows: [], selectedId: null };
let terminal: TerminalHandle | null = null;

const $ = <T extends HTMLElement>(sel: string): T => {
  const node = document.querySelector<T>(sel);
  if (!node) throw new Error(`missing element: ${sel}`);
  return node;
};

function setStatus(message: string): void {
  $("#statusbar").textContent = message;
}

async function loadRepo(path: string): Promise<void> {
  try {
    state.repoPath = await openRepo(path);
    $<HTMLInputElement>("#repo-input").value = state.repoPath;
    terminal?.setCwd(state.repoPath);
    await refreshHistory();
    setStatus(`Opened ${state.repoPath} · ${state.rows.length} commits`);
  } catch (err) {
    setStatus(`Failed to open repo: ${String(err)}`);
  }
}

async function refreshHistory(): Promise<void> {
  state.rows = await fetchLog();
  state.selectedId = state.rows[0]?.id ?? null;
  renderLog($("#log-pane"), state.rows, state.selectedId, selectCommit);
  if (state.selectedId) await selectCommit(state.selectedId);
  else renderDetailEmpty($("#detail-pane"));
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

function switchTab(tab: string): void {
  for (const el of document.querySelectorAll<HTMLElement>(".tab")) {
    el.classList.toggle("active", el.dataset.tab === tab);
  }
  $("#history-view").classList.toggle("hidden", tab !== "history");
  $("#config-view").classList.toggle("hidden", tab !== "config");
  if (tab === "config") void refreshConfig();
}

function toggleTerminal(): void {
  const panel = $("#terminal-panel");
  const hidden = panel.classList.toggle("hidden");
  if (!hidden) {
    if (!terminal) terminal = setupTerminal($("#terminal-host"));
    terminal.setCwd(state.repoPath || ".");
    requestAnimationFrame(() => terminal?.fit());
  }
}

function wireUi(): void {
  $("#open-btn").addEventListener("click", () => {
    const path = $<HTMLInputElement>("#repo-input").value.trim();
    if (path) void loadRepo(path);
  });
  $<HTMLInputElement>("#repo-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#open-btn").click();
  });
  for (const tab of document.querySelectorAll<HTMLElement>(".tab")) {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab ?? "history"));
  }
  $("#terminal-toggle").addEventListener("click", toggleTerminal);
  $("#terminal-close").addEventListener("click", toggleTerminal);
  window.addEventListener("resize", () => terminal?.fit());
}

async function init(): Promise<void> {
  wireUi();
  if (isTauri()) {
    setStatus("Enter a repository path and press Open.");
    renderDetailEmpty($("#detail-pane"));
  } else {
    setStatus("Preview mode (mock data). Open the desktop app for a real repo.");
    await refreshHistory();
  }
}

void init();
