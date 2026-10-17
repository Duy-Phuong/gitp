import { describe, expect, it } from "vitest";

import { compareRevs, MOCK_LOG } from "./api";
import { olderFirst } from "./compare";
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

  it("rejects an unknown revision", async () => {
    await expect(compareRevs("master", "no-such-ref", false)).rejects.toThrow();
  });
});
