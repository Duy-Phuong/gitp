import { describe, expect, it } from "vitest";

import { isDivergedPull } from "./pull-diverged";

describe("a pull that stops on diverged branches", () => {
  it("is told by git's own words", () => {
    // git 2.54, with no pull.rebase or pull.ff set.
    expect(isDivergedPull("hint: You have divergent branches and need to specify how to reconcile them.\nfatal: Need to specify how to reconcile divergent branches.")).toBe(true);
  });

  it("is not any other failure of a pull", () => {
    expect(isDivergedPull("fatal: Not possible to fast-forward, aborting.")).toBe(false);
    expect(isDivergedPull("CONFLICT (content): Merge conflict in a.txt")).toBe(false);
  });
});
