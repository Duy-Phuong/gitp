import { describe, expect, it } from "vitest";
import type { ClaudeJob } from "./api";
import type { InboxPr } from "./inbox";
import { inboxNotes, jobNotes } from "./notifications";

const job = (id: number, state: ClaudeJob["state"], extra: Partial<ClaudeJob> = {}) =>
  ({ id, state, label: `Review · #${id}`, error: null, ...extra }) as ClaudeJob;

const pr = (number: number, extra: Partial<InboxPr>) =>
  ({ repo: "o/r", number, title: `PR ${number}`, author: "ada", mine: false, review_requested: false, checks: null, ...extra }) as InboxPr;

describe("notifications", () => {
  it("tells of jobs that stopped running, done or failed, not stopped by you", () => {
    const before = new Map<number, ClaudeJob["state"]>([[1, "running"], [2, "running"], [3, "running"], [4, "done"]]);
    const notes = jobNotes(before, [job(1, "done"), job(2, "failed", { error: "boom" }), job(3, "stopped"), job(4, "done"), job(5, "running")]);
    expect(notes).toEqual([
      { title: "Claude job finished", body: "Review · #1" },
      { title: "Claude job failed", body: "Review · #2: boom" },
    ]);
  });

  it("tells of a check newly failed on your pull request and a review newly asked of you", () => {
    const seen = { failing: new Set(["o/r#1"]), requested: new Set<string>() };
    const out = inboxNotes(seen, [
      pr(1, { mine: true, checks: "failure" }),
      pr(2, { mine: true, checks: "failure" }),
      pr(3, { mine: false, checks: "failure" }),
      pr(4, { review_requested: true }),
    ]);
    expect(out.notes).toEqual([
      { title: "A check failed", body: "o/r#2 PR 2" },
      { title: "Review requested", body: "o/r#4 PR 4 by ada" },
    ]);
    expect([...out.seen.failing]).toEqual(["o/r#1", "o/r#2"]);
  });
});
