import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Draft } from "./pr-reviews";
import type { BranchReviewData, DiffLine, FileDiff } from "./types";

async function fresh() {
  vi.resetModules();
  return import("./branch-reviews");
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

const line = (origin: string, old_lineno: number | null, new_lineno: number | null, content = "x"): DiffLine => ({ origin, old_lineno, new_lineno, content });

// Lines 3-4 of the old file: 3 stays, 4 goes, three lines come in its place
// and after it.
const moved: FileDiff = {
  path: "src/a.ts",
  old_path: null,
  status: "Modified",
  hunks: [
    {
      header: "@@ -3,2 +3,5 @@",
      lines: [line(" ", 3, 3), line("-", 4, null), line("+", null, 4), line("+", null, 5), line("+", null, 6), line("+", null, 7)],
    },
  ],
};

const draft = (over: Partial<Draft> = {}): Draft => ({
  id: 1,
  path: "src/a.ts",
  line: 10,
  side: "RIGHT",
  body: "b",
  severity: null,
  original: "b",
  status: "pending",
  ...over,
});

describe("branch reviews", () => {
  it("shifts a line past an insertion and marks a removed line moved", async () => {
    const m = await fresh();
    expect(m.remapLine(1, moved)).toBe(1);
    expect(m.remapLine(3, moved), "a context line").toBe(3);
    expect(m.remapLine(4, moved), "the removed line").toBeNull();
    expect(m.remapLine(10, moved)).toBe(13);
    expect(m.remapLine(10, undefined), "the file didn't change").toBe(10);
    const insertOnly: FileDiff = { ...moved, hunks: [{ header: "@@ -5,0 +6,2 @@", lines: [line("+", null, 6), line("+", null, 7)] }] };
    expect(m.remapLine(5, insertOnly)).toBe(5);
    expect(m.remapLine(6, insertOnly)).toBe(8);
  });

  it("never moves a left line, and a deleted or renamed file is followed", async () => {
    const m = await fresh();
    expect(m.placeDraft(draft({ side: "LEFT", line: 4 }), [moved])).toEqual({ path: "src/a.ts", line: 4, side: "LEFT", moved: false });
    expect(m.placeDraft(draft(), [{ ...moved, status: "Deleted" }]).moved).toBe(true);
    expect(m.placeDraft(draft(), [{ ...moved, path: "src/b.ts", old_path: "src/a.ts", status: "Renamed" }])).toEqual({
      path: "src/b.ts",
      line: 13,
      side: "RIGHT",
      moved: false,
    });
  });

  it("moves every right draft when the reviewed head is gone", async () => {
    const m = await fresh();
    expect(m.placeDraft(draft(), null).moved).toBe(true);
    expect(m.placeDraft(draft({ side: "LEFT" }), null).moved).toBe(false);
    expect(m.placeDraft(draft({ path: "", line: 0, topic: "On the change" }), null).moved, "a comment on the whole change").toBe(false);
  });

  it("cuts the hunk around a line from the diff", async () => {
    const m = await fresh();
    expect(m.hunkAround([moved], "src/a.ts", 5, "RIGHT")).toBe("@@ -3,2 +3,5 @@\n x\n-x\n+x\n+x\n+x\n+x");
    expect(m.hunkAround([moved], "src/a.ts", 4, "LEFT")).toContain("@@ -3,2 +3,5 @@");
    expect(m.hunkAround([moved], "src/a.ts", 40, "RIGHT")).toBe("");
    expect(m.hunkAround([moved], "other.ts", 5, "RIGHT")).toBe("");
  });

  it("refuses a fix with its reason, in order", async () => {
    const m = await fresh();
    const data: BranchReviewData = { review: null, head: "h", base: "main", files: [], moves: [], worktree: "/w", dirty: false };
    const s = { ...m.branchState("/r", "feat"), data };
    const ok = { path: "src/a.ts", line: 10, side: "RIGHT" as const, moved: false };
    expect(m.fixDisabledReason(s, draft({ status: "fixed" }), ok)).toBe("Fixed already");
    expect(m.fixDisabledReason(s, draft({ status: "discarded" }), ok)).toBe("Discarded");
    expect(m.fixDisabledReason(s, draft(), { ...ok, moved: true })).toBe("The line moved since the review: run it again");
    expect(m.fixDisabledReason({ ...s, fixing: 2 }, draft(), ok)).toBe("A fix is running on feat");
    expect(m.fixDisabledReason({ ...s, data: { ...data, worktree: null } }, draft(), ok)).toBe("Check feat out first");
    expect(m.fixDisabledReason({ ...s, data: { ...data, dirty: true } }, draft(), ok)).toBe("Commit or stash the changes in /w first");
    expect(m.fixDisabledReason(s, draft({ status: "approved" }), ok)).toBeNull();
  });

  it("remembers the base per repo and branch", async () => {
    const m = await fresh();
    expect(m.loadReviewBase("/r", "feat")).toBeNull();
    m.saveReviewBase("/r", "feat", "origin/develop");
    expect(m.loadReviewBase("/r", "feat")).toBe("origin/develop");
    expect(m.loadReviewBase("/r", "other")).toBeNull();
    expect(m.loadReviewBase("/s", "feat")).toBeNull();
  });

  it("moves a line past the end of a diff that was cut short", async () => {
    const m = await fresh();
    const cut: FileDiff = { ...moved, truncated: true };
    expect(m.remapLine(10, cut), "the rest of the change is unknown").toBeNull();
    expect(m.remapLine(1, cut), "before the kept hunks").toBe(1);
  });

  it("moves a draft a later run no longer found, even once restored", async () => {
    const m = await fresh();
    expect(m.placeDraft(draft({ stale: true }), []).moved).toBe(true);
    expect(m.placeDraft(draft({ stale: true, side: "LEFT" }), []).moved).toBe(true);
  });
});
