import { describe, expect, it } from "vitest";

import { groupInbox, inboxPaths, inboxReasons, needsYou, sortInbox, type InboxPr } from "./inbox";

function pr(over: Partial<InboxPr>): InboxPr {
  return {
    repo: "octo/hello",
    path: "/r/hello",
    number: 1,
    title: "t",
    author: "me",
    url: "u",
    updated_at: "2026-11-01T00:00:00Z",
    checks: "success",
    review_decision: null,
    merge_state: "BLOCKED",
    mine: true,
    review_requested: false,
    unresolved: 0,
    prepared: 0,
    ...over,
  };
}

describe("which pull requests need you", () => {
  it("a review requested from you", () => {
    expect(needsYou(pr({ mine: false, review_requested: true }))).toBe(true);
  });
  it("yours with unresolved threads", () => {
    expect(needsYou(pr({ unresolved: 2 }))).toBe(true);
  });
  it("yours with a failed check", () => {
    expect(needsYou(pr({ checks: "failure" }))).toBe(true);
  });
  it("yours approved and mergeable (CLEAN)", () => {
    expect(needsYou(pr({ review_decision: "APPROVED", merge_state: "CLEAN" }))).toBe(true);
  });
  it("not yours approved but not CLEAN, nor CLEAN without approval, nor pending checks", () => {
    expect(needsYou(pr({ review_decision: "APPROVED", merge_state: "UNKNOWN" }))).toBe(false);
    expect(needsYou(pr({ review_decision: "APPROVED", merge_state: "BEHIND" }))).toBe(false);
    expect(needsYou(pr({ merge_state: "CLEAN" }))).toBe(false);
    expect(needsYou(pr({ checks: "pending", unresolved: null }))).toBe(false);
  });
  it("says why", () => {
    expect(inboxReasons(pr({ mine: false, review_requested: true }))).toEqual(["review requested"]);
    expect(inboxReasons(pr({ checks: "failure", unresolved: 3 }))).toEqual(["checks failed", "3 unresolved"]);
    expect(inboxReasons(pr({ review_decision: "APPROVED", merge_state: "CLEAN" }))).toEqual(["ready to merge"]);
    expect(inboxReasons(pr({}))).toEqual([]);
  });
});

describe("the inbox order", () => {
  it("failed check, then review requested, then most unresolved, then newest", () => {
    const list = [
      pr({ number: 1, updated_at: "2026-11-05T00:00:00Z" }),
      pr({ number: 2, unresolved: 1 }),
      pr({ number: 3, unresolved: 5 }),
      pr({ number: 4, mine: false, review_requested: true }),
      pr({ number: 5, checks: "failure" }),
      pr({ number: 6, updated_at: "2026-11-06T00:00:00Z" }),
    ];
    expect(sortInbox(list).map((p) => p.number)).toEqual([5, 4, 3, 2, 6, 1]);
  });

  it("groups needs-you and waiting, each sorted", () => {
    const { needs, waiting } = groupInbox([
      pr({ number: 1 }),
      pr({ number: 2, unresolved: 1 }),
      pr({ number: 3, checks: "failure" }),
      pr({ number: 4, updated_at: "2026-11-06T00:00:00Z" }),
    ]);
    expect(needs.map((p) => p.number)).toEqual([3, 2]);
    expect(waiting.map((p) => p.number)).toEqual([4, 1]);
  });
});

describe("the repositories asked", () => {
  it("are the recent ones, then the starred not among them", () => {
    expect(inboxPaths(["/a", "/b"], ["/c", "/a"])).toEqual(["/a", "/b", "/c"]);
  });
});
