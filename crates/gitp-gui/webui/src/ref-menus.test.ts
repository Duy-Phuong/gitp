import { describe, expect, it, vi } from "vitest";

import { dropMenuItems, MERGE_MODES, mergeMenuItem, rebaseQuestion, type DropMenuActions } from "./ref-menus";
import type { DropRef } from "./ref-drop";

const local = (name: string, target = "abc"): DropRef => ({ kind: "local", name, target });
const remote = (name: string, target = "def"): DropRef => ({ kind: "remote", name, target });

function actions(): DropMenuActions {
  return { merge: vi.fn(), rebase: vi.fn(), interactiveRebase: vi.fn(), reset: vi.fn(), fastForward: vi.fn(), push: vi.fn() };
}

const labels = (items: ReturnType<typeof dropMenuItems>) => items.map((i) => i.heading ?? i.label);

describe("dropMenuItems", () => {
  it("names the branches in each entry, in the order of the actions", () => {
    const items = dropMenuItems(local("feature"), local("main"), ["merge", "fast-forward"], null, actions());
    expect(labels(items)).toEqual(["Merge feature into main", "Fast-forward main to feature"]);
  });

  it("puts the dry run's verdict above Merge and Rebase, and nowhere else", () => {
    const items = dropMenuItems(local("main"), local("dev"), ["merge", "rebase", "interactive-rebase"], "No conflicts expected", actions());
    expect(labels(items)).toEqual([
      "No conflicts expected",
      "Merge main into dev",
      "No conflicts expected",
      "Rebase main onto dev",
      "Interactive Rebase…",
    ]);
    expect(dropMenuItems(local("main"), local("dev"), ["fast-forward"], "No conflicts expected", actions()).some((i) => i.heading)).toBe(false);
  });

  it("offers the three reset modes under a heading, hard marked as dangerous", () => {
    const act = actions();
    const items = dropMenuItems(local("main"), local("v1"), ["reset"], null, act);
    expect(labels(items)).toEqual(["Reset main to v1", "Soft (keep changes staged)…", "Mixed (keep changes unstaged)…", "Hard (discard changes)…"]);
    expect(items.map((i) => i.danger ?? false)).toEqual([false, false, false, true]);
    items[3].run?.();
    expect(act.reset).toHaveBeenCalledWith("Hard");
  });

  it("runs the handed-in action for each entry", () => {
    const act = actions();
    const items = dropMenuItems(local("feature"), remote("origin/feature"), ["push"], null, act);
    expect(labels(items)).toEqual(["Push feature to origin/feature"]);
    items[0].run?.();
    expect(act.push).toHaveBeenCalledOnce();
    expect(dropMenuItems(local("a"), local("b"), [], null, act)).toEqual([]);
  });
});

describe("rebaseQuestion", () => {
  it("warns about the rewrite, with the verdict when there is one", () => {
    expect(rebaseQuestion("feature", "main", null)).toBe("Rebase feature onto main? This rewrites commits on feature.");
    expect(rebaseQuestion("feature", "main", "⚠ 1 file would conflict: a.rs")).toBe(
      "Rebase feature onto main? This rewrites commits on feature. ⚠ 1 file would conflict: a.rs.",
    );
  });
});

describe("mergeMenuItem", () => {
  it("lists the four merge modes under the branches, and runs with the picked mode", () => {
    const run = vi.fn();
    const item = mergeMenuItem("feature", "main", null, run);
    expect(item.label).toBe("Merge into 'main'");
    expect(item.submenu?.map((i) => i.heading ?? i.label)).toEqual(["Merge feature into main", ...MERGE_MODES.map((m) => m.label)]);
    item.submenu?.[4].run?.();
    expect(run).toHaveBeenCalledWith("Squash");
  });

  it("shows the dry run's verdict as a second heading", () => {
    const item = mergeMenuItem("feature", "main", "No conflicts expected", vi.fn());
    expect(item.submenu?.[1]).toEqual({ heading: "No conflicts expected" });
    expect(item.submenu).toHaveLength(6);
  });
});
