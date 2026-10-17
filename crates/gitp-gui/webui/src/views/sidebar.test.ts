import { describe, expect, it } from "vitest";

import { siblingWorktreePath, worktreeName } from "./sidebar";
import type { Worktree } from "../types";

const wt = (path: string): Worktree => ({
  path,
  head: null,
  branch: null,
  is_main: false,
  is_current: false,
  locked: false,
  lock_reason: null,
  prunable: false,
});

describe("worktreeName", () => {
  it("is the worktree's folder name", () => {
    expect(worktreeName(wt("/Users/you/code/app-feature"))).toBe("app-feature");
    expect(worktreeName(wt("/Users/you/code/app/"))).toBe("app");
  });
});

describe("siblingWorktreePath", () => {
  it("puts the worktree beside the repo, named after it and the branch", () => {
    expect(siblingWorktreePath("/Users/you/code/app", "fix")).toBe("../app-fix");
  });

  it("flattens the branch's slashes so it isn't a nested folder", () => {
    expect(siblingWorktreePath("/Users/you/code/app", "feature/login/form")).toBe("../app-feature-login-form");
  });
});
