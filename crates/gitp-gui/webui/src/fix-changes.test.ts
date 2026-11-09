// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { commitDiffLines, expandFixChanges, fixChangesNode } from "./fix-changes";
import type { CommitDetail } from "./types";

const detail: CommitDetail = {
  id: "abc1234def",
  summary: "fix(review): src/a.ts:3 — x",
  message: "",
  author_name: "T",
  author_email: "t@example.com",
  author_time: 0,
  parents: ["p"],
  files: [
    {
      path: "src/a.ts",
      old_path: null,
      status: "Modified",
      hunks: [
        {
          header: "@@ -1,2 +1,2 @@\n",
          lines: [
            { origin: " ", old_lineno: 1, new_lineno: 1, content: "keep\n" },
            { origin: "-", old_lineno: 2, new_lineno: null, content: "old\n" },
            { origin: "+", old_lineno: null, new_lineno: 2, content: "new\n" },
          ],
        },
      ],
    },
  ],
};

describe("a fix's changes under its turn", () => {
  it("lays the commit out as diff lines, each with its look", () => {
    expect(commitDiffLines(detail)).toEqual([
      { kind: "file", text: "src/a.ts" },
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      { kind: "ctx", text: " keep" },
      { kind: "del", text: "-old" },
      { kind: "add", text: "+new" },
    ]);
  });

  it("is folded until asked for, reads the commit once, and opens it in History", async () => {
    const asked: string[] = [];
    const opened: string[] = [];
    const node = fixChangesNode("c0ffee1", "/w/mideal-wt-9674", (c) => (asked.push(c), Promise.resolve(detail)), (c) => opened.push(c));
    expect(node.textContent).toContain("Commit c0ffee1 in mideal-wt-9674");
    expect(node.querySelector(".fix-changes-body")).toBeNull();
    node.querySelector<HTMLElement>(".fix-changes-toggle")!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(node.textContent).toContain("1 file changed");
    expect([...node.querySelectorAll(".conflict-preview-diff .d-add")].map((l) => l.textContent)).toEqual(["+new"]);
    node.querySelector<HTMLElement>(".fix-changes-toggle")!.click();
    node.querySelector<HTMLElement>(".fix-changes-toggle")!.click();
    expect(asked).toEqual(["c0ffee1"]);
    [...node.querySelectorAll("button")].find((b) => b.textContent === "Open in History")!.click();
    expect(opened).toEqual(["c0ffee1"]);
  });

  it("opens at once for a commit the fix's toast asked to show", () => {
    expandFixChanges("beef123");
    const node = fixChangesNode("beef123", null, () => Promise.resolve(detail));
    expect(node.querySelector(".fix-changes-body")).not.toBeNull();
  });
});
