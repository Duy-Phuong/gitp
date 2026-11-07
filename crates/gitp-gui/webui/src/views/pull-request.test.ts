// @vitest-environment happy-dom
// The pull request view refreshing on its own (pr-refresh.ts, poller.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pausePollingFor } from "../poller";
import { RATE_LIMIT_NOTICE } from "../pr-refresh";
import type { FileDiff, PrSignature, PullRequestDetail } from "../types";
import { setupPullRequestView, type PullRequestCallbacks, type PullRequestHandle } from "./pull-request";

const lineComment = {
  id: 1,
  author: "rev",
  body: "Why?",
  path: "src/a.ts",
  line: 2,
  original_line: 2,
  side: "RIGHT" as const,
  created_at: "2026-11-07T09:00:00Z",
  in_reply_to: null,
  url: "",
  diff_hunk: "@@ -1 +1,2 @@\n one\n+two",
};

const base = (): PullRequestDetail => ({
  number: 7,
  title: "Widgets",
  body: "",
  state: "OPEN",
  is_draft: false,
  author: "octo",
  base: "main",
  head: "feature",
  head_oid: "a1",
  url: "https://github.com/o/r/pull/7",
  created_at: "2026-11-07T08:00:00Z",
  review_decision: null,
  labels: [],
  checks: [],
  reviews: [],
  comments: [],
  review_comments: [lineComment],
  review_threads: [{ id: "T1", resolved: false, comment_ids: [1] }],
  commits: [{ oid: "a1", headline: "one", body: "", authors: [], committed_at: "" }],
  additions: 1,
  deletions: 0,
  changed_files: 1,
  mergeable: "MERGEABLE",
  merge_state: "CLEAN",
});

const fileWith = (lines: [string, number | null, number | null, string][]): FileDiff[] => [
  {
    path: "src/a.ts",
    old_path: null,
    status: "Modified",
    hunks: [{ header: "@@ -1 +1,3 @@", lines: lines.map(([origin, old_lineno, new_lineno, content]) => ({ origin, old_lineno, new_lineno, content })) }],
  } as FileDiff,
];

const FILES = fileWith([
  [" ", 1, 1, "one"],
  ["+", null, 2, "two"],
  ["+", null, 3, "three"],
]);

let detail: PullRequestDetail;
let signature: PrSignature;
let files: FileDiff[];
let host: HTMLElement;
let view: PullRequestHandle;
let cb: { fetchDetail: ReturnType<typeof vi.fn>; fetchSignature: ReturnType<typeof vi.fn>; fetchFiles: ReturnType<typeof vi.fn> };

function callbacks(over: Partial<PullRequestCallbacks>): PullRequestCallbacks {
  const given: Partial<PullRequestCallbacks> = {
    repoPath: () => "/repo",
    branchAhead: () => 0,
    reviewedHead: () => null,
    savedReview: () => null,
    pushReplyInFlight: () => false,
    draftFix: () => null,
    ...over,
  };
  return new Proxy(given, { get: (t, k: string) => (t as Record<string, unknown>)[k] ?? (() => undefined) }) as PullRequestCallbacks;
}

const settle = () => vi.advanceTimersByTimeAsync(10);
const poll = () => vi.advanceTimersByTimeAsync(30_000);
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
const notice = () => host.querySelector(".pr-refresh-notice")?.textContent ?? null;
const type = (area: HTMLTextAreaElement, text: string) => {
  area.value = text;
  area.dispatchEvent(new Event("input"));
};

// Someone comments on GitHub: the signature moves and the detail has it.
function aCommentArrives(): void {
  signature = { ...signature, updated_at: `2026-11-07T10:0${detail.comments.length + 1}:00Z` };
  detail = { ...detail, comments: [...detail.comments, { id: `IC${detail.comments.length + 1}`, author: "x", body: "Hello", created_at: "2026-11-07T10:05:00Z", url: "" }] };
}

