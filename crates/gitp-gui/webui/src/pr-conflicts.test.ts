// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { conflictPreviewBody, diffLineKind } from "./pr-conflicts";
import type { ConflictResolution } from "./types";

const resolution = (over: Partial<ConflictResolution> = {}): ConflictResolution => ({
  worktree: "/wt",
  branch: "feature",
  base: "origin/main",
  before: "abc",
  conflicted: ["src/a.ts"],
  changed: [
    { status: "A", path: "docs/new.md" },
    { status: "M", path: "src/a.ts" },
    { status: "M", path: "src/b.ts" },
  ],
  diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same",
  summary: "Kept **both** sides.",
  ...over,
});

const host = (nodes: Node[]) => {
  const div = document.createElement("div");
  div.append(...nodes);
  return div;
};

describe("the preview of Claude's conflict resolution", () => {
  it("tells diff lines apart", () => {
    expect(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "+new", "-old", " same", ""].map(diffLineKind)).toEqual([
      "file", "file", "file", "hunk", "add", "del", "", "",
    ]);
  });

  it("lists the conflicted files first, marked, then the rest", () => {
    const div = host(conflictPreviewBody(resolution()));
    const rows = [...div.querySelectorAll(".conflict-preview-files li")];
    expect(rows.map((r) => r.querySelector(".conflict-preview-path")!.textContent)).toEqual(["src/a.ts", "docs/new.md", "src/b.ts"]);
    expect(rows.map((r) => r.classList.contains("conflicted"))).toEqual([true, false, false]);
    expect(rows[0].textContent).toContain("resolved by Claude");
    expect(div.textContent).toContain("3 files change on feature · 1 had conflicts");
  });

  it("shows Claude's summary and the colored diff", () => {
    const div = host(conflictPreviewBody(resolution()));
    expect(div.querySelector(".conflict-preview-summary strong")!.textContent).toBe("both");
    const lines = [...div.querySelectorAll(".conflict-preview-diff > div")];
    expect(lines.map((l) => l.className)).toEqual(["d-file", "d-hunk", "d-del", "d-add", "d-ctx"]);
  });

  it("leaves out an empty summary and an empty diff", () => {
    const div = host(conflictPreviewBody(resolution({ summary: " ", diff: "", conflicted: [] })));
    expect(div.querySelector(".conflict-preview-summary")).toBeNull();
    expect(div.querySelector(".conflict-preview-diff")).toBeNull();
  });
});
