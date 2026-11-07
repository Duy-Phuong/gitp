import { describe, expect, it } from "vitest";
import { draftFoldText, firstLine, threadFoldText } from "./comment-fold";

describe("the folded comment line", () => {
  it("starts with the first line of text, without Markdown marks", () => {
    expect(firstLine("\n## Why this?\nmore")).toBe("Why this?");
    expect(firstLine("```ts\ncode\n```")).toBe("code");
    expect(firstLine("- a   list   item")).toBe("a list item");
    expect(firstLine("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("says who, how many and whether it is resolved", () => {
    expect(threadFoldText("rev", "Why?", 0, false)).toBe("rev: Why?");
    expect(threadFoldText("rev", "Why?", 2, true)).toBe("rev: Why? · 3 comments · resolved");
    expect(draftFoldText("nit", "Rename it")).toBe("Draft (nit): Rename it");
    expect(draftFoldText(null, "")).toBe("Draft: (no text)");
  });
});
