// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { logRowTop, tagTitle } from "./log";

describe("tagTitle", () => {
  it("is the tag's name, then its annotation when it has one", () => {
    expect(tagTitle("v1.0", null)).toBe("tag v1.0");
    expect(tagTitle("v1.0", undefined)).toBe("tag v1.0");
    expect(tagTitle("v1.0", "First release")).toBe("tag v1.0\n\nFirst release");
  });
});

describe("logRowTop", () => {
  it("grows by one row height per index, from the top before any WIP row", () => {
    expect(logRowTop(0)).toBe(0);
    const rowHeight = logRowTop(1);
    expect(rowHeight).toBeGreaterThan(0);
    expect(logRowTop(5)).toBe(5 * rowHeight);
  });
});
