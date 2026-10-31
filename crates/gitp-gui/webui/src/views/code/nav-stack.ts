// IntelliJ-style navigation history for the Code tab: every jump (definition,
// usage, search hit, quick open, explorer click) and every big caret move is
// a stop; Back and Forward walk them. Small moves (10 lines or fewer) refresh
// the current stop instead, so reading and typing leave no trail.

import type { Location } from "../../types";

const MAX = 100;
const SIGNIFICANT_LINES = 10;

export class NavStack {
  private history: Location[] = [];
  private cursor = -1;
  private suppress = false;

  /// A jump the user asked for: where they were (if known), then where they land.
  push(from: Location | null, to: Location): void {
    if (from) this.record(from);
    this.record(to);
  }

  /// The caret moved inside the editor; only a big move becomes a stop.
  caretMoved(loc: Location): void {
    if (this.suppress) return;
    const cur = this.history[this.cursor];
    if (!cur) {
      this.record(loc);
      return;
    }
    if (cur.path === loc.path && Math.abs(cur.line - loc.line) <= SIGNIFICANT_LINES) {
      this.history[this.cursor] = loc;
      return;
    }
    this.record(loc);
  }

  back(): Location | null {
    return this.cursor > 0 ? this.history[--this.cursor] : null;
  }

  forward(): Location | null {
    return this.cursor < this.history.length - 1 ? this.history[++this.cursor] : null;
  }

  canBack(): boolean {
    return this.cursor > 0;
  }

  canForward(): boolean {
    return this.cursor < this.history.length - 1;
  }

  /// Run `fn`, which moves the caret, without recording that move.
  silently(fn: () => void): void {
    this.suppress = true;
    try {
      fn();
    } finally {
      this.suppress = false;
    }
  }

  private record(loc: Location): void {
    const cur = this.history[this.cursor];
    if (cur && cur.path === loc.path && cur.line === loc.line) {
      this.history[this.cursor] = loc;
      return;
    }
    this.history.length = this.cursor + 1;
    this.history.push(loc);
    if (this.history.length > MAX) this.history.shift();
    this.cursor = this.history.length - 1;
  }
}
