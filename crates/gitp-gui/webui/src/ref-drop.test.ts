import { describe, expect, it } from "vitest";

import { dropActions, isAncestorInRows, type DropRef } from "./ref-drop";
import type { CommitRow } from "./types";

const row = (id: string, parents: string[]): CommitRow => ({
  id,
  short_id: id,
  summary: id,
  author_name: "",
  author_email: "",
  time: 0,
  parents,
  lane: 0,
  color: 0,
});

// d is a merge of b and c; both come from a. Newest first, as the log is.
const rows = [row("d", ["b", "c"]), row("c", ["a"]), row("b", ["a"]), row("a", [])];

describe("isAncestorInRows", () => {
  it("follows every parent, merges included", () => {
    expect(isAncestorInRows(rows, "a", "d")).toBe(true);
    expect(isAncestorInRows(rows, "c", "d")).toBe(true);
    expect(isAncestorInRows(rows, "b", "c")).toBe(false);
    expect(isAncestorInRows(rows, "d", "a")).toBe(false);
  });

  it("is false for commits that aren't loaded", () => {
    expect(isAncestorInRows(rows, "zz", "d")).toBe(false);
    expect(isAncestorInRows(rows, "a", "zz")).toBe(false);
  });
});

const local = (name: string, target: string): DropRef => ({ kind: "local", name, target });
const remote = (name: string, target: string): DropRef => ({ kind: "remote", name, target });
const ancestry = (a: string, d: string) => isAncestorInRows(rows, a, d);

describe("dropActions", () => {
  it("merges a branch dropped on the checked-out one", () => {
    expect(dropActions(local("feature", "c"), local("main", "b"), "main", ancestry)).toEqual(["merge"]);
    expect(dropActions(remote("origin/feature", "c"), local("main", "b"), "main", ancestry)).toEqual(["merge"]);
  });

  it("rebases or resets the checked-out branch when it is the one dragged", () => {
    expect(dropActions(local("main", "b"), local("feature", "c"), "main", ancestry)).toEqual([
      "rebase",
      "interactive-rebase",
      "reset",
    ]);
  });

  it("fast-forwards the target only when it is behind the dragged branch", () => {
    expect(dropActions(local("next", "d"), local("old", "a"), "main", ancestry)).toEqual(["fast-forward"]);
    expect(dropActions(local("old", "a"), local("next", "d"), "main", ancestry)).toEqual([]);
    // Dragged onto the current branch, which is behind: merge or fast-forward.
    expect(dropActions(remote("origin/main", "d"), local("main", "b"), "main", ancestry)).toEqual([
      "merge",
      "fast-forward",
    ]);
  });

  it("pushes a local branch dropped on a remote branch", () => {
    expect(dropActions(local("feature", "c"), remote("origin/review", "a"), "main", ancestry)).toEqual(["push"]);
    // Even when they already match: the remote ref may simply be stale.
    expect(dropActions(local("feature", "c"), remote("origin/feature", "c"), "main", ancestry)).toEqual(["push"]);
    // Never the other way round.
    expect(dropActions(remote("origin/review", "a"), remote("origin/x", "c"), "main", ancestry)).toEqual([]);
  });

  it("offers nothing for a branch dropped on itself or on the same commit", () => {
    expect(dropActions(local("main", "b"), local("main", "b"), "main", ancestry)).toEqual([]);
    expect(dropActions(local("main", "b"), local("twin", "b"), "main", ancestry)).toEqual([]);
  });
});
