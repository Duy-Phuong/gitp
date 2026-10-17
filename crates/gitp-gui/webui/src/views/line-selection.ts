// Line selection in the Local Changes diff: which changed (+/-) lines the user
// has picked for "Stage lines" / "Unstage lines" / "Discard lines". Pure state
// transitions — the DOM wiring lives in changes.ts.
//
// A line is named as the backend names it: its block (hunk) index plus its
// index within that block's `lines`, at the context the diff was drawn with.
// Ranges (shift-click, drag) run in that same order — the order of the patch,
// which is also top-to-bottom in the unified view.

import type { FileDiff } from "../types";

export type LineKey = string;

export const lineKey = (hunk: number, line: number): LineKey => `${hunk}:${line}`;

export interface LineSelection {
  selected: ReadonlySet<LineKey>;
  // Where the last plain click landed; shift-click extends from here.
  anchor: LineKey | null;
  // An in-progress drag: the line it started on, the selection before it, and
  // whether it's selecting or deselecting (decided by the line it started on).
  drag: { start: LineKey; base: ReadonlySet<LineKey>; adding: boolean } | null;
}

export const emptySelection = (): LineSelection => ({ selected: new Set(), anchor: null, drag: null });

// Every selectable (changed) line of `file`, in patch order.
export function changedLines(file: FileDiff): LineKey[] {
  const out: LineKey[] = [];
  file.hunks.forEach((h, hi) =>
    h.lines.forEach((l, li) => {
      if (l.origin === "+" || l.origin === "-") out.push(lineKey(hi, li));
    }),
  );
  return out;
}

// The changed lines from `a` to `b` inclusive, whichever comes first.
function range(order: LineKey[], a: LineKey, b: LineKey): LineKey[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

function withRange(base: ReadonlySet<LineKey>, keys: LineKey[], adding: boolean): Set<LineKey> {
  const next = new Set(base);
  for (const k of keys) {
    if (adding) next.add(k);
    else next.delete(k);
  }
  return next;
}

// Mouse down on a changed line. Plain: toggle it and start a drag that applies
// the same (select or deselect) to every line it sweeps. Shift: add the range
// from the anchor to here.
export function press(s: LineSelection, order: LineKey[], key: LineKey, shift: boolean): LineSelection {
  if (!order.includes(key)) return s;
  if (shift && s.anchor !== null && order.includes(s.anchor)) {
    return { ...s, selected: withRange(s.selected, range(order, s.anchor, key), true), drag: null };
  }
  const adding = !s.selected.has(key);
  return {
    selected: withRange(s.selected, [key], adding),
    anchor: key,
    drag: { start: key, base: s.selected, adding },
  };
}

// The drag reached `key`: everything between its start and here takes the
// drag's state; lines it swept over and then left go back to how they were.
export function dragOver(s: LineSelection, order: LineKey[], key: LineKey): LineSelection {
  if (!s.drag || !order.includes(key)) return s;
  const { start, base, adding } = s.drag;
  return { ...s, selected: withRange(base, range(order, start, key), adding) };
}

export function release(s: LineSelection): LineSelection {
  return s.drag ? { ...s, drag: null } : s;
}

// The selection as the backend takes it: [hunk, line] pairs in patch order.
export function selectedPairs(s: LineSelection): [number, number][] {
  return [...s.selected]
    .map((k) => k.split(":").map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
