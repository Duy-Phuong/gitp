import { describe, expect, it } from "vitest";

import { matchBranches, recentBranches } from "./branch-filter";

const names = ["develop/3.36.0", "feature/UBIID-9538-remove-logic", "feature/UBIID-9543-apply-logic", "master", "pr-3310"];

describe("the Branch menu's filter", () => {
  it("keeps every branch when nothing is typed", () => {
    expect(matchBranches(names, "  ")).toEqual(names);
  });

  it("matches part of a name, in any case", () => {
    expect(matchBranches(names, "ubiid-95")).toEqual(["feature/UBIID-9538-remove-logic", "feature/UBIID-9543-apply-logic"]);
  });

  it("matches each word typed, in any order", () => {
    expect(matchBranches(names, "logic 9543")).toEqual(["feature/UBIID-9543-apply-logic"]);
  });

  it("matches nothing for a name not there", () => {
    expect(matchBranches(names, "release")).toEqual([]);
  });
});

describe("the Branch menu's recent branches", () => {
  const all = ["a", "b", "c", "d", "e", "f", "g"];

  it("are the last ones checked out, newest first, without the current one or gone ones", () => {
    expect(recentBranches(["c", "gone", "a", "f"], all, "c")).toEqual(["a", "f"]);
  });

  it("are five at most", () => {
    expect(recentBranches(["a", "b", "c", "d", "e", "f", "g"], all, "z")).toEqual(["a", "b", "c", "d", "e"]);
  });
});
