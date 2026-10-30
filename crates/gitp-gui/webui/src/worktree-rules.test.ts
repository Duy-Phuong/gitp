import { describe, expect, it } from "vitest";

import type { Worktree } from "./types";
import { describeUnsavedWork, hasUnsavedWork, worktreeAtTarget, worktreeDrop } from "./worktree-rules";

const wt = (path: string, branch: string | null): Worktree => ({
  path,
  head: "abc",
  branch,
  is_main: false,
  is_current: false,
  locked: false,
  lock_reason: null,
  prunable: false,
});

describe("worktreeDrop", () => {
  const worktrees = [wt("/r/main", "main"), wt("/r/repo-feat", "feat")];

  it("adds a worktree for a local branch no worktree has", () => {
    expect(worktreeDrop({ kind: "local", name: "topic" }, ["main", "feat", "topic"], worktrees)).toEqual({
      kind: "add",
      branch: "topic",
      target: { kind: "branch", name: "topic" },
    });
  });

  it("opens the worktree that already has the branch", () => {
    expect(worktreeDrop({ kind: "local", name: "feat" }, ["main", "feat"], worktrees)).toEqual({
      kind: "open",
      worktree: worktrees[1],
    });
  });

  it("creates a local branch for a remote one, from it", () => {
    expect(worktreeDrop({ kind: "remote", name: "origin/fix/x" }, ["main"], worktrees, "origin")).toEqual({
      kind: "add",
      branch: "fix/x",
      target: { kind: "new_branch", name: "fix/x", start: "origin/fix/x" },
    });
  });

  it("uses the local branch a remote one already has", () => {
    expect(worktreeDrop({ kind: "remote", name: "origin/topic" }, ["topic"], worktrees, "origin")).toEqual({
      kind: "add",
      branch: "topic",
      target: { kind: "branch", name: "topic" },
    });
    expect(worktreeDrop({ kind: "remote", name: "origin/feat" }, ["feat"], worktrees, "origin").kind).toBe("open");
  });
});

describe("worktreeAtTarget", () => {
  it("is detached without a branch name, a new branch with one", () => {
    expect(worktreeAtTarget("v1.0", "  ")).toEqual({ kind: "detached", rev: "v1.0" });
    expect(worktreeAtTarget("abc123", " hotfix ")).toEqual({ kind: "new_branch", name: "hotfix", start: "abc123" });
  });
});

describe("unsaved work", () => {
  it("is nothing for a clean, pushed worktree", () => {
    const clean = { changed: [], untracked: 0, unpushed: 0 };
    expect(hasUnsavedWork(clean)).toBe(false);
    expect(describeUnsavedWork(clean, "feat")).toBe("");
  });

  it("names the changed files and the unpushed commits", () => {
    const work = { changed: ["a.ts", "new.md"], untracked: 1, unpushed: 2 };
    expect(hasUnsavedWork(work)).toBe(true);
    expect(describeUnsavedWork(work, "feat")).toBe(
      "2 uncommitted changes (1 untracked), deleted with the folder:\n  a.ts\n  new.md\n\n" +
        "2 commits on feat not pushed to any remote.",
    );
  });

  it("caps the file list and words a detached HEAD's commits as orphaned", () => {
    const changed = Array.from({ length: 10 }, (_, i) => `f${i}`);
    const text = describeUnsavedWork({ changed, untracked: 0, unpushed: 1 }, null);
    expect(text).toContain("  f7\n  …and 2 more");
    expect(text).not.toContain("f8");
    expect(text).toContain("1 commit on no branch (detached HEAD)");
  });
});
