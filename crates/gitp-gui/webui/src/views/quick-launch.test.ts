import { describe, it, expect } from "vitest";
import { capSections, filterSections, scoreItem, type QuickItem, type QuickSection } from "./quick-launch";

function cmd(label: string, detail?: string): QuickItem {
  return { kind: "command", label, detail, run: () => {} };
}

// The order the palette puts matches in is the whole difference between one
// keystroke and three, so the ranking is pinned by comparison, not by score.
function best(labels: string[], query: string): string {
  const ranked = labels
    .map((l) => ({ l, s: scoreItem(cmd(l), query) }))
    .filter((r): r is { l: string; s: number } => r.s !== null)
    .sort((a, b) => b.s - a.s);
  return ranked[0]?.l ?? "";
}

describe("scoreItem", () => {
  it("matches nothing away and everything on an empty query", () => {
    expect(scoreItem(cmd("Fetch…"), "")).toBe(0);
    expect(scoreItem(cmd("Fetch…"), "   ")).toBe(0);
  });

  it("rejects a query whose characters aren't all there", () => {
    expect(scoreItem(cmd("Fetch…"), "zzz")).toBeNull();
    expect(scoreItem(cmd("Push"), "psx")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(scoreItem(cmd("Checkout Branch"), "CHECKOUT")).not.toBeNull();
  });

  it("ranks a prefix above a mid-word hit", () => {
    expect(best(["Create Branch…", "Checkout Branch"], "branch")).toBe("Create Branch…");
    expect(best(["Local Changes", "Create Branch…"], "cre")).toBe("Create Branch…");
  });

  it("finds a command by its word initials", () => {
    expect(scoreItem(cmd("Checkout Branch"), "cb")).not.toBeNull();
    expect(best(["Checkout Branch", "Create Tag…", "Local Changes"], "cb")).toBe("Checkout Branch");
  });

  it("matches scattered characters, preferring the tightest run", () => {
    expect(best(["Repository Settings…", "Refresh (fetch all remotes)"], "refr")).toBe(
      "Refresh (fetch all remotes)",
    );
  });

  it("ranks a hit in the label above a hit in the dimmed detail", () => {
    const byLabel = scoreItem(cmd("mideal"), "mideal")!;
    const byDetail = scoreItem(cmd("gitp", "~/Documents/developer/mideal"), "mideal")!;
    expect(byLabel).toBeGreaterThan(byDetail);
  });

  it("still finds a repository by its path when the name doesn't match", () => {
    expect(scoreItem(cmd("gitp", "~/private-source/gitp"), "private")).not.toBeNull();
  });
});

describe("filterSections", () => {
  const sections: QuickSection[] = [
    { title: "Recent Repositories", items: [cmd("mideal", "~/dev/mideal")] },
    { title: "Commands", items: [cmd("Checkout Branch"), cmd("Create Tag…"), cmd("Push")] },
  ];

  it("keeps the author's order when there is no query", () => {
    const out = filterSections(sections, "");
    expect(out.map((s) => s.title)).toEqual(["Recent Repositories", "Commands"]);
    expect(out[1].items.map((i) => i.label)).toEqual(["Checkout Branch", "Create Tag…", "Push"]);
  });

  it("drops sections with no match rather than showing an empty heading", () => {
    const out = filterSections(sections, "push");
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Commands");
    expect(out[0].items.map((i) => i.label)).toEqual(["Push"]);
  });

  it("sorts by score within a section", () => {
    const out = filterSections(sections, "che");
    expect(out[0].items.map((i) => i.label)).toEqual(["Checkout Branch"]);
  });

  it("puts the shorter label first when two match the prefix equally well", () => {
    // "c" is as good a prefix of both; the shorter one needs fewer keystrokes
    // to disambiguate, so it should be the one Enter lands on.
    const out = filterSections(sections, "c");
    expect(out[0].items.map((i) => i.label)).toEqual(["Create Tag…", "Checkout Branch"]);
  });

  it("returns nothing at all when the query matches nothing", () => {
    expect(filterSections(sections, "qqqq")).toEqual([]);
  });
});

describe("capSections", () => {
  const mk = (title: string, n: number): QuickSection => ({
    title,
    items: Array.from({ length: n }, (_, i) => cmd(`${title}-${i}`)),
  });

  it("keeps everything when it already fits", () => {
    const out = capSections([mk("a", 3), mk("b", 2)], 200);
    expect(out.reduce((n, s) => n + s.items.length, 0)).toBe(5);
  });

  it("caps the total across sections, not per section", () => {
    const out = capSections([mk("a", 150), mk("b", 150)], 200);
    expect(out.reduce((n, s) => n + s.items.length, 0)).toBe(200);
    expect(out[0].items).toHaveLength(150);
    expect(out[1].items).toHaveLength(50);
  });

  it("drops whole sections once the budget is gone", () => {
    const out = capSections([mk("a", 200), mk("b", 5)], 200);
    expect(out.map((s) => s.title)).toEqual(["a"]);
  });

  it("keeps the best matches — the front of each already-sorted section", () => {
    const out = capSections([mk("a", 10)], 3);
    expect(out[0].items.map((i) => i.label)).toEqual(["a-0", "a-1", "a-2"]);
  });
});
