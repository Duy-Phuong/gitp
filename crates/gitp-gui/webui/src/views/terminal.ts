// Embedded terminal. In Tauri it is wired to a real PTY in the Rust backend via
// events; in a plain browser it shows an informational line (no PTY available).
//
// Colours follow the app's theme rather than being a fixed dark slab: the
// surface comes from the same CSS variables as every other pane, and the 16
// ANSI colours have a light and a dark set, since xterm's defaults are tuned
// for a dark background and are close to unreadable on a light one.

import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { isTauri } from "../api";

export interface TerminalHandle {
  fit: () => void;
  setCwd: (cwd: string) => void;
  // Re-read the palette after the user switches theme — xterm holds its colours
  // as JS values, so a CSS variable change alone doesn't reach it.
  syncTheme: () => void;
  focus: () => void;
  clear: () => void;
}

// ANSI 0-15. The app palette has no opinion on these, so they're spelled out:
// GitHub's dark and light terminal sets, which are contrast-checked against the
// surfaces we put them on.
const ANSI_DARK = {
  black: "#484f58", red: "#ff7b72", green: "#3fb950", yellow: "#d29922",
  blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
  brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364",
  brightYellow: "#e3b341", brightBlue: "#79c0ff", brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd", brightWhite: "#ffffff",
};

const ANSI_LIGHT = {
  black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#4d2d00",
  blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
  brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37",
  brightYellow: "#633c01", brightBlue: "#218bff", brightMagenta: "#a475f9",
  brightCyan: "#3192aa", brightWhite: "#8c959f",
};

// The theme actually in force: an explicit choice wins, otherwise the OS.
function isDark(): boolean {
  const forced = document.documentElement.dataset.theme;
  if (forced === "dark") return true;
  if (forced === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function terminalTheme(): ITheme {
  const dark = isDark();
  return {
    // Surface and cursor come from the app palette, so the terminal is the same
    // material as the rest of the window.
    background: cssVar("--term-bg", dark ? "#0b0d13" : "#ffffff"),
    foreground: cssVar("--term-fg", dark ? "#d7dbe6" : "#1c2027"),
    cursor: cssVar("--accent", "#5b8cff"),
    cursorAccent: cssVar("--term-bg", dark ? "#0b0d13" : "#ffffff"),
    selectionBackground: cssVar("--selection", "rgba(91, 140, 255, 0.32)"),
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  };
}

export function setupTerminal(host: HTMLElement, onCommand?: () => void): TerminalHandle {
  const term = new Terminal({
    fontFamily: cssVar("--mono", "ui-monospace, SFMono-Regular, Menlo, monospace"),
    fontSize: 12,
    lineHeight: 1.2,
    theme: terminalTheme(),
    cursorBlink: true,
    // A build or a long `git log` shouldn't scroll away in a 240px panel.
    scrollback: 5000,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(host);
  fitAddon.fit();

  let cwd = ".";

  const base: Pick<TerminalHandle, "syncTheme" | "focus" | "clear"> = {
    syncTheme: () => {
      term.options.theme = terminalTheme();
    },
    focus: () => term.focus(),
    clear: () => term.clear(),
  };

  if (!isTauri()) {
    term.writeln("\x1b[90mgitp terminal — available in the desktop app.\x1b[0m");
    term.writeln("\x1b[90mRun `gitp` via Tauri to get a real shell here.\x1b[0m");
    return { ...base, fit: () => fitAddon.fit(), setCwd: (c) => (cwd = c) };
  }

  void wireToBackend(term, () => cwd, onCommand);

  return {
    ...base,
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
