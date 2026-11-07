import { describe, expect, it } from "vitest";

import { ciLabel, ciNote, ciTitle, type BranchCi } from "./ci-status";

const ci = (state: BranchCi["state"], sha = "abc1234def"): BranchCi => ({ state, sha, url: "u", workflow: "CI", title: "fix: things" });

describe("the CI badge", () => {
  it("says passed, failed or running, and nothing without a run", () => {
    expect(ciLabel(ci("success"))).toBe("CI ✓");
    expect(ciLabel(ci("failure"))).toBe("CI ✗");
    expect(ciLabel(ci("running"))).toBe("CI …");
    expect(ciLabel(ci("none"))).toBeNull();
    expect(ciTitle(ci("failure"), "main")).toBe("CI failed on main: CI · fix: things (abc1234). Click to open the run.");
  });
});

describe("the CI notification", () => {
  it("tells a failure once per commit", () => {
    expect(ciNote(ci("running"), ci("failure"), "main")).toEqual({ title: "CI failed on main", body: "CI · fix: things (abc1234)" });
    expect(ciNote(ci("failure"), ci("failure"), "main")).toBeNull();
    expect(ciNote(ci("failure", "old0000"), ci("failure"), "main")).not.toBeNull();
  });

  it("says nothing for a pass, a run, or the first look", () => {
    expect(ciNote(ci("running"), ci("success"), "main")).toBeNull();
    expect(ciNote(null, ci("failure"), "main")).toBeNull();
  });
});
