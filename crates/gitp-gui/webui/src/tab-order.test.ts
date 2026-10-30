import { describe, it, expect } from "vitest";
import { cycledTabIndex, droppedTabIndex } from "./tab-order";

describe("droppedTabIndex", () => {
  // Tabs A B C D; the index is into the list with the dragged tab removed.
  it("moves a tab left, in front of the tab it's dropped on", () => {
    expect(droppedTabIndex(3, 1, false)).toBe(1); // D before B: A D B C
  });

  it("moves a tab right, behind the tab it's dropped on", () => {
    expect(droppedTabIndex(0, 2, true)).toBe(2); // A after C: B C A D
  });

  it("counts a drop before the tab to the right as no move", () => {
    expect(droppedTabIndex(1, 2, false)).toBe(1); // B before C: still A B C D
    expect(droppedTabIndex(1, 0, true)).toBe(1); // B after A: same
  });

  it("drops behind the last tab", () => {
    expect(droppedTabIndex(0, 3, true)).toBe(3); // B C D A
  });
});

describe("cycledTabIndex", () => {
  it("steps forward and back", () => {
    expect(cycledTabIndex(3, 0, 1)).toBe(1);
    expect(cycledTabIndex(3, 2, -1)).toBe(1);
  });

  it("wraps around both ends", () => {
    expect(cycledTabIndex(3, 2, 1)).toBe(0);
    expect(cycledTabIndex(3, 0, -1)).toBe(2);
  });
});
