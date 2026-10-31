import { describe, expect, it } from "vitest";

import { fuzzyMatch, rankFuzzy } from "./fuzzy";

const order = (query: string, paths: string[]) => rankFuzzy(query, paths, (p) => p).map((r) => r.item);

describe("fuzzyMatch", () => {
  it("consecutive runs score higher than scattered letters", () => {
    expect(order("car", ["c/a/r.ts", "cart.ts"])).toEqual(["cart.ts", "c/a/r.ts"]);
  });

  it("a hit in the file name beats one in a directory", () => {
    expect(order("cart", ["cart/index.ts", "src/cart.ts"])).toEqual(["src/cart.ts", "cart/index.ts"]);
  });

  it("is null when the query is not a subsequence", () => {
    expect(fuzzyMatch("xyz", "cart.ts")).toBeNull();
    expect(fuzzyMatch("tsc", "cart.ts")).toBeNull();
  });

  it("an empty query matches everything with zero", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("reports the matched positions, case-insensitively, preferring segment starts", () => {
    expect(fuzzyMatch("CT", "cart.ts")?.positions).toEqual([0, 5]);
    expect(fuzzyMatch("CAR", "cart.ts")?.positions).toEqual([0, 1, 2]);
  });
});

describe("rankFuzzy", () => {
  it("drops non-matches, sorts best first and limits", () => {
    const files = ["a.ts", "b.ts", "cart.ts", "chart.ts", "zz.md"];
    const ranked = rankFuzzy("art", files, (p) => p, 1);
    expect(ranked.map((r) => r.item)).toEqual(["cart.ts"]);
    expect(rankFuzzy("art", files, (p) => p).map((r) => r.item)).toEqual(["cart.ts", "chart.ts"]);
  });

  it("prefers the shorter path on an equal score", () => {
    expect(order("ab", ["ab/x/ab.ts", "ab.ts"])).toEqual(["ab.ts", "ab/x/ab.ts"]);
  });
});
