import { describe, expect, it } from "vitest";

import { parseInline, parseMarkdown } from "./markdown-preview";

describe("parseMarkdown", () => {
  it("splits headings, paragraphs, lists and code", () => {
    const src = [
      "# Title #",
      "",
      "First line",
      "second line.",
      "- one",
      "- two",
      "  continued",
      "1. first",
      "2) second",
      "```ts",
      "const x = 1;",
      "",
      "# not a heading",
      "```",
      "### Small",
    ].join("\n");
    expect(parseMarkdown(src)).toEqual([
      { kind: "heading", level: 1, inlines: [{ kind: "text", text: "Title" }] },
      { kind: "paragraph", inlines: [{ kind: "text", text: "First line second line." }] },
      {
        kind: "list",
        ordered: false,
        items: [[{ kind: "text", text: "one" }], [{ kind: "text", text: "two continued" }]],
      },
      {
        kind: "list",
        ordered: true,
        items: [[{ kind: "text", text: "first" }], [{ kind: "text", text: "second" }]],
      },
      { kind: "code", text: "const x = 1;\n\n# not a heading" },
      { kind: "heading", level: 3, inlines: [{ kind: "text", text: "Small" }] },
    ]);
  });

  it("runs an unclosed fence to the end", () => {
    expect(parseMarkdown("~~~\na\n```\nb")).toEqual([{ kind: "code", text: "a\n```\nb" }]);
  });

  it("needs a space after the hashes for a heading", () => {
    expect(parseMarkdown("#hashtag")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "#hashtag" }] },
    ]);
  });
});

describe("parseInline", () => {
  it("finds code, emphasis and links", () => {
    expect(parseInline("a `b*c*` **d** _e_ *f* [g](https://x.io) h")).toEqual([
      { kind: "text", text: "a " },
      { kind: "code", text: "b*c*" },
      { kind: "text", text: " " },
      { kind: "strong", text: "d" },
      { kind: "text", text: " " },
      { kind: "em", text: "e" },
      { kind: "text", text: " " },
      { kind: "em", text: "f" },
      { kind: "text", text: " " },
      { kind: "link", text: "g", href: "https://x.io" },
      { kind: "text", text: " h" },
    ]);
  });

  it("leaves snake_case and markup-looking text as text", () => {
    expect(parseInline("snake_case_name <b>x</b> 2 * 3 * 4")).toEqual([
      { kind: "text", text: "snake_case_name <b>x</b> 2 * 3 * 4" },
    ]);
  });
});
