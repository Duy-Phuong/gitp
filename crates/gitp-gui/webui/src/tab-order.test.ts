import { describe, it, expect } from "vitest";
import { cycledTabIndex, droppedTabIndex, tabCycler } from "./tab-order";

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

describe("tabCycler", () => {
  // A switch that lands only when the test says so, like activateRepo + refresh.
  function slowSwitches(start: string) {
    let active = start;
    const calls: string[] = [];
    let land = () => {};
    let inFlight = 0;
    let overlapped = false;
    const switchTo = (path: string) =>
      new Promise<void>((resolve) => {
        calls.push(path);
        if (++inFlight > 1) overlapped = true;
        land = () => {
          active = path;
          inFlight--;
          resolve();
        };
      });
    const settle = async () => {
      for (let i = 0; i < 10; i++) {
        land();
        await Promise.resolve();
        await Promise.resolve();
      }
    };
    return { active: () => active, switchTo, calls, settle, overlapped: () => overlapped };
  }

  it("steps on from where the previous press was heading, one switch at a time", async () => {
    const tabs = ["a", "b", "c", "d"];
    const s = slowSwitches("a");
    const cycle = tabCycler(s.active, s.switchTo);

    // Three presses before the first switch has landed.
    cycle(tabs, 1);
    cycle(tabs, 1);
    cycle(tabs, 1);
    await s.settle();

    expect(s.active()).toBe("d");
    expect(s.overlapped()).toBe(false);
    // The tab passed over meanwhile is skipped, not switched to on the way.
    expect(s.calls).toEqual(["b", "d"]);
  });

  it("goes back to cycling from the active tab once the presses are done", async () => {
    const tabs = ["a", "b", "c"];
    const s = slowSwitches("a");
    const cycle = tabCycler(s.active, s.switchTo);
    cycle(tabs, -1);
    await s.settle();
    cycle(tabs, -1);
    await s.settle();
    expect(s.calls).toEqual(["c", "b"]);
  });
});
