import { describe, expect, it } from "vitest";

import { bisectBannerText } from "./bisect-text";
import type { BisectStatus } from "./types";

function status(over: Partial<BisectStatus> = {}): BisectStatus {
  return {
    bad: "b".repeat(40),
    good: ["a".repeat(40)],
    skipped: [],
    current: "c".repeat(40),
    current_summary: "feat: add config loader",
    remaining_estimate: [7, 3],
    first_bad: null,
    first_bad_summary: null,
    original_ref: "main",
    ...over,
  };
}

describe("bisectBannerText", () => {
  it("shows the estimate and the commit under test", () => {
    expect(bisectBannerText(status())).toEqual({
      title: "Bisecting — ~7 revisions left (~3 steps)",
      sub: "Testing ccccccc feat: add config loader",
    });
  });

  it("uses the singular for one revision and one step", () => {
    expect(bisectBannerText(status({ remaining_estimate: [1, 1] })).title).toBe(
      "Bisecting — ~1 revision left (~1 step)",
    );
  });

  it("asks for whichever end is still missing", () => {
    expect(bisectBannerText(status({ good: [], remaining_estimate: null })).title).toBe(
      "Bisecting — mark a good commit",
    );
    expect(bisectBannerText(status({ bad: null, remaining_estimate: null })).title).toBe(
      "Bisecting — mark a bad commit",
    );
  });

  it("names the first bad commit once found", () => {
    const st = status({ first_bad: "b".repeat(40), first_bad_summary: "fix: broke it", remaining_estimate: null });
    expect(bisectBannerText(st)).toEqual({ title: "First bad commit: bbbbbbb", sub: "fix: broke it" });
  });
});
