import { describe, it, expect } from "vitest";
import {
  folderName,
  groupBySharedRepo,
  parseLocalWorkspaces,
  repoLabel,
  runPool,
  summaryText,
  withRepoMoved,
  withReposAdded,
  withReposRemoved,
  withWorkspaceAdded,
  withWorkspaceDeleted,
  withWorkspaceRenamed,
  workspaceNameError,
  type LocalWorkspace,
} from "./local-workspaces";
import type { RepoSummary } from "./types";

const ws = (name: string, repos: string[] = []): LocalWorkspace => ({ name, repos });

describe("parseLocalWorkspaces", () => {
  it("reads a stored list", () => {
    expect(parseLocalWorkspaces('[{"name":"Work","repos":["/a","/b"]}]')).toEqual([ws("Work", ["/a", "/b"])]);
  });

  it("drops what isn't a workspace, and survives garbage", () => {
    expect(parseLocalWorkspaces('[{"repos":["/a"]},{"name":"X","repos":["/a",3,null]},"str"]')).toEqual([ws("X", ["/a"])]);
    expect(parseLocalWorkspaces("{not json")).toEqual([]);
    expect(parseLocalWorkspaces('{"name":"X"}')).toEqual([]);
    expect(parseLocalWorkspaces(null)).toEqual([]);
  });
});

describe("workspace names", () => {
  const list = [ws("Work"), ws("Home")];

  it("refuses an empty or taken name", () => {
    expect(workspaceNameError(list, "  ")).toMatch(/needs a name/);
    expect(workspaceNameError(list, "Home ")).toMatch(/already/);
    expect(workspaceNameError(list, "Play")).toBeNull();
  });

  it("lets a renamed workspace keep its own name", () => {
    expect(workspaceNameError(list, "Work", "Work")).toBeNull();
    expect(workspaceNameError(list, "Home", "Work")).toMatch(/already/);
  });

  it("adds, renames and deletes by name", () => {
    expect(withWorkspaceAdded(list, " Play ").map((w) => w.name)).toEqual(["Work", "Home", "Play"]);
    expect(withWorkspaceRenamed([ws("Work", ["/a"])], "Work", "Job")).toEqual([ws("Job", ["/a"])]);
    expect(withWorkspaceDeleted(list, "Work")).toEqual([ws("Home")]);
  });
});

describe("a workspace's repos", () => {
  const list = [ws("Work", ["/a", "/b"]), ws("Home", ["/a"])];

  it("adds new folders once, at the end, to that workspace only", () => {
    expect(withReposAdded(list, "Work", ["/b", "/c", "/c"])).toEqual([ws("Work", ["/a", "/b", "/c"]), ws("Home", ["/a"])]);
  });

  it("removes folders from that workspace only", () => {
    expect(withReposRemoved(list, "Work", ["/a"])).toEqual([ws("Work", ["/b"]), ws("Home", ["/a"])]);
  });

  it("moves a located folder in place, or drops it if the new one is already there", () => {
    expect(withRepoMoved(list, "Work", "/a", "/z")).toEqual([ws("Work", ["/z", "/b"]), ws("Home", ["/a"])]);
    expect(withRepoMoved(list, "Work", "/a", "/b")[0]).toEqual(ws("Work", ["/b"]));
  });
});

describe("summaryText", () => {
  const base: RepoSummary = { missing: false, branch: "main", ahead: 0, behind: 0, has_upstream: true, changes: 0, worktree_of: null, common_dir: "/r/.git" };

  it("says how the branch stands against its upstream, and what's changed", () => {
    expect(summaryText(base)).toBe("in sync");
    expect(summaryText({ ...base, ahead: 2, behind: 1, changes: 3 })).toBe("↑2 ↓1 · 3 changed");
    expect(summaryText({ ...base, behind: 4 })).toBe("↓4");
    expect(summaryText({ ...base, has_upstream: false, changes: 1 })).toBe("no upstream · 1 changed");
    expect(summaryText({ ...base, missing: true })).toBe("missing");
  });
});

describe("folderName", () => {
  it("is the last path segment", () => {
    expect(folderName("/Users/me/src/gitp/")).toBe("gitp");
  });
});

describe("runPool", () => {
  it("runs every item, never more than `limit` at once", async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await runPool([1, 2, 3, 4, 5], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      done.push(n);
    });
    expect(peak).toBe(2);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps going past a failure", async () => {
    const done: number[] = [];
    await runPool([1, 2, 3], 1, async (n) => {
      if (n === 2) throw new Error("boom");
      done.push(n);
    });
    expect(done).toEqual([1, 3]);
  });

  it("starts nothing new once stopped", async () => {
    const started: number[] = [];
    let stop = false;
    await runPool(
      [1, 2, 3, 4],
      1,
      async (n) => {
        started.push(n);
        if (n === 2) stop = true;
      },
      () => stop,
    );
    expect(started).toEqual([1, 2]);
  });
});

describe("repoLabel", () => {
  it("is the folder name, prefixed by its repo's for a linked worktree", () => {
    expect(repoLabel("/code/app", null)).toBe("app");
    expect(repoLabel("/code/app-feat", "/code/app")).toBe("app · app-feat");
  });
});

describe("groupBySharedRepo", () => {
  const dirs: Record<string, string> = {
    "/code/app": "/code/app/.git",
    "/code/lib": "/code/lib/.git",
    "/code/app-feat": "/code/app/.git",
    "/code/app-fix": "/code/app/.git",
  };

  it("puts a repo's worktrees with the first of them to appear", () => {
    expect(groupBySharedRepo(["/code/app-feat", "/code/lib", "/code/app", "/code/app-fix"], (p) => dirs[p])).toEqual([
      ["/code/app-feat", "/code/app", "/code/app-fix"],
      ["/code/lib"],
    ]);
  });

  it("leaves a path with no known repository on its own", () => {
    expect(groupBySharedRepo(["/gone", "/code/app", "/also-gone"], (p) => dirs[p])).toEqual([["/gone"], ["/code/app"], ["/also-gone"]]);
  });
});
