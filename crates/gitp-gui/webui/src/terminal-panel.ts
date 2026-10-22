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

function ensureTerminal(): NonNullable<typeof ui.terminal> {
  if (!ui.terminal) {
    ui.terminal = setupTerminal($("#terminal-host"), onTerminalCommand);
    ui.terminal.setCwd(state.repoPath || ".");
  }
  return ui.terminal;
}

// Start the shell in the still-hidden panel as soon as a repo is open. A shell
// with a heavy rc file can take seconds to load, and keys typed meanwhile are
// echoed raw (Delete shows as ^?) — by the time the panel is opened it's ready.
export function warmTerminal(): void {
  if (state.repoPath) ensureTerminal();
}

export function toggleTerminal(): void {
  const panel = $("#terminal-panel");
  const hidden = panel.classList.toggle("hidden");
  // The divider only makes sense while the panel it resizes is on screen.
  $("#terminal-divider").classList.toggle("hidden", hidden);
  if (hidden) return;

  ensureTerminal().setCwd(state.repoPath || ".");
  renderTerminalCwd();
  requestAnimationFrame(() => {
    ui.terminal?.fit();
    // Opening the terminal means wanting to type in it; without this you have to
    // click into it first.
    ui.terminal?.focus();
  });
}
