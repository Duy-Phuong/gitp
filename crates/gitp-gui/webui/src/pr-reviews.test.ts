import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftComment } from "./review-drafts";

const finding = (line: number): DraftComment => ({ path: "a.ts", line, side: "RIGHT", body: `fix ${line}`, severity: null });

// A fresh module per test: the reviews live in module state.
async function fresh() {
  vi.resetModules();
  return import("./pr-reviews");
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

describe("pull request reviews", () => {
  it("keeps each pull request's drafts apart, by repo and number", async () => {
    const m = await fresh();
    m.addDrafts(m.prReview("/a", 7), [finding(1), finding(2)]);
    m.addDrafts(m.prReview("/a", 7), [finding(3)]);
    expect(m.prReview("/a", 7).drafts.map((d) => [d.id, d.line, d.status])).toEqual([
      [1, 1, "pending"],
      [2, 2, "pending"],
      [3, 3, "pending"],
    ]);
    expect(m.prReview("/b", 7).drafts, "the same number in another repo").toEqual([]);
  });

  it("badges a running review, a failed one, and the drafts still waiting", async () => {
    const m = await fresh();
    expect(m.reviewBadge("/a", 7)).toBeNull();
    const r = m.prReview("/a", 7);
    r.running = true;
    expect(m.reviewBadge("/a", 7)).toEqual({ text: "reviewing…", kind: "running" });
    r.running = false;
    r.error = "exit code 1";
    expect(m.reviewBadge("/a", 7)?.kind).toBe("failed");
    r.error = null;
    m.addDrafts(r, [finding(1), finding(2)]);
    r.drafts[0].status = "discarded";
    expect(m.reviewBadge("/a", 7)).toEqual({ text: "1 draft", kind: "ready" });
    m.clearDrafts("/a", 7);
    expect(m.reviewBadge("/a", 7)).toBeNull();
  });

  it("remembers the review file across a restart, until the drafts are cleared", async () => {
    let m = await fresh();
    m.addDrafts(m.prReview("/a", 7), [finding(1)]);
    m.setReviewFile("/a", 7, "/a/review/s/pr-review-7.html");

    m = await fresh();
    expect(m.reviewBadge("/a", 7), "known before the file is read again").toEqual({ text: "drafts", kind: "ready" });
    expect(m.rememberedFile("/a", 7)).toBe("/a/review/s/pr-review-7.html");
    m.clearDrafts("/a", 7);

    m = await fresh();
    expect(m.rememberedFile("/a", 7)).toBeNull();
    expect(m.reviewBadge("/a", 7)).toBeNull();
  });
});

describe("posted drafts and the reviewed head", () => {
  it("leaves out what was posted, by its place and the text the review wrote, across a restart", async () => {
    let m = await fresh();
    const r = m.prReview("/a", 7);
    m.addDrafts(r, [finding(1), finding(2)]);
    r.drafts[0].body = "edited before posting";
    m.markPosted("/a", 7, [r.drafts[0]]);

    m = await fresh();
    expect(m.unposted("/a", 7, [finding(1), finding(2), finding(3)]).map((d) => d.line)).toEqual([2, 3]);
    expect(m.unposted("/a", 8, [finding(1)]), "another pull request").toHaveLength(1);
    expect(m.unposted("/a", 7, [{ ...finding(1), body: "new text" }]), "a new finding on the same line").toHaveLength(1);
  });

  it("knows the head last reviewed, and when commits came after it", async () => {
    const m = await fresh();
    expect(m.reviewedHead("/a", 7)).toBeNull();
    m.setReviewedHead("/a", 7, "e0a21160a5");
    expect(m.reviewedHead("/a", 7)).toBe("e0a21160a5");
    expect(m.hasNewCommits("e0a21160a5", "e0a21160a5ffff")).toBe(false);
    expect(m.hasNewCommits("e0a21160a5", "1234567890abcd")).toBe(true);
    expect(m.hasNewCommits(null, "1234567890abcd"), "never reviewed").toBe(false);
  });
});
