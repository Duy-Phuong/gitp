import { describe, expect, it } from "vitest";

import { previewSummary } from "./merge-preview";

describe("previewSummary", () => {
  it("gives a clean merge the all-clear", () => {
    expect(previewSummary({ clean: true, conflicts: [] })).toBe("No conflicts expected");
  });

  it("names the conflicting files, up to three", () => {
    expect(previewSummary({ clean: false, conflicts: ["a.rs"] })).toBe("⚠ 1 file would conflict: a.rs");
    expect(previewSummary({ clean: false, conflicts: ["a", "b", "c", "d", "e"] })).toBe("⚠ 5 files would conflict: a, b, c +2 more");
  });

  it("says when the check itself failed, rather than implying a clean merge", () => {
    expect(previewSummary(null)).toBe("Couldn't check for conflicts");
  });
});
