import { describe, expect, it } from "vitest";

import { parseConflictRegions } from "./conflict";

describe("parseConflictRegions", () => {
  it("returns nothing for text without markers", () => {
    expect(parseConflictRegions("a\nb\nc\n")).toEqual([]);
  });

  it("captures ours and theirs and a splice range for one conflict", () => {
    const text = ["top", "<<<<<<< HEAD", "ours1", "ours2", "=======", "theirs1", ">>>>>>> other", "bottom", ""].join(
      "\n",
    );
    const regions = parseConflictRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0].ours).toBe("ours1\nours2\n");
    expect(regions[0].theirs).toBe("theirs1\n");
    // The range covers exactly the marker block, so replacing it drops the markers.
    const spliced = text.slice(0, regions[0].start) + regions[0].ours + text.slice(regions[0].end);
    expect(spliced).toBe("top\nours1\nours2\nbottom\n");
  });

  it("ignores the diff3 base section", () => {
    const text = ["<<<<<<< HEAD", "ours", "||||||| base", "orig", "=======", "theirs", ">>>>>>> x", ""].join("\n");
    const [r] = parseConflictRegions(text);
    expect(r.ours).toBe("ours\n");
    expect(r.theirs).toBe("theirs\n");
  });

  it("finds multiple conflicts", () => {
    const text = [
      "<<<<<<< HEAD",
      "a",
      "=======",
      "b",
      ">>>>>>> x",
      "mid",
      "<<<<<<< HEAD",
      "c",
      "=======",
      "d",
      ">>>>>>> x",
      "",
    ].join("\n");
    expect(parseConflictRegions(text)).toHaveLength(2);
  });
});
