import { describe, expect, it } from "vitest";

import { diff3, parseConflictRegions, splitLines } from "./conflict";

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

describe("diff3", () => {
  const S = splitLines;

  it("returns one stable chunk when all three are identical", () => {
    const c = diff3(S("a\nb\nc\n"), S("a\nb\nc\n"), S("a\nb\nc\n"));
    expect(c).toEqual([{ kind: "stable", lines: ["a", "b", "c"] }]);
  });

  it("marks a change on only one side as non-conflicting (auto-merged)", () => {
    // Theirs inserted a line; ours unchanged from base.
    const c = diff3(S("a\nb\n"), S("a\nb\n"), S("a\nNEW\nb\n"));
    const changed = c.find((x) => x.kind === "changed");
    expect(changed).toBeTruthy();
    if (changed && changed.kind === "changed") {
      expect(changed.conflict).toBe(false);
      expect(changed.auto).toEqual(["NEW"]);
    }
  });

  it("marks a change on both sides differently as a conflict", () => {
    const c = diff3(S("a\nx\nb\n"), S("a\nOURS\nb\n"), S("a\nTHEIRS\nb\n"));
    const changed = c.find((x) => x.kind === "changed");
    if (changed && changed.kind === "changed") {
      expect(changed.conflict).toBe(true);
      expect(changed.ours).toEqual(["OURS"]);
      expect(changed.theirs).toEqual(["THEIRS"]);
      expect(changed.auto).toBeNull();
    }
  });

  it("treats identical changes on both sides as non-conflicting", () => {
    const c = diff3(S("a\nx\nb\n"), S("a\nY\nb\n"), S("a\nY\nb\n"));
    const changed = c.find((x) => x.kind === "changed");
    if (changed && changed.kind === "changed") {
      expect(changed.conflict).toBe(false);
      expect(changed.auto).toEqual(["Y"]);
    }
  });
});