beforeEach(async () => {
  vi.useFakeTimers();
  window.dispatchEvent(new Event("focus"));
  detail = base();
  signature = { head: "a1", updated_at: "2026-11-07T10:00:00Z", threads: [["T1", false]], checks: [] };
  files = FILES;
  cb = {
    fetchDetail: vi.fn(async () => structuredClone(detail)),
    fetchSignature: vi.fn(async () => structuredClone(signature)),
    fetchFiles: vi.fn(async () => structuredClone(files)),
  };
  host = document.createElement("div");
  document.body.append(host);
  view = setupPullRequestView(host, callbacks(cb as unknown as Partial<PullRequestCallbacks>));
  view.show(7);
  await settle();
});

afterEach(() => {
  view.reset();
  host.remove();
  pausePollingFor(0);
  vi.useRealTimers();
});

describe("the pull request view polling", () => {
  it("a poll with no change does not redraw", async () => {
    const before = host.querySelector(".pr-view");
    await poll();
    expect(cb.fetchSignature).toHaveBeenCalledTimes(2); // the load's, then the poll's
    expect(cb.fetchDetail).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".pr-view")).toBe(before);
    expect(notice()).toBeNull();
  });

  it("a changed poll redraws keeping the Reply box text, and shows the notice", async () => {
    button("Reply…").click();
    await settle();
    type(host.querySelector<HTMLTextAreaElement>(".pr-thread textarea")!, "On it");
    (document.activeElement as HTMLElement | null)?.blur();
    const before = host.querySelector(".pr-view");
    aCommentArrives();
    await poll();
    await settle();
    expect(cb.fetchDetail).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".pr-view")).not.toBe(before);
    expect(host.querySelector<HTMLTextAreaElement>(".pr-thread textarea")?.value).toBe("On it");
    expect(notice()).toBe("Updated: 1 new comment");
  });

  it("the notice goes after 10 seconds or on click", async () => {
    aCommentArrives();
    await poll();
    expect(notice()).toBe("Updated: 1 new comment");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(notice()).toBeNull();
    aCommentArrives();
    await vi.advanceTimersByTimeAsync(20_000); // the next poll, at 60 s
    expect(notice()).toBe("Updated: 1 new comment");
    host.querySelector<HTMLElement>(".pr-refresh-notice")!.click();
    expect(notice()).toBeNull();
  });

  it("the notice survives another redraw while it shows", async () => {
    aCommentArrives();
    await poll();
    view.redraw();
    expect(notice()).toBe("Updated: 1 new comment");
  });

  it("a redraw waits while a text box has focus", async () => {
    const area = host.querySelector<HTMLTextAreaElement>(".pr-composer textarea")!;
    area.focus();
    type(area, "Draft comment");
    const before = host.querySelector(".pr-view");
    aCommentArrives();
    await poll();
    expect(cb.fetchDetail).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".pr-view")).toBe(before);
    expect(notice()).toBeNull();
    area.blur();
    await settle();
    expect(host.querySelector(".pr-view")).not.toBe(before);
    expect(host.querySelector<HTMLTextAreaElement>(".pr-composer textarea")?.value).toBe("Draft comment");
    expect(notice()).toBe("Updated: 1 new comment");
  });

  it("an open line composer survives a redraw", async () => {
    button("Files changed (1)").click();
    await settle();
    host.querySelectorAll<HTMLElement>(".diff-line.pr-commentable")[2].click();
    await settle();
    type(host.querySelector<HTMLTextAreaElement>(".pr-line-composer textarea")!, "Name it better");
    (document.activeElement as HTMLElement | null)?.blur();
    aCommentArrives();
    await poll();
    await settle();
    const composers = host.querySelectorAll<HTMLTextAreaElement>(".pr-line-composer textarea");
    expect(composers).toHaveLength(1);
    expect(composers[0].value).toBe("Name it better");
    // Under its line still.
    expect(composers[0].closest(".pr-line-composer")!.previousElementSibling?.textContent).toContain("three");
  });

  it("a composer whose line left the diff shows its text with Discard", async () => {
    button("Files changed (1)").click();
    await settle();
    host.querySelectorAll<HTMLElement>(".diff-line.pr-commentable")[2].click();
    await settle();
    type(host.querySelector<HTMLTextAreaElement>(".pr-line-composer textarea")!, "Name it better");
    (document.activeElement as HTMLElement | null)?.blur();
    // A push drops line 3.
    signature = { ...signature, head: "b2" };
    detail = { ...detail, head_oid: "b2", commits: [...detail.commits, { oid: "b2", headline: "two", body: "", authors: [], committed_at: "" }] };
    files = fileWith([
      [" ", 1, 1, "one"],
      ["+", null, 2, "two"],
    ]);
    await poll();
    await settle();
    expect(cb.fetchFiles).toHaveBeenCalledTimes(2);
    expect(notice()).toBe("Updated: 1 new commit");
    const orphan = host.querySelector<HTMLElement>(".pr-line-orphan")!;
    expect(orphan.textContent).toContain("no longer in the diff");
    expect(orphan.querySelector("textarea")!.value).toBe("Name it better");
    [...orphan.querySelectorAll("button")].find((b) => b.textContent === "Discard")!.click();
    expect(host.querySelector(".pr-line-orphan")).toBeNull();
    view.redraw();
    await settle();
    expect(host.querySelector(".pr-line-orphan")).toBeNull();
  });

  it("the user's own reload sets the signature quietly", async () => {
    aCommentArrives();
    view.reload();
    await settle();
    await poll();
    expect(cb.fetchDetail).toHaveBeenCalledTimes(2); // show, reload; not the poll
    expect(notice()).toBeNull();
  });

  it("a rate-limit failure pauses polling and says so", async () => {
    cb.fetchSignature.mockRejectedValue("GitHub's API rate limit was reached. Wait a few minutes, then try again.");
    await poll();
    expect(notice()).toBe(RATE_LIMIT_NOTICE);
    // It stays while polling is paused, not the usual 10 seconds.
    await vi.advanceTimersByTimeAsync(11_000);
    expect(notice()).toBe(RATE_LIMIT_NOTICE);
    const calls = cb.fetchSignature.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(cb.fetchSignature.mock.calls.length).toBe(calls);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cb.fetchSignature.mock.calls.length).toBe(calls + 1);
  });

  it("a composer whose line now holds other code after a push is not reopened there", async () => {
    button("Files changed (1)").click();
    await settle();
    host.querySelectorAll<HTMLElement>(".diff-line.pr-commentable")[2].click(); // line 3, "three"
    await settle();
    type(host.querySelector<HTMLTextAreaElement>(".pr-line-composer textarea")!, "Name it better");
    (document.activeElement as HTMLElement | null)?.blur();
    // A push inserts a line above: line 3 is now other code.
    signature = { ...signature, head: "b2" };
    detail = { ...detail, head_oid: "b2", commits: [...detail.commits, { oid: "b2", headline: "two", body: "", authors: [], committed_at: "" }] };
    files = fileWith([
      [" ", 1, 1, "one"],
      ["+", null, 2, "two"],
      ["+", null, 3, "inserted"],
      ["+", null, 4, "three"],
    ]);
    await poll();
    await settle();
    expect(host.querySelector(".pr-line-composer")).toBeNull();
    expect(host.querySelector<HTMLTextAreaElement>(".pr-line-orphan textarea")?.value).toBe("Name it better");
  });

  it("a poll during the user's own reload says nothing", async () => {
    aCommentArrives();
    let release: () => void = () => undefined;
    cb.fetchDetail.mockImplementationOnce(() => new Promise((r) => (release = () => r(structuredClone(detail)))));
    await vi.advanceTimersByTimeAsync(29_000);
    view.reload(); // the user posted the comment; the reload is slow
    await vi.advanceTimersByTimeAsync(2_000); // the poll at 30 s lands meanwhile
    release();
    await settle();
    expect(notice()).toBeNull();
    await poll();
    expect(notice()).toBeNull();
    expect(cb.fetchDetail).toHaveBeenCalledTimes(2); // show, reload
  });

  it("a redraw waiting on one pull request is dropped when another opens", async () => {
    const area = host.querySelector<HTMLTextAreaElement>(".pr-composer textarea")!;
    area.focus();
    aCommentArrives();
    await poll();
    view.show(8);
    area.blur();
    host.dispatchEvent(new FocusEvent("focusout"));
    await settle();
    expect(notice()).toBeNull();
  });

  it("stops polling once reset", async () => {
    view.reset();
    await poll();
    expect(cb.fetchSignature).toHaveBeenCalledTimes(1);
  });
});
