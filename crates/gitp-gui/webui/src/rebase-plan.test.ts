import { describe, expect, it } from "vitest";
import {
  autosquash,
  autosquashCount,
  defaultGroupMessage,
  groupHead,
  moveRows,
  planProblem,
  planSteps,
  planSummary,
  squashIntoOne,
  type PlanRow,
} from "./rebase-plan";
import type { RebaseAction } from "./types";

const row = (sha: string, subject: string, action: RebaseAction = "pick"): PlanRow => ({
  commit: { sha: `${sha}000000`, short_sha: sha, subject },
  action,
  message: subject,
  loaded: false,
});
const order = (rows: PlanRow[]) => rows.map((r) => `${r.commit.short_sha}:${r.action}`);

describe("groups and the summary", () => {
  const rows = [row("a", "A"), row("b", "B", "drop"), row("c", "C", "squash"), row("d", "D", "fixup"), row("e", "E")];

  it("links each meld to the nearest earlier commit that lands, past drops", () => {
    expect(groupHead(rows, 2)).toBe(0);
    expect(groupHead(rows, 3)).toBe(0);
    expect(groupHead(rows, 4)).toBe(-1);
  });

  it("counts what the plan produces", () => {
    expect(planSummary(rows)).toEqual({ before: 5, after: 2, dropped: 1, melded: 2 });
  });

  it("combines messages like git: the head, then squashes, not fixups", () => {
    expect(
      defaultGroupMessage("A\n\nbody\n", [
        { action: "squash", message: "C" },
        { action: "fixup", message: "D" },
      ]),
    ).toBe("A\n\nbody\n\nC");
  });
});

describe("planSteps", () => {
  it("sends a reword's message, and a group's edited message on its last meld", () => {
    const rows = [row("a", "A"), row("b", "B", "squash"), row("c", "C", "fixup"), row("d", "D", "reword")];
    rows[3].message = "D2\n\nbody";
    const steps = planSteps(rows, new Map([[rows[0].commit.sha, "A and B"]]));
    expect(steps.map((s) => s.message)).toEqual([null, null, "A and B", "D2\n\nbody"]);
  });
});

describe("planProblem", () => {
  it("blocks a leading meld and empty messages", () => {
    expect(planProblem([row("a", "A", "squash")], new Map(), "Squash")).toMatch(/first applied/);
    const r = row("a", "A", "reword");
    r.loaded = true;
    r.message = "  ";
    expect(planProblem([r], new Map(), "Squash")).toMatch(/new message for a is empty/);
    expect(planProblem([row("a", "A")], new Map(), "Squash")).toBeNull();
  });
});

describe("moving and squashing several rows", () => {
  const rows = ["a", "b", "c", "d"].map((s) => row(s, s.toUpperCase()));

  it("moves the selected rows together, and refuses at an end", () => {
    const moved = moveRows(rows, new Set([1, 3]), -1)!;
    expect(order(moved.rows)).toEqual(["b:pick", "a:pick", "d:pick", "c:pick"]);
    expect([...moved.selected]).toEqual([0, 2]);
    expect(moveRows(rows, new Set([0, 2]), -1)).toBeNull();
  });

  it("gathers the selection under its first row and squashes the rest into it", () => {
    const out = squashIntoOne(rows, new Set([3, 0, 2]))!;
    expect(order(out.rows)).toEqual(["a:pick", "c:squash", "d:squash", "b:pick"]);
    expect([...out.selected]).toEqual([0, 1, 2]);
  });
});

describe("autosquash", () => {
  it("moves fixup!/squash! commits under the commit they name, by subject or sha", () => {
    const rows = [
      row("a1b2", "add login"),
      row("c3d4", "add logout"),
      row("e5f6", "fixup! add login"),
      row("g7h8", "squash! c3d4"),
      row("i9j0", "fixup! fixup! add login"),
    ];
    expect(order(autosquash(rows)!)).toEqual(["a1b2:pick", "e5f6:fixup", "i9j0:fixup", "c3d4:pick", "g7h8:squash"]);
    expect(autosquashCount(rows)).toBe(3);
  });

  it("has nothing to do without such commits, or once they are in place", () => {
    expect(autosquash([row("a", "A"), row("b", "fixup! nothing here")])).toBeNull();
    const done = autosquash([row("a", "A"), row("b", "B"), row("c", "fixup! A")])!;
    expect(autosquashCount(done)).toBe(0);
  });
});
