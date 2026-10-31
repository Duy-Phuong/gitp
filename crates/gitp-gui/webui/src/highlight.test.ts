import { describe, expect, it } from "vitest";

import { highlighter, hunkRuns, languageFor, overlay, parseHighlighted, splitLines, type Run } from "./highlight";
import { registerAll } from "./highlight-languages";

// The grammars are a lazy chunk in the app; the tests need them up front.
registerAll();

const text = (runs: Run[]) => runs.map((r) => r.text).join("");

describe("languageFor", () => {
  it("goes by extension, case-insensitively", () => {
    expect(languageFor("src/main.rs")).toBe("rust");
    expect(languageFor("web/App.TSX")).toBe("typescript");
    expect(languageFor("a/b/c.yml")).toBe("yaml");
    expect(languageFor("index.html")).toBe("xml");
  });

  it("knows some files by their whole name", () => {
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("docker/Dockerfile.dev")).toBe("dockerfile");
    expect(languageFor("Makefile")).toBe("makefile");
  });

  it("has nothing for unknown or extensionless files and dotfiles", () => {
    expect(languageFor("LICENSE")).toBeNull();
    expect(languageFor("notes.xyz")).toBeNull();
    expect(languageFor(".gitignore")).toBeNull();
  });
});

describe("parseHighlighted", () => {
  it("flattens nested spans into runs with the innermost class and unescapes text", () => {
    const runs = parseHighlighted(
      '<span class="hljs-meta">#<span class="hljs-string">&quot;a&lt;b&quot;</span></span> x &amp;&amp; y',
    );
    expect(runs).toEqual([
      { text: "#", cls: "hljs-meta" },
      { text: '"a<b"', cls: "hljs-string" },
      { text: " x && y", cls: "" },
    ]);
  });
});

describe("splitLines", () => {
  it("cuts runs at line breaks, keeping empty lines", () => {
    const lines = splitLines([
      { text: "/* a\n", cls: "c" },
      { text: "\nb */", cls: "c" },
      { text: " x", cls: "" },
    ]);
    expect(lines).toEqual([[{ text: "/* a", cls: "c" }], [], [{ text: "b */", cls: "c" }, { text: " x", cls: "" }]]);
  });
});

describe("highlighter", () => {
  it("returns one list of runs per line, covering each line's text exactly", () => {
    const hl = highlighter("x.ts")!;
    const lines = ["const s = `a", "b` + 1; // <done>", "", "let t = 'it''s'"];
    const runs = hl(lines)!;
    expect(runs.map(text)).toEqual(lines);
    // The template string spans lines 1–2 and is coloured on both.
    expect(runs[1][0]).toEqual({ text: "b`", cls: "hljs-string" });
  });

  it("is null for a file without a language", () => {
    expect(highlighter("README")).toBeNull();
  });

  it("stops once the file's budget is spent", () => {
    const hl = highlighter("x.js")!;
    const block = (n: number) => Array.from({ length: n / 100 }, () => "x".repeat(99));
    expect(hl(block(300_000))).not.toBeNull();
    expect(hl(block(200_000))).toBeNull();
  });

  it("leaves a block with an overlong line plain", () => {
    const hl = highlighter("x.js")!;
    expect(hl(["let a = 1;", "x".repeat(1001)])).toBeNull();
    expect(hl(["let a = 1;"])).not.toBeNull();
  });
});

describe("hunkRuns", () => {
  it("highlights the old side for deletions and the new side for the rest", () => {
    const seen: string[][] = [];
    const fake = (lines: string[]) => {
      seen.push(lines);
      return lines.map((l) => [{ text: l, cls: `side${seen.length}` }]);
    };
    const runs = hunkRuns(
      [
        { origin: " ", content: "ctx" },
        { origin: "-", content: "old" },
        { origin: "+", content: "new" },
        { origin: ">", content: "\\ No newline at end of file" },
      ],
      fake,
    );
    expect(seen).toEqual([
      ["ctx", "old"],
      ["ctx", "new"],
    ]);
    expect(runs.get(0)).toEqual([{ text: "ctx", cls: "side2" }]);
    expect(runs.get(1)).toEqual([{ text: "old", cls: "side1" }]);
    expect(runs.get(2)).toEqual([{ text: "new", cls: "side2" }]);
    expect(runs.has(3)).toBe(false);
  });
});

describe("overlay", () => {
  it("cuts token runs at word-diff boundaries", () => {
    const runs = [
      { text: "let", cls: "kw" },
      { text: " x = ", cls: "" },
      { text: "42", cls: "num" },
    ];
    const segs = [
      { text: "let x", changed: false },
      { text: " = 4", changed: true },
      { text: "2", changed: false },
    ];
    expect(overlay(runs, segs)).toEqual([
      { seg: segs[0], runs: [{ text: "let", cls: "kw" }, { text: " x", cls: "" }] },
      { seg: segs[1], runs: [{ text: " = ", cls: "" }, { text: "4", cls: "num" }] },
      { seg: segs[2], runs: [{ text: "2", cls: "num" }] },
    ]);
  });
});
