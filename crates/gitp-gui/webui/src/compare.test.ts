import { describe, expect, it } from "vitest";

import { compareRevs, EMPTY_REV, MOCK_LOG } from "./api";
import { combinedDiffEnds, olderFirst } from "./compare";
import { compareEndLabel } from "./views/detail";

const [g, f, , , , , a] = MOCK_LOG.map((r) => r.id);

describe("olderFirst", () => {
  it("puts the commit further down the newest-first log first", () => {
    expect(olderFirst([g, a], MOCK_LOG)).toEqual([a, g]);
    expect(olderFirst([a, g], MOCK_LOG)).toEqual([a, g]);
  });

  it("treats a commit beyond the loaded rows as the older one", () => {
    expect(olderFirst([g, "x".repeat(40)], MOCK_LOG)).toEqual(["x".repeat(40), g]);
    expect(olderFirst(["y", "x"], MOCK_LOG)).toEqual(["y", "x"]);
  });
});

describe("combinedDiffEnds", () => {
  // MOCK_LOG is newest-first: g merges f and e, f's parent is d, ...
  const row = (id: string) => MOCK_LOG.find((r) => r.id === id)!;
  const oldestFirst = (...ids: string[]) => ids.map(row);

  it("spans a first-parent run from the oldest one's parent to the newest", () => {
    const [d, f2, g2] = [MOCK_LOG[3].id, MOCK_LOG[1].id, MOCK_LOG[0].id];
    expect(row(f2).parents[0]).toBe(d);
    expect(combinedDiffEnds(oldestFirst(d, f2, g2))).toEqual({ base: row(d).parents[0], head: g2 });
  });

  it("diffs from the empty tree when the run starts at a root commit", () => {
    const root = MOCK_LOG[MOCK_LOG.length - 1];
    const child = MOCK_LOG.find((r) => r.parents[0] === root.id)!;
    expect(root.parents).toEqual([]);
    expect(combinedDiffEnds([root, child])).toEqual({ base: EMPTY_REV, head: child.id });
  });

  it("refuses a selection with a gap or on another line of history", () => {
    const [g2, , e] = MOCK_LOG.map((r) => r.id);
    expect(combinedDiffEnds(oldestFirst(a, g2))).toBeNull();
    expect(combinedDiffEnds(oldestFirst(e, g2))).toBeNull(); // e is g's second parent
    expect(combinedDiffEnds(oldestFirst(g2))).toBeNull();
  });
});

describe("compareEndLabel", () => {
  const end = (rev: string) => ({ rev, id: f, short_id: f.slice(0, 7), summary: "" });

  it("names a ref by its name and a commit by its short id", () => {
    expect(compareEndLabel(end("feature/export"))).toBe("feature/export");
    expect(compareEndLabel(end(f))).toBe(f.slice(0, 7));
    expect(compareEndLabel(end(f.slice(0, 10)))).toBe(f.slice(0, 7));
  });
});

// Preview mode compares against the mock log, so the compare view renders
// under plain `vite dev`.
describe("compareRevs in preview mode", () => {
  it("resolves refs and counts how far apart they are", async () => {
    const cmp = await compareRevs("master", "develop/3.33.0", true);
    expect(cmp.base.id).toBe(a);
    expect(cmp.head.id).toBe(g);
    expect([cmp.ahead, cmp.behind]).toEqual([6, 0]);
    expect(cmp.files.length).toBeGreaterThan(0);
  });

  it("finds no differences between a revision and itself", async () => {
    const cmp = await compareRevs("v3.33.0", "HEAD", false);
    expect(cmp.files).toEqual([]);
  });

  it("compares from the empty tree", async () => {
    const cmp = await compareRevs(EMPTY_REV, a, false);
    expect(cmp.base).toMatchObject({ rev: EMPTY_REV, id: "" });
    expect([cmp.ahead, cmp.behind]).toEqual([1, 0]);
  });

  it("rejects an unknown revision", async () => {
    await expect(compareRevs("master", "no-such-ref", false)).rejects.toThrow();
  });
});
