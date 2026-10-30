import { describe, expect, it } from "vitest";

import { acceptLines, assembleLines, diff3, parseConflictRegions, splitLines, takeSideWarning } from "./conflict";
import type { Diff3Chunk } from "./conflict";

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

describe("assembleLines", () => {
  const chunks: Diff3Chunk[] = [
    { kind: "stable", lines: ["a"] },
    { kind: "changed", base: ["x"], ours: ["OURS"], theirs: ["THEIRS"], conflict: true, auto: null },
    { kind: "stable", lines: ["b"] },
  ];

  it("splices resolutions between stable lines and keeps the trailing newline", () => {
    expect(assembleLines(chunks, [["OURS"]], true)).toBe("a\nOURS\nb\n");
  });

  it("omits the trailing newline when neither side had one", () => {
    expect(assembleLines(chunks, [["THEIRS"]], false)).toBe("a\nTHEIRS\nb");
  });

  it("returns an empty string for an empty result", () => {
    expect(assembleLines([], [], true)).toBe("");
  });

  it("round-trips splitLines of a blob ending in a newline", () => {
    const blob = "a\nb\n";
    const c = diff3(splitLines(blob), splitLines(blob), splitLines(blob));
    expect(assembleLines(c, [], blob.endsWith("\n"))).toBe(blob);
  });
});

describe("acceptLines", () => {
  it("appends a side once and records it", () => {
    const accepted = new Set<"ours" | "theirs">();
    expect(acceptLines(null, accepted, "ours", ["O"])).toEqual(["O"]);
    expect(accepted.has("ours")).toBe(true);
  });

  it("ignores a repeat of the same side", () => {
    const accepted = new Set<"ours" | "theirs">();
    const once = acceptLines(null, accepted, "ours", ["O"]);
    expect(acceptLines(once, accepted, "ours", ["O"])).toEqual(["O"]);
  });

  it("appends the other side after the first (ours then theirs)", () => {
    const accepted = new Set<"ours" | "theirs">();
    const o = acceptLines(null, accepted, "ours", ["O"]);
    expect(acceptLines(o, accepted, "theirs", ["T"])).toEqual(["O", "T"]);
    expect([...accepted].sort()).toEqual(["ours", "theirs"]);
  });
});

describe("takeSideWarning", () => {
  it("asks nothing when the file is as git wrote it and no choices are pending", () => {
    expect(takeSideWarning("a.png", true, false, false)).toBeNull();
  });

  it("names what taking the side would discard", () => {
    expect(takeSideWarning("a.txt", false, true, false)).toContain("edits made to the file on disk");
    const both = takeSideWarning("a.txt", true, true, true)!;
    expect(both).toContain("Take ours for a.txt?");
    expect(both).toContain("on disk and the choices made for it here");
  });
});
