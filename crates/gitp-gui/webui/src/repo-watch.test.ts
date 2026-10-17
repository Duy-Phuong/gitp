import { describe, expect, it } from "vitest";

import { watchRefresh } from "./repo-watch";

describe("watchRefresh", () => {
  it("ignores events for inactive tabs and when no repo is open", () => {
    expect(watchRefresh({ path: "/a", kinds: ["refs"] }, "/b")).toBeNull();
    expect(watchRefresh({ path: "/a", kinds: ["refs"] }, "")).toBeNull();
  });

  it("rechecks the open diff, but not history, for working-tree and index changes", () => {
    expect(watchRefresh({ path: "/a", kinds: ["worktree"] }, "/a")).toEqual({ history: false, diff: true });
    expect(watchRefresh({ path: "/a", kinds: ["index"] }, "/a")).toEqual({ history: false, diff: true });
  });

  it("refreshes history when refs or HEAD moved", () => {
    expect(watchRefresh({ path: "/a", kinds: ["index", "refs"] }, "/a")).toEqual({ history: true, diff: true });
    expect(watchRefresh({ path: "/a", kinds: ["head"] }, "/a")).toEqual({ history: true, diff: false });
  });
});
