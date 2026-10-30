import { describe, expect, it } from "vitest";

import { tabNumber } from "./terminal-text";

describe("tabNumber", () => {
  it("counts from 1", () => {
    expect(tabNumber([])).toBe(1);
    expect(tabNumber([1, 2])).toBe(3);
  });

  it("reuses the lowest free number", () => {
    expect(tabNumber([1, 3])).toBe(2);
    expect(tabNumber([2])).toBe(1);
  });
});
