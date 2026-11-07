import { describe, expect, it } from "vitest";
import { deletableBranches, formatBytes, worktreeVerdict } from "./storage-model";
import type { Worktree } from "./types";

const wt = (branch: string | null, extra: Partial<Worktree> = {}): Worktree => ({
  path: `/w/${branch}`,
  head: "abc",
  branch,
  is_main: false,
  is_current: false,
  locked: false,
  lock_reason: null,
  prunable: false,
  ...extra,
});
const clean = { changed: [], untracked: 0, unpushed: 0 };

describe("Clean Up Storage", () => {
  it("writes sizes the way Finder does", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(55 * 1024 ** 3)).toBe("55 GB");
  });

  it("removes only worktrees that would lose nothing", () => {
    const merged = new Set(["done"]);
    expect(worktreeVerdict(wt("x"), clean, merged)).toEqual({ safe: true, why: "pushed, nothing uncommitted" });
    expect(worktreeVerdict(wt("done"), { ...clean, unpushed: 3 }, merged)).toEqual({ safe: true, why: "merged, nothing uncommitted" });
    expect(worktreeVerdict(wt("x"), { changed: ["a", "b"], untracked: 1, unpushed: 1 }, merged)).toEqual({
      safe: false,
      why: "2 changed files, 1 untracked file, 1 unpushed commit",
    });
    expect(worktreeVerdict(wt("x", { is_current: true }), clean, merged).safe).toBe(false);
    expect(worktreeVerdict(wt("x", { locked: true }), clean, merged).why).toBe("locked");
  });

  it("offers merged branches no worktree has checked out", () => {
    expect(deletableBranches(["a", "b", "c"], [wt("b"), wt(null)])).toEqual(["a", "c"]);
  });
});
