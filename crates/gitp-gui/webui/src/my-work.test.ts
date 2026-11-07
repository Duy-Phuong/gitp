import { describe, expect, it } from "vitest";

import { sinceChoices } from "./my-work";

// Local dates, as the menu shows them.
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 9, 30);

describe("the days What did I do offers", () => {
  it("starts from yesterday, and from Friday on a Monday", () => {
    expect(sinceChoices(at(2026, 11, 5))[0]).toEqual({ label: "Since yesterday", day: "2026-11-04" });
    expect(sinceChoices(at(2026, 11, 9))[0]).toEqual({ label: "Since Friday", day: "2026-11-06" });
  });

  it("also offers the last week and two, across a month's start", () => {
    expect(sinceChoices(at(2026, 12, 3)).slice(1)).toEqual([
      { label: "Last 7 days", day: "2026-11-26" },
      { label: "Last 14 days", day: "2026-11-19" },
    ]);
  });
});
