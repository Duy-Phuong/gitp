import { describe, expect, it } from "vitest";

import { isActionable, movedBetweenPanels, sameDiff, templateMessage } from "./changes";
import type { ChangeKind, FileDiff, StatusLists } from "../types";

// A status-list entry; the optimistic move only ever looks at path and status.
function f(path: string, status: ChangeKind): FileDiff {
  return { path, old_path: null, status, hunks: [] };
}

function lists(staged: FileDiff[], unstaged: FileDiff[]): StatusLists {
  return { staged, unstaged };
}

const paths = (fs: FileDiff[]) => fs.map((x) => x.path);

describe("movedBetweenPanels", () => {
  it("moves a file into the staged panel", () => {
    const out = movedBetweenPanels(lists([], [f("a.ts", "Modified")]), ["a.ts"], "staged");
    expect(paths(out.staged)).toEqual(["a.ts"]);
    expect(out.unstaged).toEqual([]);
  });

  it("moves a file back out to the unstaged panel", () => {
    const out = movedBetweenPanels(lists([f("a.ts", "Modified")], []), ["a.ts"], "unstaged");
    expect(out.staged).toEqual([]);
    expect(paths(out.unstaged)).toEqual(["a.ts"]);
  });

  it("restates an untracked file as Added once staged, and back again", () => {
    const staged = movedBetweenPanels(lists([], [f("new.ts", "Untracked")]), ["new.ts"], "staged");
    expect(staged.staged[0].status).toBe("Added");
    const back = movedBetweenPanels(staged, ["new.ts"], "unstaged");
    expect(back.unstaged[0].status).toBe("Untracked");
  });

  it("keeps every other kind's status on both sides", () => {
    for (const kind of ["Modified", "Deleted", "Renamed", "Copied"] as ChangeKind[]) {
      const out = movedBetweenPanels(lists([], [f("a.ts", kind)]), ["a.ts"], "staged");
      expect(out.staged[0].status).toBe(kind);
    }
  });

  it("does not duplicate a partially-staged file that already has an entry", () => {
    // `a.ts` has staged hunks and unstaged hunks; staging the rest of it leaves
    // one staged row, not two.
    const out = movedBetweenPanels(
      lists([f("a.ts", "Modified")], [f("a.ts", "Modified")]),
      ["a.ts"],
      "staged",
    );
    expect(paths(out.staged)).toEqual(["a.ts"]);
    expect(out.unstaged).toEqual([]);
  });

  it("moves only the named paths and leaves the rest in place", () => {
    const out = movedBetweenPanels(
      lists([], [f("a.ts", "Modified"), f("b.ts", "Modified"), f("c.ts", "Modified")]),
      ["a.ts", "c.ts"],
      "staged",
    );
    expect(paths(out.staged)).toEqual(["a.ts", "c.ts"]);
    expect(paths(out.unstaged)).toEqual(["b.ts"]);
  });

  it("appends after the files already in the destination panel", () => {
    const out = movedBetweenPanels(
      lists([f("z.ts", "Modified")], [f("a.ts", "Modified")]),
      ["a.ts"],
      "staged",
    );
    expect(paths(out.staged)).toEqual(["z.ts", "a.ts"]);
  });

  it("ignores paths that aren't in the source panel", () => {
    const before = lists([], [f("a.ts", "Modified")]);
    const out = movedBetweenPanels(before, ["nope.ts"], "staged");
    expect(out.staged).toEqual([]);
    expect(paths(out.unstaged)).toEqual(["a.ts"]);
  });

  // The rollback path depends on this: runStaging keeps the pre-move arrays as
  // its snapshot, so a failed stage can restore them verbatim.
  it("leaves the input lists untouched", () => {
    const staged: FileDiff[] = [];
    const unstaged = [f("a.ts", "Modified")];
    movedBetweenPanels(lists(staged, unstaged), ["a.ts"], "staged");
    expect(staged).toEqual([]);
    expect(paths(unstaged)).toEqual(["a.ts"]);
  });
});

describe("isActionable", () => {
  it("lets every ordinary change be staged, unstaged or discarded", () => {
    for (const kind of ["Added", "Modified", "Deleted", "Renamed", "Copied", "Untracked", "Other"] as ChangeKind[]) {
      expect(isActionable(kind)).toBe(true);
    }
  });

  it("keeps an unmerged file out of staging — it belongs to the conflict view", () => {
    expect(isActionable("Conflicted")).toBe(false);
  });

  it("treats a path with no status (not a changed file) as not actionable", () => {
    expect(isActionable(undefined)).toBe(false);
  });
});

describe("sameDiff", () => {
  const diff = (content: string, newLine = 1): FileDiff => ({
    path: "a.txt",
    old_path: null,
    status: "Modified",
    hunks: [
      {
        header: "@@ -1 +1 @@",
        lines: [
          { origin: "-", old_lineno: 1, new_lineno: null, content: "old" },
          { origin: "+", old_lineno: null, new_lineno: newLine, content },
        ],
      },
    ],
  });

  it("treats a re-fetched identical diff as the same", () => {
    expect(sameDiff(diff("new"), diff("new"))).toBe(true);
    expect(sameDiff(null, null)).toBe(true);
  });

  it("notices a changed line, a moved line and a missing diff", () => {
    expect(sameDiff(diff("new"), diff("newer"))).toBe(false);
    expect(sameDiff(diff("new"), diff("new", 2))).toBe(false);
    expect(sameDiff(diff("new"), null)).toBe(false);
  });

  it("notices an added hunk", () => {
    const more = diff("new");
    more.hunks.push({ header: "@@ -9 +9 @@", lines: [] });
    expect(sameDiff(diff("new"), more)).toBe(false);
  });
});

describe("templateMessage", () => {
  it("splits the first line off as the subject and drops comment lines", () => {
    expect(templateMessage("feat: \n\n# Why?\nRefs: \n# trailing hint\n")).toEqual({
      subject: "feat: ",
      body: "Refs:",
    });
  });

  it("keeps an empty subject when the template starts with the body", () => {
    expect(templateMessage("\n\nTicket: \n")).toEqual({ subject: "", body: "Ticket:" });
  });

  it("is null for a template of only comments and blank lines", () => {
    expect(templateMessage("\n# Subject line\n#\n# Body\n\n")).toBeNull();
  });

  it("handles CRLF line endings", () => {
    expect(templateMessage("fix: \r\n# hint\r\n\r\nBody\r\n")).toEqual({ subject: "fix: ", body: "Body" });
  });
});
