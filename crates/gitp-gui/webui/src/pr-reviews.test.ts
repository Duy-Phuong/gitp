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

  it("marks a pull request reviewed at its head, or to review again once commits came", async () => {
    const m = await fresh();
    const head = "e0a21160a5ffff";
    const kind = (pr: { number: number; head_oid: string }, files: { number: number; head?: string | null }[]) =>
      m.prReviewMark("/a", pr, files)?.kind ?? null;
    expect(kind({ number: 7, head_oid: head }, []), "never reviewed").toBeNull();
    expect(kind({ number: 7, head_oid: head }, [{ number: 7, head: "e0a21160a5" }])).toBe("reviewed");
    expect(kind({ number: 7, head_oid: head }, [{ number: 7, head: "0123456789" }])).toBe("stale");
    expect(kind({ number: 7, head_oid: head }, [{ number: 7, head: null }]), "a review that names no commit").toBe("reviewed");
    expect(kind({ number: 7, head_oid: "" }, [{ number: 7, head: "0123456789" }]), "the head isn't known").toBe("reviewed");
    expect(kind({ number: 8, head_oid: head }, [{ number: 7, head: "0123456789" }]), "another PR's review").toBeNull();

    // gitp's own record counts too: a later review run here, with no file.
    m.setReviewedHead("/a", 7, "e0a21160a5");
    expect(kind({ number: 7, head_oid: head }, [{ number: 7, head: "0123456789" }]), "either one at the head").toBe("reviewed");
    expect(kind({ number: 7, head_oid: head }, [])).toBe("reviewed");
    const stale = m.prReviewMark("/a", { number: 7, head_oid: "abcdef1234" }, []);
    expect(stale?.kind).toBe("stale");
    expect(stale?.title).toContain("e0a21160 → abcdef12");
  });
});

