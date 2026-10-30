import { describe, it, expect } from "vitest";
import { activityText, exitText, formatDuration, mergeActivity } from "./activity";
import type { ActivityEntry } from "../types";

function entry(id: number, over: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id,
    started_at: Date.UTC(2026, 9, 30, 12, 0, 0),
    duration_ms: 12,
    command: `git status ${id}`,
    exit_code: 0,
    success: true,
    quiet: false,
    stderr: "",
    stdout: "",
    ...over,
  };
}

describe("mergeActivity", () => {
  it("puts new entries on top and keeps the rest", () => {
    const merged = mergeActivity([entry(2), entry(1)], [entry(4), entry(3)]);
    expect(merged.map((e) => e.id)).toEqual([4, 3, 2, 1]);
  });

  it("returns the same list when nothing is new", () => {
    const known = [entry(1)];
    expect(mergeActivity(known, [])).toBe(known);
  });

  it("keeps no more than the backend does", () => {
    const known = Array.from({ length: 500 }, (_, i) => entry(500 - i));
    const merged = mergeActivity(known, [entry(502), entry(501)]);
    expect(merged).toHaveLength(500);
    expect(merged[0].id).toBe(502);
    expect(merged[499].id).toBe(3);
  });
});

describe("formatDuration", () => {
  it("uses ms, seconds, then minutes", () => {
    expect(formatDuration(12)).toBe("12 ms");
    expect(formatDuration(1840)).toBe("1.8 s");
    expect(formatDuration(125_000)).toBe("2m 05s");
  });
});

describe("activityText", () => {
  it("has the command, how it ended and the output", () => {
    const failed = entry(1, {
      command: "git commit -m wip",
      exit_code: 1,
      success: false,
      duration_ms: 3120,
      stdout: "eslint....Failed",
      stderr: "hook exited 1",
    });
    expect(activityText(failed)).toBe(
      "$ git commit -m wip\n# 2026-10-30T12:00:00.000Z · 3.1 s · exit 1\neslint....Failed\nhook exited 1",
    );
  });

  it("says when git was stopped rather than exiting", () => {
    expect(exitText(entry(1, { exit_code: null, success: false }))).toMatch(/^stopped/);
  });
});
