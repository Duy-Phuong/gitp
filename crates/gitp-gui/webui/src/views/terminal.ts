// Embedded terminal. In Tauri it is wired to a real PTY in the Rust backend via
// events; in a plain browser it shows an informational line (no PTY available).

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { isTauri } from "../api";

export interface TerminalHandle {
  fit: () => void;
  setCwd: (cwd: string) => void;
}

export function setupTerminal(host: HTMLElement, onCommand?: () => void): TerminalHandle {
  const term = new Terminal({
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    theme: { background: "#0b0d13" },
    cursorBlink: true,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(host);
  fitAddon.fit();

  let cwd = ".";

  if (!isTauri()) {
    term.writeln("\x1b[90mgitp terminal — available in the desktop app.\x1b[0m");
    term.writeln("\x1b[90mRun `gitp` via Tauri to get a real shell here.\x1b[0m");
    return { fit: () => fitAddon.fit(), setCwd: (c) => (cwd = c) };
  }

  void wireToBackend(term, () => cwd, onCommand);

  return {
    fit: () => {
      fitAddon.fit();
      void resizeBackend(term.cols, term.rows);
    },
    setCwd: (c) => (cwd = c),
  };
}

async function wireToBackend(
  term: Terminal,
  getCwd: () => string,
  onCommand?: () => void,
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  await listen<string>("terminal-output", (event) => term.write(event.payload));
  await invoke("terminal_spawn", { cwd: getCwd(), cols: term.cols, rows: term.rows });

  // Pressing Enter submits a command; after it has had a moment to run, tell the
  // app so it can refresh anything a commit/checkout/stash would have changed.
  let commandTimer: number | undefined;
  term.onData((data) => {
    void invoke("terminal_write", { data });
    if (onCommand && (data.includes("\r") || data.includes("\n"))) {
      window.clearTimeout(commandTimer);
      commandTimer = window.setTimeout(onCommand, 700);
    }
  });
}

async function resizeBackend(cols: number, rows: number): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("terminal_resize", { cols, rows });
}
