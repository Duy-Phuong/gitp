import { describe, expect, it } from "vitest";

import { blameLabel, prNumberIn } from "./inline-blame";

describe("prNumberIn", () => {
  it("reads a squash merge's number and a merge commit's", () => {
    expect(prNumberIn("UBIID-9160 | sign8: Exchange code of redirect parameter to Token (#3019)")).toBe(3019);
    expect(prNumberIn("Merge pull request #3538 from mesoneer-ag/feature/x")).toBe(3538);
  });

  it("finds none in a plain commit, or a number in the middle of the subject", () => {
    expect(prNumberIn("Tidy the session service")).toBeNull();
    expect(prNumberIn("Revert (#12) and more")).toBeNull();
  });
});

describe("blameLabel", () => {
  it("says who, when and what, or that the line isn't committed", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(blameLabel({ author: "Huy Vu", email: "", time: now - 60, summary: "Fix it", body: "" })).toMatch(/^Huy Vu, .+ • Fix it$/);
    expect(blameLabel(null)).toBe("You, Not committed yet");
  });
});
