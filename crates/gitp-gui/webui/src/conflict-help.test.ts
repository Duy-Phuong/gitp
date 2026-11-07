import { describe, expect, it } from "vitest";
import { conflictPrompt, parseSuggestions, rerereEnabled } from "./conflict-help";

describe("conflictPrompt", () => {
  const ctx = {
    path: "src/app.ts",
    kind: "rebase",
    oursLabel: "main (rebasing onto)",
    theirsLabel: 'your commit abc1234 "fix login"',
    oursCommits: [{ short: "a1", author: "Ada", when: "2 days ago", subject: "rename user" }],
    theirsCommits: [],
  };

  it("names the sides, explains the rebase swap, and lists each conflict with its context", () => {
    const text = conflictPrompt(ctx, [
      { id: 1, before: ["a"], base: ["b"], ours: ["o"], theirs: ["t"], after: ["z"] },
    ]);
    expect(text).toContain("Ours: main (rebasing onto)");
    expect(text).toContain("git swaps the sides");
    expect(text).toContain("- a1 rename user (Ada, 2 days ago)");
    expect(text).toContain("- (none found)");
    expect(text).toContain("### Conflict 1\nBefore (context):\n```\na\n```\nBase (before both sides changed it):\n```\nb\n```");
    expect(text).toContain('{"resolutions":[{"id":1');
  });

  it("says nothing about a swap outside a rebase", () => {
    expect(conflictPrompt({ ...ctx, kind: "merge" }, [])).not.toContain("swaps");
  });
});

describe("parseSuggestions", () => {
  it("reads the JSON out of a fenced answer and skips malformed entries", () => {
    const answer =
      'Here you go:\n```json\n{"resolutions":[{"id":1,"lines":["x","y"],"why":"both"},{"id":"2","lines":[]},{"id":3,"lines":[1]}]}\n```';
    const got = parseSuggestions(answer);
    expect([...got.keys()]).toEqual([1]);
    expect(got.get(1)).toEqual({ lines: ["x", "y"], why: "both" });
  });

  it("fails on an answer with no JSON", () => {
    expect(() => parseSuggestions("I could not do it.")).toThrow(/no suggestions/);
  });
});

describe("rerereEnabled", () => {
  it("takes the most specific scope that sets it", () => {
    expect(rerereEnabled([])).toBe(false);
    expect(rerereEnabled([{ name: "rerere.enabled", value: "true", scope: "Global" }])).toBe(true);
    expect(
      rerereEnabled([
        { name: "rerere.enabled", value: "true", scope: "Global" },
        { name: "rerere.enabled", value: "false", scope: "Local" },
      ]),
    ).toBe(false);
  });
});
