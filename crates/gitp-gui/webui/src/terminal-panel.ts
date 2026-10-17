// The embedded terminal panel: showing / hiding it, and refreshing after a command.

import { $ } from "./dom";
import { setupTerminal } from "./views/terminal";
import { state, ui } from "./app-state";
import { loadChanges, loadSidebar, refreshHistory, renderTerminalCwd } from "./shell";

// The embedded terminal ran a command (Enter pressed); refresh anything that a
// commit/checkout/stash would have changed.
function onTerminalCommand(): void {
  if (!state.repoPath) return;
  void loadSidebar();
  if (state.view === "history") void refreshHistory();
  else if (state.view === "changes") void loadChanges();
  else if (state.view === "conflict") void ui.conflictView?.reload();
}

export function toggleTerminal(): void {
  const panel = $("#terminal-panel");
  const hidden = panel.classList.toggle("hidden");
  // The divider only makes sense while the panel it resizes is on screen.
  $("#terminal-divider").classList.toggle("hidden", hidden);
  if (hidden) return;

  if (!ui.terminal) ui.terminal = setupTerminal($("#terminal-host"), onTerminalCommand);
  ui.terminal.setCwd(state.repoPath || ".");
  renderTerminalCwd();
  requestAnimationFrame(() => {
    ui.terminal?.fit();
    // Opening the terminal means wanting to type in it; without this you have to
    // click into it first.
    ui.terminal?.focus();
  });
}
