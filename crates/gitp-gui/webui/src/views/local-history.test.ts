// @vitest-environment happy-dom
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

describe("the snapshot list", () => {
  // @vitest-environment happy-dom
  it("opens a file's diff against the disk on click, with Restore", async () => {
    const { vi } = await import("vitest");
    const { setupLocalHistory } = await import("./local-history");
    const s = snap([["M", "src/a.ts"]]);
    const restore = vi.fn(async () => true);
    const diff = vi.fn(async () => ({
      path: "src/a.ts",
      old_path: null,
      status: "Modified" as const,
      hunks: [{ header: "@@ -1 +1 @@", lines: [{ origin: "-", old_lineno: 1, new_lineno: null, content: "draft\n" }, { origin: "+", old_lineno: null, new_lineno: 1, content: "now\n" }] }],
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const view = setupLocalHistory(host, {
      fetch: async () => [s],
      versions: async () => [],
      content: async () => "",
      diff,
      restore,
      snapshotNow: async () => null,
      clear: async () => true,
      reportError: () => {},
    });
    view.start();
    await new Promise((r) => setTimeout(r, 0));
    host.querySelector<HTMLElement>(".lh-head")!.click();
    host.querySelector<HTMLElement>(".lh-file")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(diff).toHaveBeenCalledWith(s.id, "src/a.ts");
    const lines = [...document.querySelectorAll<HTMLElement>(".lh-viewer .diff-line")].map((l) => l.className);
    expect(lines.some((c) => c.includes("del")) && lines.some((c) => c.includes("add"))).toBe(true);
    [...document.querySelectorAll<HTMLElement>(".lh-viewer button")].find((b) => b.textContent === "Restore this version")!.click();
    expect(restore).toHaveBeenCalledWith(s.id, "src/a.ts");
    document.body.innerHTML = "";
  });
});