describe("drafts kept on disk, with a fixed mark", () => {
  const saver = () => {
    const saved = new Map<string, unknown>();
    const removed: unknown[] = [];
    return {
      saved,
      removed,
      save: vi.fn(async (repo: string, r: { branch?: string | null; pr?: number | null }) => void saved.set(`${repo}:${r.branch ?? r.pr}`, structuredClone(r))),
      remove: vi.fn(async (_repo: string, key: unknown) => void removed.push(key)),
    };
  };

  it("merges a new run by place and text: kept drafts keep their status and fix, open ones that went are dropped", async () => {
    const m = await fresh();
    const r = m.reviewFor("/a", { branch: "feat/x" });
    m.addDrafts(r, [finding(1), finding(2), finding(3), finding(4)]);
    r.drafts[0].status = "approved";
    r.drafts[1].status = "fixed";
    r.drafts[1].fix = { commit: "c".repeat(40), worktree: "/w", at: 1 };
    r.drafts[2].status = "discarded";
    // Draft 4 is pending and no longer found; 1 is found again at line 9.
    const merged = m.mergeDrafts(r.drafts, [{ ...finding(1), line: 9 }, finding(5)]);
    expect(merged.map((d) => [d.id, d.line, d.status, d.fix?.commit.slice(0, 1) ?? null])).toEqual([
      [1, 9, "approved", null],
      [2, 2, "fixed", "c"],
      [3, 3, "discarded", null],
      [5, 5, "pending", null],
    ]);
    expect(merged.map((d) => d.stale ?? false), "kept from an older run without its finding").toEqual([false, true, true, false]);
    // Found again later: its anchor is current again, and a fixed one keeps its fix.
    const again = m.mergeDrafts(merged, [finding(2)]);
    expect(again.find((d) => d.id === 2)).toMatchObject({ status: "fixed", stale: false, fix: { commit: "c".repeat(40) } });
  });

  it("knows a draft by its path and the first 80 characters of what the review wrote", async () => {
    const m = await fresh();
    const long = "x".repeat(80);
    expect(m.fingerprintOf({ path: "a", body: `${long}one` })).toBe(m.fingerprintOf({ path: "a", body: `  ${long}two` }));
    expect(m.fingerprintOf({ path: "a", body: "edited", original: "same" })).toBe(m.fingerprintOf({ path: "a", body: "same" }));
    expect(m.fingerprintOf({ path: "b", body: "same" })).not.toBe(m.fingerprintOf({ path: "a", body: "same" }));
  });

  it("saves a fixed draft and reads it back after a restart", async () => {
    vi.useFakeTimers();
    try {
      let m = await fresh();
      const s = saver();
      m.setReviewSaver(s);
      const r = m.prReview("/a", 7);
      m.addDrafts(r, [finding(1)]);
      r.drafts[0].status = "fixed";
      r.drafts[0].fix = { commit: "d".repeat(40), worktree: "/w", at: 2 };
      r.head = "h1";
      m.reviewsChanged();
      await vi.advanceTimersByTimeAsync(500);
      const stored = s.saved.get("/a:7") as import("./types").StoredReview;
      expect(stored).toMatchObject({ version: 1, pr: 7, head: "h1", drafts: [{ id: 1, status: "fixed", original: "fix 1" }] });
      m = await fresh();
      m.applyStored("/a", { pr: 7 }, stored);
      const back = m.prReview("/a", 7);
      expect(back.drafts[0].status).toBe("fixed");
      expect(back.drafts[0].fix?.commit).toBe("d".repeat(40));
      expect(back.head).toBe("h1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves typing after a pause without telling the listeners, and only what changed", async () => {
    vi.useFakeTimers();
    try {
      const m = await fresh();
      const s = saver();
      m.setReviewSaver(s);
      const heard = vi.fn();
      m.onReviewsChange(heard);
      const r = m.reviewFor("/a", { branch: "b" });
      m.addDrafts(r, [finding(1)]);
      r.drafts[0].body = "typed";
      m.saveSoon();
      expect(s.save).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(s.save).toHaveBeenCalledTimes(1);
      expect(heard).not.toHaveBeenCalled();
      await m.flushSaves();
      expect(s.save, "nothing new to save").toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves fixed and discarded drafts out of the badge", async () => {
    const m = await fresh();
    const r = m.prReview("/a", 7);
    m.addDrafts(r, [finding(1), finding(2), finding(3)]);
    r.drafts[0].status = "fixed";
    r.drafts[1].status = "discarded";
    expect(m.reviewBadge("/a", 7)).toEqual({ text: "1 draft", kind: "ready" });
    expect(r.drafts.filter(m.isOpen).map((d) => d.id)).toEqual([3]);
  });

  it("removes the saved file once the drafts are cleared", async () => {
    const m = await fresh();
    const s = saver();
    m.setReviewSaver(s);
    m.addDrafts(m.prReview("/a", 7), [finding(1)]);
    await m.flushSaves();
    m.clearDrafts("/a", 7);
    await m.flushSaves();
    expect(s.remove).toHaveBeenCalledWith("/a", { pr: 7 });
    // A review never saved is never removed.
    m.prReview("/a", 8);
    await m.flushSaves();
    expect(s.remove).toHaveBeenCalledTimes(1);
  });

  it("keeps a review whose drafts left after posting are fixed ones", async () => {
    const m = await fresh();
    const r = m.prReview("/a", 7);
    m.addDrafts(r, [finding(1), finding(2)]);
    r.drafts[0].status = "discarded";
    r.drafts[1].status = "discarded";
    expect(m.nothingLeftAfterPost(r.drafts)).toBe(true);
    r.drafts[0].status = "fixed";
    expect(m.nothingLeftAfterPost(r.drafts), "a fixed mark is kept").toBe(false);
    r.drafts[0].status = "pending";
    expect(m.nothingLeftAfterPost(r.drafts)).toBe(false);
  });
});

describe("the review file's words on a finding", () => {
  const said = { explained: "Why.", finding: "f1", explanations: ["More."] };

  it("are kept on disk and come back", async () => {
    const m = await fresh();
    const r = m.prReview("/a", 7);
    m.addDrafts(r, [{ ...finding(1), ...said }, finding(2)]);
    const stored = m.toStored(r, { pr: 7 });
    expect(stored.drafts[0]).toMatchObject(said);
    expect(stored.drafts[1]).not.toHaveProperty("explained");
    const back = (await fresh()).applyStored("/a", { pr: 7 }, stored);
    expect(back.drafts[0]).toMatchObject(said);
  });

  it("follow a new read of the file and leave decisions and edits alone", async () => {
    const m = await fresh();
    const r = m.prReview("/a", 7);
    m.addDrafts(r, [{ ...finding(1), finding: "f1" }, finding(2)]);
    r.drafts[0].status = "approved";
    r.drafts[0].body = "edited";
    const next = m.withFindingText(r.drafts, [{ ...finding(1), ...said }, finding(2)]);
    expect(next[0]).toMatchObject({ status: "approved", body: "edited", ...said });
    expect(next[1]).toEqual(r.drafts[1]);
    // A run that finds it again takes the file's words too.
    expect(m.mergeDrafts(next, [{ ...finding(1), finding: "f1", explained: "Why, again." }])[0]).toMatchObject({ explained: "Why, again.", explanations: undefined });
  });

  it("gives a draft read with the copy-block wrapper and fix notes in it the clean comment, unless it was edited", async () => {
    const m = await fresh();
    const r = m.prReview("/a", 8);
    const dirty = (t: string) => `<div class="copy-block" data-i="2">\n\n${t}\n\n</div>\n\n**Fix status:** proposed`;
    m.addDrafts(r, [{ ...finding(1), body: dirty("One.") }, { ...finding(2), body: dirty("Two.") }]);
    r.drafts[0].status = "approved";
    r.drafts[1].body = "my edit";
    const clean = (t: string) => ({ body: t, fixNotes: "**Fix status:** proposed" });
    const next = m.withFindingText(r.drafts, [{ ...finding(1), ...clean("One.") }, { ...finding(2), ...clean("Two.") }]);
    expect(next[0]).toMatchObject({ status: "approved", body: "One.", original: "One.", fixNotes: "**Fix status:** proposed" });
    expect(next[1]).toMatchObject({ body: "my edit", original: dirty("Two."), fixNotes: "**Fix status:** proposed" });
    expect(m.mergeDrafts(r.drafts, [{ ...finding(1), ...clean("One.") }])[0]).toMatchObject({ id: 1, status: "approved", body: "One." });
  });
});
