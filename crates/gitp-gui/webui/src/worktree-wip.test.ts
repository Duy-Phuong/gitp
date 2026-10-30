import { describe, expect, it } from "vitest";

import { branchesElsewhere, orderWipRows, otherWipRows, type WipRow } from "./worktree-wip";
import type { Worktree } from "./types";

const wt = (path: string, over: Partial<Worktree> = {}): Worktree => ({
  path,
  head: null,
  branch: null,
  is_main: false,
  is_current: false,
  locked: false,
  lock_reason: null,
  prunable: false,
  ...over,
});

const WORKTREES = [
  wt("/code/app", { is_main: true, is_current: true, head: "h0", branch: "main" }),
  wt("/code/app-feature", { head: "h2", branch: "feature" }),
  wt("/code/app-fix", { head: "h1", branch: "fix" }),
  wt("/code/app-gone", { head: "h1", branch: "gone", prunable: true }),
  wt("/code/app-detached", { head: "h3" }),
];

describe("otherWipRows", () => {
  it("labels each other dirty worktree with its folder name, path, HEAD and count", () => {
    const rows = otherWipRows(WORKTREES, [
      { path: "/code/app-feature", changes: 2 },
      { path: "/code/app-fix", changes: 0 },
      { path: "/code/app-detached", changes: 5 },
    ]);
    expect(rows).toEqual([
      { changes: 2, head: "h2", worktree: { name: "app-feature", path: "/code/app-feature" } },
      { changes: 5, head: "h3", worktree: { name: "app-detached", path: "/code/app-detached" } },
    ]);
  });

  it("leaves out the current worktree, a missing one, and counts for worktrees not listed", () => {
    const rows = otherWipRows(WORKTREES, [
      { path: "/code/app", changes: 4 },
      { path: "/code/app-gone", changes: 1 },
      { path: "/other/repo-wt", changes: 3 },
    ]);
    expect(rows).toEqual([]);
  });
});

describe("orderWipRows", () => {
  const row = (name: string, head: string | null): WipRow => ({
    changes: 1,
    head,
    worktree: { name, path: `/code/${name}` },
  });
  const ids = ["h0", "h1", "h2", "h3"];
  const rowOf = (id: string) => ids.indexOf(id);
  const names = (rows: WipRow[]) => rows.map((r) => r.worktree?.name ?? "current");

  it("keeps the current worktree's row first and the others in the order of their HEADs", () => {
    const current: WipRow = { changes: 3, head: "h2" };
    const rows = orderWipRows(current, [row("c", "h3"), row("a", "h1"), row("b", "h2")], rowOf);
    expect(names(rows)).toEqual(["current", "a", "b", "c"]);
  });

  it("puts HEADs that aren't loaded (or unborn) last, by name, and works with no current row", () => {
    const rows = orderWipRows(null, [row("z", "far"), row("y", null), row("x", "h0")], rowOf);
    expect(names(rows)).toEqual(["x", "y", "z"]);
  });

  it("is just the current row without other worktrees", () => {
    const current: WipRow = { changes: 1, head: "h0" };
    expect(orderWipRows(current, [], rowOf)).toEqual([current]);
    expect(orderWipRows(null, [], rowOf)).toEqual([]);
  });
});

describe("branchesElsewhere", () => {
  it("maps each branch another existing worktree has checked out to its path", () => {
    expect([...branchesElsewhere(WORKTREES)]).toEqual([
      ["feature", "/code/app-feature"],
      ["fix", "/code/app-fix"],
    ]);
  });
});
