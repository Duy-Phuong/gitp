import { describe, expect, it } from "vitest";

import { hiddenRefCount, refFilter, refShown, withHidden, withSolo } from "./ref-visibility";
import type { GraphPrefs } from "./prefs";
import type { Refs } from "./types";

const none: GraphPrefs = { pinned: null, hidden: [], solo: [] };

const refs: Refs = {
  head: "main",
  branches: [
    { name: "main", is_head: true, ahead: 0, behind: 0, target: "a", has_upstream: true },
    { name: "dev", is_head: false, ahead: 0, behind: 0, target: "b", has_upstream: true },
  ],
  remotes: [{ remote: "origin", name: "origin/dev", target: "b" }],
  tags: [{ name: "v1", target: "a" }],
  stashes: [],
  recent: [],
};

describe("refShown", () => {
  it("shows everything not hidden", () => {
    const f = refFilter(withHidden(none, ["refs/heads/dev"], true));
    expect(refShown(f, "refs/heads/dev")).toBe(false);
    expect(refShown(f, "refs/remotes/origin/dev")).toBe(true);
  });

  it("shows only soloed refs while anything is soloed, and always HEAD's branch", () => {
    const f = refFilter(withSolo(none, ["refs/tags/v1"], true));
    expect(refShown(f, "refs/tags/v1")).toBe(true);
    expect(refShown(f, "refs/heads/dev")).toBe(false);
    expect(refShown(f, "refs/heads/main", true)).toBe(true);
  });
});

describe("hiddenRefCount", () => {
  it("counts what the graph leaves out", () => {
    expect(hiddenRefCount(refFilter(none), refs)).toBe(0);
    expect(hiddenRefCount(refFilter(withHidden(none, ["refs/heads/dev", "refs/tags/v1"], true)), refs)).toBe(2);
    // Solo origin/dev: dev and v1 are out, main is HEAD.
    expect(hiddenRefCount(refFilter(withSolo(none, ["refs/remotes/origin/dev"], true)), refs)).toBe(2);
  });

  it("doesn't count hidden names that no longer exist", () => {
    expect(hiddenRefCount(refFilter(withHidden(none, ["refs/heads/gone"], true)), refs)).toBe(0);
  });
});

describe("withHidden / withSolo", () => {
  it("keep the lists sorted and free of duplicates, so equal sets compare equal", () => {
    const a = withHidden(withHidden(none, ["refs/heads/b", "refs/heads/a"], true), ["refs/heads/a"], true);
    expect(a.hidden).toEqual(["refs/heads/a", "refs/heads/b"]);
    expect(withHidden(a, ["refs/heads/a"], false).hidden).toEqual(["refs/heads/b"]);
    expect(withSolo(none, ["z", "y"], true).solo).toEqual(["y", "z"]);
  });
});
