// @vitest-environment happy-dom
// The pull request view's side of the conversation search: a resolved
// thread shows its stored conversation read-only, a search click opens the
// thread's block, and a thread gone from GitHub shows its conversation on top.
import { beforeEach, expect, it } from "vitest";
import { setupPullRequestView, type PullRequestCallbacks } from "./pull-request";
import { setConversation } from "../pr-threads";
import type { PrReviewComment, PullRequestDetail, ThreadConversation } from "../types";

const comment = (id: number, path: string): PrReviewComment => ({
  id,
  author: "anna",
  body: `comment ${id}`,
  path,
  line: 12,
  original_line: 12,
  side: "RIGHT",
  created_at: "2026-11-04T09:00:00Z",
  in_reply_to: null,
  url: "",
  diff_hunk: "@@ -1 +1 @@\n+b",
});

const detail = (): PullRequestDetail => ({
  number: 7,
  title: "Retry fix",
  body: "",
  state: "OPEN",
  is_draft: false,
  author: "octocat",
  base: "main",
  head: "fix",
  head_oid: "aaaa",
  url: "",
  created_at: "2026-11-04T08:00:00Z",
  review_decision: null,
  labels: [],
  checks: [],
  reviews: [],
  comments: [],
  review_comments: [comment(500, "src/open.ts"), comment(600, "src/resolved.ts")],
  review_threads: [
    { id: "a", resolved: false, comment_ids: [500] },
    { id: "b", resolved: true, comment_ids: [600] },
  ],
  commits: [],
  additions: 1,
  deletions: 0,
  changed_files: 1,
  mergeable: "MERGEABLE",
  merge_state: "CLEAN",
});

const conv = (thread: number, path: string): ThreadConversation => ({
  version: 1,
  pr: 7,
  thread,
  path,
  line: 3,
  turns: [{ kind: "check", role: "claude", at: Date.now(), head: "aaaa", text: `answer on ${thread}` }],
});

let host: HTMLElement;
let cleared: number[];

function setup() {
  const overrides: Partial<PullRequestCallbacks> = {
    fetchDetail: async () => detail(),
    fetchFiles: async () => [],
    repoPath: () => "/r",
    savedReview: () => null,
    reviewedHead: () => null,
    branchAhead: () => 0,
    draftFix: () => null,
    pushReplyInFlight: () => false,
    clearThreadConversation: async (_pr, t) => {
      cleared.push(t.root.id);
      return true;
    },
  };
  const cb = new Proxy(overrides, { get: (o, k: string) => (o as Record<string, unknown>)[k] ?? (() => {}) }) as PullRequestCallbacks;
  return setupPullRequestView(host, cb);
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const thread = (id: number) => host.querySelector<HTMLElement>(`[data-thread="${id}"]`)!;

beforeEach(() => {
  document.body.replaceChildren();
  host = document.createElement("section");
  document.body.append(host);
  cleared = [];
  setConversation("/r", 7, 500, conv(500, "src/open.ts"));
  setConversation("/r", 7, 600, conv(600, "src/resolved.ts"));
  setConversation("/r", 7, 900, { ...conv(900, "src/gone.ts"), comments: [{ author: "bob", body: "the loop stops early" }, { author: "anna", body: "fixed?" }] });
});

it("a resolved thread shows its stored conversation collapsed and read-only", async () => {
  const view = setup();
  view.show(7);
  await settle();
  const block = thread(600).querySelector(".pr-thread-claude")!;
  expect(block.classList.contains("open")).toBe(false);
  expect(thread(600).querySelectorAll(".pr-thread-claude-button").length).toBe(0);
  block.querySelector<HTMLElement>(".pr-thread-claude-head")!.click();
  const buttons = [...thread(600).querySelectorAll(".pr-thread-claude button")].map((b) => b.textContent);
  expect(buttons).toEqual(["Clear"]);
  expect(thread(600).textContent).toContain("answer on 600");
});

it("a search click opens the thread's block, resolved or not", async () => {
  const view = setup();
  view.show(7);
  view.focusThread(600);
  await settle();
  expect(thread(600).querySelector(".pr-thread-claude")!.classList.contains("open")).toBe(true);
  expect(thread(500).querySelector(".pr-thread-claude")!.classList.contains("open")).toBe(false);
  view.focusThread(500);
  expect(thread(500).querySelector(".pr-thread-claude")!.classList.contains("open")).toBe(true);
});

it("a thread gone from GitHub shows a note and its stored conversation on top, with Clear", async () => {
  const view = setup();
  view.show(7);
  view.focusThread(900);
  await settle();
  const gone = thread(900);
  const body = host.querySelector(".pr-body")!;
  expect(body.firstElementChild).toBe(gone);
  expect(gone.textContent).toContain("thread no longer on GitHub");
  expect(gone.textContent).toContain("src/gone.ts:3");
  expect(gone.textContent).toContain("answer on 900");
  const said = [...gone.querySelectorAll(".pr-thread-comment")].map((c) => [c.querySelector(".pr-card-author")?.textContent, c.querySelector(".github-markdown")?.textContent?.trim()]);
  expect(said).toEqual([["bob", "the loop stops early"], ["anna", "fixed?"]]);
  const clear = [...gone.querySelectorAll("button")].find((b) => b.textContent === "Clear")!;
  clear.click();
  await settle();
  expect(cleared).toEqual([900]);
});

it("the gone-thread note goes with another pull request", async () => {
  const view = setup();
  view.show(7);
  view.focusThread(900);
  await settle();
  view.show(8);
  view.show(7);
  await settle();
  expect(host.querySelector('[data-thread="900"]')).toBeNull();
});
