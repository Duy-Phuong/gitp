import { describe, expect, it } from "vitest";

import { movedBetweenPanels } from "./changes";
import type { ChangeKind, FileDiff, StatusLists } from "../types";

// A status-list entry; the optimistic move only ever looks at path and status.
function f(path: string, status: ChangeKind): FileDiff {
  return { path, old_path: null, status, hunks: [] };
}

function lists(staged: FileDiff[], unstaged: FileDiff[]): StatusLists {
  return { staged, unstaged };
}

const paths = (fs: FileDiff[]) => fs.map((x) => x.path);

describe("movedBetweenPanels", () => {
  it("moves a file into the staged panel", () => {
    const out = movedBetweenPanels(lists([], [f("a.ts", "Modified")]), ["a.ts"], "staged");
    expect(paths(out.staged)).toEqual(["a.ts"]);
    expect(out.unstaged).toEqual([]);
  });

  it("moves a file back out to the unstaged panel", () => {
    const out = movedBetweenPanels(lists([f("a.ts", "Modified")], []), ["a.ts"], "unstaged");
    expect(out.staged).toEqual([]);
    expect(paths(out.unstaged)).toEqual(["a.ts"]);
  });

  it("restates an untracked file as Added once staged, and back again", () => {
    const staged = movedBetweenPanels(lists([], [f("new.ts", "Untracked")]), ["new.ts"], "staged");
    expect(staged.staged[0].status).toBe("Added");
    const back = movedBetweenPanels(staged, ["new.ts"], "unstaged");
    expect(back.unstaged[0].status).toBe("Untracked");
  });

  it("keeps every other kind's status on both sides", () => {
    for (const kind of ["Modified", "Deleted", "Renamed", "Copied"] as ChangeKind[]) {
      const out = movedBetweenPanels(lists([], [f("a.ts", kind)]), ["a.ts"], "staged");
      expect(out.staged[0].status).toBe(kind);
    }
  });

  it("does not duplicate a partially-staged file that already has an entry", () => {
    // `a.ts` has staged hunks and unstaged hunks; staging the rest of it leaves
    // one staged row, not two.
    const out = movedBetweenPanels(
      lists([f("a.ts", "Modified")], [f("a.ts", "Modified")]),
      ["a.ts"],
      "staged",
    );
    expect(paths(out.staged)).toEqual(["a.ts"]);
    expect(out.unstaged).toEqual([]);
  });

  it("moves only the named paths and leaves the rest in place", () => {
    const out = movedBetweenPanels(
      lists([], [f("a.ts", "Modified"), f("b.ts", "Modified"), f("c.ts", "Modified")]),
      ["a.ts", "c.ts"],
      "staged",
    );
    expect(paths(out.staged)).toEqual(["a.ts", "c.ts"]);
    expect(paths(out.unstaged)).toEqual(["b.ts"]);
  });

  it("appends after the files already in the destination panel", () => {
    const out = movedBetweenPanels(
      lists([f("z.ts", "Modified")], [f("a.ts", "Modified")]),
      ["a.ts"],
      "staged",
    );
    expect(paths(out.staged)).toEqual(["z.ts", "a.ts"]);
  });

  it("ignores paths that aren't in the source panel", () => {
    const before = lists([], [f("a.ts", "Modified")]);
    const out = movedBetweenPanels(before, ["nope.ts"], "staged");
    expect(out.staged).toEqual([]);
    expect(paths(out.unstaged)).toEqual(["a.ts"]);
  });

  // The rollback path depends on this: runStaging keeps the pre-move arrays as
  // its snapshot, so a failed stage can restore them verbatim.
  it("leaves the input lists untouched", () => {
    const staged: FileDiff[] = [];
    const unstaged = [f("a.ts", "Modified")];
    movedBetweenPanels(lists(staged, unstaged), ["a.ts"], "staged");
    expect(staged).toEqual([]);
    expect(paths(unstaged)).toEqual(["a.ts"]);
  });
});
