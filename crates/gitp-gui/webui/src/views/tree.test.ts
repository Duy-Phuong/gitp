import { describe, expect, it } from "vitest";

import { folderCheckState } from "./tree";

describe("folderCheckState", () => {
  const files = ["a.txt", "b.txt", "c.txt"];

  it("is unchecked when none of the descendants are checked", () => {
    expect(folderCheckState(files, new Set())).toEqual({ checked: false, indeterminate: false });
  });

  it("is fully checked only when every descendant is checked", () => {
    expect(folderCheckState(files, new Set(files))).toEqual({ checked: true, indeterminate: false });
  });

  it("is indeterminate when some but not all are checked", () => {
    expect(folderCheckState(files, new Set(["a.txt"]))).toEqual({
      checked: false,
      indeterminate: true,
    });
  });

  it("treats an empty folder as unchecked, not fully-checked", () => {
    expect(folderCheckState([], new Set())).toEqual({ checked: false, indeterminate: false });
  });
});
