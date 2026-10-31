// The terminal view, loaded on first use. xterm and its CSS are a chunk of
// their own, fetched the first time a shell opens rather than before the
// first paint; the handle returned here stands in for the real one until it
// arrives, so the panel code is written as if xterm were already there.

import type { TerminalHandle, TerminalOptions } from "./terminal";

export function setupTerminal(host: HTMLElement, opts: TerminalOptions): TerminalHandle {
  let real: TerminalHandle | null = null;
  let disposed = false;
  // Calls made before the chunk arrived, replayed in order once it has.
  const queued: ((h: TerminalHandle) => void)[] = [];
  const call = (f: (h: TerminalHandle) => void) => {
    if (real) f(real);
    else queued.push(f);
  };
  void import("./terminal").then(({ setupTerminal: setup }) => {
    if (disposed) return;
    real = setup(host, opts);
    for (const f of queued) f(real);
    queued.length = 0;
  });
  return {
    fit: () => call((h) => h.fit()),
    syncTheme: () => call((h) => h.syncTheme()),
    syncFont: () => call((h) => h.syncFont()),
    focus: () => call((h) => h.focus()),
    clear: () => call((h) => h.clear()),
    paste: (text) => call((h) => h.paste(text)),
    dispose: () => {
      disposed = true;
      real?.dispose();
      queued.length = 0;
    },
  };
}
