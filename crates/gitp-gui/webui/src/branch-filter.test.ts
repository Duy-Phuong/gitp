import { describe, expect, it } from "vitest";

import { matchBranches } from "./branch-filter";

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
