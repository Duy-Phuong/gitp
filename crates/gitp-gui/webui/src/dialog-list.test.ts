import { describe, expect, it } from "vitest";
import { dialogList } from "./dialog-list";

describe("dialogList", () => {
  it("names every item of a short list", () => {
    expect(dialogList(["a", "b"], 3)).toBe("a\nb");
  });

  it("names the first items of a long list and counts the rest", () => {
    expect(dialogList(["a", "b", "c", "d", "e"], 3)).toBe("a\nb\nc\n…and 2 more");
  });
});
