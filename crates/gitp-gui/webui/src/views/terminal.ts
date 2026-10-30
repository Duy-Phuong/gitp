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
import { fontStack, loadTerminalFont } from "../prefs";

export interface TerminalHandle {
  fit: () => void;
  // Re-read the palette after the user switches theme — xterm holds its colours
  // as JS values, so a CSS variable change alone doesn't reach it.
  syncTheme: () => void;
  // Re-read the font (Settings → Editor & Diff), for the same reason. The
  // caller fits the terminal afterwards: its cells changed size.
  syncFont: () => void;
  focus: () => void;
  clear: () => void;
  // Type `text` at the cursor as a paste would (bracketed, if the shell asked
  // for that), so a dropped path doesn't run anything by itself.
  paste: (text: string) => void;
  // Kill the shell and tear the view down.
  dispose: () => void;
}

export interface TerminalOptions {
  // The folder the shell starts in.
  cwd: string;
  // Enter was pressed — a command may have changed the repo.
  onCommand?: () => void;
  // The shell's name (`zsh`), once it has started.
  onShell?: (name: string) => void;
  // The shell exited by itself (`exit`, Ctrl-D).
  onExit?: () => void;
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
  // Every forced theme but Light is dark, the GitKraken ones included.
  if (forced) return forced !== "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// The family xterm draws with: the chosen one, then the app's monospace stack
// resolved to its value (a canvas can't follow var()).
function terminalFontFamily(font: string): string {
  return fontStack(font, cssVar("--mono", "ui-monospace, SFMono-Regular, Menlo, monospace"));
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

// Each session's id, for routing the backend's events; unique for the life of
// the page.
let nextId = 1;

export function setupTerminal(host: HTMLElement, opts: TerminalOptions): TerminalHandle {
  const font = loadTerminalFont();
  const term = new Terminal({
    fontFamily: terminalFontFamily(font.font),
    fontSize: font.size,
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

  const base: Pick<TerminalHandle, "syncTheme" | "syncFont" | "focus" | "clear"> = {
    syncTheme: () => {
      term.options.theme = terminalTheme();
    },
    syncFont: () => {
      const f = loadTerminalFont();
      term.options.fontFamily = terminalFontFamily(f.font);
      term.options.fontSize = f.size;
    },
    focus: () => term.focus(),
    clear: () => term.clear(),
  };

  if (!isTauri()) {
    term.writeln("\x1b[90mgitp terminal — available in the desktop app.\x1b[0m");
    term.writeln("\x1b[90mRun `gitp` via Tauri to get a real shell here.\x1b[0m");
    opts.onShell?.("zsh");
    return {
      ...base,
      fit: () => fitAddon.fit(),
      // No shell to type into: show what would have been typed.
      paste: (text) => term.write(text),
      dispose: () => term.dispose(),
    };
  }

  const id = nextId++;
  void wireToBackend(term, id, opts);

  return {
    ...base,
    fit: () => {
      fitAddon.fit();
      void invokeBackend("terminal_resize", { id, cols: term.cols, rows: term.rows });
    },
    paste: (text) => term.paste(text),
    dispose: () => {
      sessions.delete(id);
      void invokeBackend("terminal_kill", { id });
      term.dispose();
    },
  };
}

// The live sessions by id. One listener per backend event serves them all,
// rather than every terminal filtering every other's output.
const sessions = new Map<number, { term: Terminal; onExit?: () => void }>();
let listening: Promise<unknown> | null = null;

function listenToBackend(): Promise<unknown> {
  listening ??= import("@tauri-apps/api/event").then(({ listen }) =>
    Promise.all([
      listen<{ id: number; data: string }>("terminal-output", (e) => sessions.get(e.payload.id)?.term.write(e.payload.data)),
      listen<number>("terminal-exit", (e) => {
        const session = sessions.get(e.payload);
        sessions.delete(e.payload);
        session?.onExit?.();
      }),
    ]),
  );
  return listening;
}

async function invokeBackend(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

async function wireToBackend(term: Terminal, id: number, opts: TerminalOptions): Promise<void> {
  sessions.set(id, { term, onExit: opts.onExit });
  await listenToBackend();
  const shell = (await invokeBackend("terminal_spawn", { id, cwd: opts.cwd, cols: term.cols, rows: term.rows })) as string;
  // Closed while the shell was starting: its kill may have reached the backend
  // first, so end the session that was just started.
  if (!sessions.has(id)) {
    void invokeBackend("terminal_kill", { id });
    return;
  }
  opts.onShell?.(shell);

  // Pressing Enter submits a command; after it has had a moment to run, tell the
  // app so it can refresh anything a commit/checkout/stash would have changed.
  let commandTimer: number | undefined;
  term.onData((data) => {
    void invokeBackend("terminal_write", { id, data });
    if (opts.onCommand && (data.includes("\r") || data.includes("\n"))) {
      window.clearTimeout(commandTimer);
      commandTimer = window.setTimeout(opts.onCommand, 700);
    }
  });
}
