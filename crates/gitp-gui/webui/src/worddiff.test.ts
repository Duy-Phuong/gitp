import { describe, expect, it } from "vitest";

import {
  hunkWordDiffs,
  MAX_HUNK_LINES,
  MAX_HUNK_WORK,
  MAX_LINE_LENGTH,
  tokenize,
  wordDiff,
  type Seg,
} from "./worddiff";

// Render segments compactly: changed text in [brackets].
const show = (segs: Seg[]) => segs.map((s) => (s.changed ? `[${s.text}]` : s.text)).join("");
const diff = (a: string, b: string) => {
  const wd = wordDiff(a, b);
  return wd && { left: show(wd.left), right: show(wd.right) };
};

describe("tokenize", () => {
  it("splits words, whitespace runs and single punctuation", () => {
    expect(tokenize("let x_1  = foo(a,b);")).toEqual(
      ["let", " ", "x_1", "  ", "=", " ", "foo", "(", "a", ",", "b", ")", ";"],
    );
  });

  it("keeps non-ASCII letters inside words", () => {
    expect(tokenize("café naïve Größe")).toEqual(["café", " ", "naïve", " ", "Größe"]);
    expect(tokenize("café!")).toEqual(["café", "!"]); // combining accent
  });

  it("never splits a surrogate pair or an emoji sequence", () => {
    expect(tokenize("a😀b")).toEqual(["a", "😀", "b"]);
    expect(tokenize("👍🏽👨‍👩‍👧🇩🇪")).toEqual(["👍🏽", "👨‍👩‍👧", "🇩🇪"]);
    expect(tokenize("❤️!")).toEqual(["❤️", "!"]); // variation selector
  });

  it("covers the whole input", () => {
    for (const s of ["", "  \t", "a+=b->c", "x 😀́ y", "́lead", "日本語 テキスト"]) {
      expect(tokenize(s).join("")).toBe(s);
    }
  });
});

describe("wordDiff", () => {
  it("marks nothing for identical lines", () => {
    expect(diff("const a = 1;", "const a = 1;")).toEqual({ left: "const a = 1;", right: "const a = 1;" });
    expect(diff("", "")).toEqual({ left: "", right: "" });
  });

  it("marks only the inserted words", () => {
    expect(diff("foo(a);", "foo(a, b);")).toEqual({ left: "foo(a);", right: "foo(a[, b]);" });
  });

  it("marks only the deleted words", () => {
    expect(diff("foo(a, b);", "foo(a);")).toEqual({ left: "foo(a[, b]);", right: "foo(a);" });
  });

  it("marks a replaced identifier as a whole word", () => {
    expect(diff("let count = items.length;", "let total = items.length;")).toEqual({
      left: "let [count] = items.length;",
      right: "let [total] = items.length;",
    });
  });

  it("marks a whitespace-only change", () => {
    expect(diff("a = b", "a  = b")).toEqual({ left: "a[ ]= b", right: "a[  ]= b" });
    expect(diff("\tx();", "    x();")).toEqual({ left: "[\t]x();", right: "[    ]x();" });
  });

  it("handles unicode and emoji without cutting characters", () => {
    expect(diff('say("héllo 😀")', 'say("héllo 😎")')).toEqual({
      left: 'say("héllo [😀]")',
      right: 'say("héllo [😎]")',
    });
    expect(diff("ok 👍🏻", "ok 👍🏽")).toEqual({ left: "ok [👍🏻]", right: "ok [👍🏽]" });
  });

  it("segments rebuild the original lines", () => {
    const wd = wordDiff("if (a && b) return x;", "if (a || c) return y;")!;
    expect(wd.left.map((s) => s.text).join("")).toBe("if (a && b) return x;");
    expect(wd.right.map((s) => s.text).join("")).toBe("if (a || c) return y;");
  });

  it("falls back to whole-line when the lines are too dissimilar", () => {
    expect(wordDiff("return computeTotal(items);", "throw new Error(msg)")).toBeNull();
    expect(wordDiff("", "something new")).toBeNull();
    expect(wordDiff("x", "x + a much longer expression than before")).toBeNull();
    // Just above the cutoff: 6 of 16 characters unchanged = 0.375.
    expect(wordDiff("abcd = 1", "efgh = 2")).not.toBeNull();
  });

  it("skips very long lines", () => {
    const long = "a ".repeat(MAX_LINE_LENGTH / 2 + 1);
    expect(wordDiff(long, long + "b")).toBeNull();
    expect(wordDiff("short", long)).toBeNull();
  });
});

describe("hunkWordDiffs", () => {
  const ln = (origin: string, content: string) => ({ origin, content });

  it("pairs deletions and additions positionally within a run", () => {
    const words = hunkWordDiffs([
      ln(" ", "ctx"),
      ln("-", "let a = 1;"),
      ln("-", "let b = 2;"),
      ln("+", "let a = 10;"),
      ln("+", "let b = 20;"),
      ln(" ", "ctx"),
    ]);
    expect([...words.keys()].sort()).toEqual([1, 2, 3, 4]);
    expect(show(words.get(1)!)).toBe("let a = [1];");
    expect(show(words.get(3)!)).toBe("let a = [10];");
    expect(show(words.get(2)!)).toBe("let b = [2];");
    expect(show(words.get(4)!)).toBe("let b = [20];");
  });

  it("leaves the extra lines of an uneven run unmarked", () => {
    const words = hunkWordDiffs([
      ln("-", "foo(1);"),
      ln("+", "foo(2);"),
      ln("+", "bar(3);"),
      ln("+", "baz(4);"),
      ln(" ", "ctx"),
      ln("-", "x = 1;"),
      ln("-", "y = 2;"),
      ln("+", "x = 3;"),
    ]);
    expect([...words.keys()].sort()).toEqual([0, 1, 5, 7]);
    expect(show(words.get(1)!)).toBe("foo([2]);");
    expect(show(words.get(7)!)).toBe("x = [3];");
  });

  it("does not pair across context lines", () => {
    const words = hunkWordDiffs([ln("-", "foo(1);"), ln(" ", "ctx"), ln("+", "foo(2);")]);
    expect(words.size).toBe(0);
  });

  it("omits pairs that are too dissimilar but keeps the others", () => {
    const words = hunkWordDiffs([
      ln("-", "alpha();"),
      ln("-", "count += 1;"),
      ln("+", "something entirely different"),
      ln("+", "count += 2;"),
    ]);
    expect([...words.keys()].sort()).toEqual([1, 3]);
  });

  it("skips huge hunks entirely", () => {
    const lines = Array.from({ length: MAX_HUNK_LINES + 1 }, (_, k) =>
      ln(k % 2 ? "+" : "-", `value = ${k};`),
    );
    expect(hunkWordDiffs(lines).size).toBe(0);
    expect(hunkWordDiffs(lines.slice(0, 4)).size).toBe(4);
  });

  it("stops word-diffing a hunk once its work budget is spent", () => {
    const long = (c: string) => `${c.repeat(900)} tail`;
    const pairs = Math.ceil(MAX_HUNK_WORK / (905 * 905)) + 5;
    const lines = Array.from({ length: pairs }, () => ln("-", long("a"))).concat(
      Array.from({ length: pairs }, () => ln("+", long("a").replace("tail", "end"))),
    );
    const marked = hunkWordDiffs(lines).size / 2;
    expect(marked).toBeGreaterThan(0);
    expect(marked).toBeLessThan(pairs);
  });
});
