import { describe, expect, it } from "vitest";

import {
  changedLines,
  dragOver,
  emptySelection,
  lineKey,
  press,
  release,
  selectedPairs,
  type LineSelection,
} from "./line-selection";
import type { DiffLine, FileDiff } from "../types";

const line = (origin: string): DiffLine => ({ origin, old_lineno: null, new_lineno: null, content: "" });

// Two blocks: [ctx, -, +, ctx] and [ctx, +, +, -].
const file: FileDiff = {
  path: "f.txt",
  old_path: null,
  status: "Modified",
  hunks: [
    { header: "@@ -1,3 +1,3 @@", lines: [line(" "), line("-"), line("+"), line(" ")] },
    { header: "@@ -9,2 +9,3 @@", lines: [line(" "), line("+"), line("+"), line("-")] },
  ],
};
const order = changedLines(file);
const keys = (s: LineSelection) => [...s.selected].sort();

describe("changedLines", () => {
  it("lists only the +/- lines, block by block in patch order", () => {
    expect(order).toEqual(["0:1", "0:2", "1:1", "1:2", "1:3"]);
  });
});

describe("press", () => {
  it("toggles a line on and off with plain clicks", () => {
    let s = release(press(emptySelection(), order, lineKey(0, 1), false));
    expect(keys(s)).toEqual(["0:1"]);
    s = release(press(s, order, lineKey(0, 2), false));
    expect(keys(s)).toEqual(["0:1", "0:2"]);
    s = release(press(s, order, lineKey(0, 1), false));
    expect(keys(s)).toEqual(["0:2"]);
  });

  it("ignores context lines", () => {
    const s = press(emptySelection(), order, lineKey(0, 0), false);
    expect(s).toEqual(emptySelection());
  });

  it("shift-click adds the range from the anchor, across blocks", () => {
    let s = release(press(emptySelection(), order, lineKey(0, 2), false));
    s = press(s, order, lineKey(1, 2), true);
    expect(keys(s)).toEqual(["0:2", "1:1", "1:2"]);
    // Backwards from the same anchor adds the lines above it too.
    s = press(s, order, lineKey(0, 1), true);
    expect(keys(s)).toEqual(["0:1", "0:2", "1:1", "1:2"]);
  });

  it("shift-click with no anchor acts as a plain click", () => {
    const s = release(press(emptySelection(), order, lineKey(1, 3), true));
    expect(keys(s)).toEqual(["1:3"]);
  });
});

describe("drag", () => {
  it("selects every line swept, and lets go of lines swept back over", () => {
    let s = press(emptySelection(), order, lineKey(0, 1), false);
    s = dragOver(s, order, lineKey(1, 2));
    expect(keys(s)).toEqual(["0:1", "0:2", "1:1", "1:2"]);
    s = dragOver(s, order, lineKey(0, 2));
    expect(keys(s)).toEqual(["0:1", "0:2"]);
    s = release(s);
    expect(s.drag).toBeNull();
    // A drag over lines after release does nothing.
    expect(keys(dragOver(s, order, lineKey(1, 3)))).toEqual(["0:1", "0:2"]);
  });

  it("deselects when it starts on a selected line, keeping the rest", () => {
    let s = release(press(emptySelection(), order, lineKey(0, 1), false));
    s = press(s, order, lineKey(1, 3), true); // everything selected
    s = release(press(s, order, lineKey(0, 2), false));
    expect(keys(s)).toEqual(["0:1", "1:1", "1:2", "1:3"]);
    s = press(s, order, lineKey(1, 1), false);
    s = dragOver(s, order, lineKey(1, 2));
    expect(keys(release(s))).toEqual(["0:1", "1:3"]);
  });
});

describe("selectedPairs", () => {
  it("returns [hunk, line] pairs in patch order", () => {
    let s = release(press(emptySelection(), order, lineKey(1, 3), false));
    s = release(press(s, order, lineKey(0, 2), false));
    s = release(press(s, order, lineKey(1, 1), false));
    expect(selectedPairs(s)).toEqual([
      [0, 2],
      [1, 1],
      [1, 3],
    ]);
  });
});
