import { describe, expect, it } from "vitest";

import { snapshotSummary, statusOf } from "./local-history";
import type { Snapshot } from "../types";

const snap = (files: [string, string][]): Snapshot => ({
  id: "a".repeat(40),
  time: 0,
  head: "b".repeat(40),
  files: files.map(([status, path]) => ({ status, path, from: null })),
});

describe("snapshotSummary", () => {
  it("counts the files by kind", () => {
    expect(snapshotSummary(snap([["M", "a"], ["M", "b"], ["A", "c"], ["D", "d"]]))).toBe("4 files · 2 modified, 1 new, 1 deleted");
    expect(snapshotSummary(snap([["M", "a"]]))).toBe("1 file · 1 modified");
    expect(snapshotSummary(snap([]))).toBe("No uncommitted files");
  });
});

describe("statusOf", () => {
  it("spells git's letters the way the status badges expect", () => {
    expect(statusOf({ status: "A", path: "x", from: null })).toBe("Added");
    expect(statusOf({ status: "D", path: "x", from: null })).toBe("Deleted");
    expect(statusOf({ status: "R", path: "x", from: "y" })).toBe("Renamed");
    expect(statusOf({ status: "M", path: "x", from: null })).toBe("Modified");
  });
});
