import { describe, expect, it } from "vitest";

import { localBranchForRemote, otherWorktreeWith } from "./branch-worktree";
import type { Worktree } from "./types";

const wt = (path: string, branch: string | null, extra: Partial<Worktree> = {}): Worktree => ({
  path,
  head: null,
  branch,
  is_main: false,
  is_current: false,
  locked: false,
  lock_reason: null,
  prunable: false,
  ...extra,
});

describe("otherWorktreeWith", () => {
  const list = [
    wt("/code/app", "main", { is_main: true, is_current: true }),
    wt("/code/app-feat", "feat"),
    wt("/code/app-gone", "old", { prunable: true }),
    wt("/code/app-detached", null),
  ];

  it("finds the other worktree that has the branch", () => {
    expect(otherWorktreeWith("feat", list)?.path).toBe("/code/app-feat");
  });

  it("ignores this worktree, a missing one, and branches checked out nowhere", () => {
    expect(otherWorktreeWith("main", list)).toBeUndefined();
    expect(otherWorktreeWith("old", list)).toBeUndefined();
    expect(otherWorktreeWith("topic", list)).toBeUndefined();
  });
});

describe("localBranchForRemote", () => {
  it("drops the remote's name, which may itself hold a slash", () => {
    expect(localBranchForRemote("origin/feature/x", ["origin"])).toBe("feature/x");
    expect(localBranchForRemote("team/up/fix", ["origin", "team/up"])).toBe("fix");
  });

  it("drops the first segment when no remote matches", () => {
    expect(localBranchForRemote("gone/topic", ["origin"])).toBe("topic");
    expect(localBranchForRemote("plain", [])).toBe("plain");
  });
});
