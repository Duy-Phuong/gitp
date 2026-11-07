// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setupThreadSearchView, type ThreadSearchCallbacks } from "./thread-search";
import { monthRange } from "../thread-search";
import type { ThreadHit, ThreadSearch } from "../types";

const hit = (extra: Partial<ThreadHit> = {}): ThreadHit => ({
  pr: 3426,
  thread: 500,
  path: "src/retry.ts",
  line: 12,
  title: "Retry fix",
  snippet: "the loop stops early here",
  dropped: false,
  at: Date.now() - 2 * 86400_000,
  fixed: false,
  reply_state: null,
  ...extra,
});

let host: HTMLElement;
let calls: [string, [number, number] | null, number | null][];
let answers: ((s: ThreadSearch) => void)[];
let opened: ThreadHit[];
let backs: number;

function setup(extra: Partial<ThreadSearchCallbacks> = {}) {
  const view = setupThreadSearchView(host, {
    search: (q, range, pr) => {
      calls.push([q, range, pr]);
      return new Promise((resolve) => answers.push(resolve));
    },
    open: (h) => opened.push(h),
    back: () => backs++,
    reportError() {},
    now: () => new Date(2026, 10, 7),
    ...extra,
  });
  view.show();
  return view;
}

const input = () => host.querySelector<HTMLInputElement>("input")!;
const type = (text: string) => {
  input().value = text;
  input().dispatchEvent(new Event("input"));
};
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.replaceChildren();
  host = document.createElement("section");
  document.body.append(host);
  calls = [];
  answers = [];
  opened = [];
  backs = 0;
});
afterEach(() => vi.useRealTimers());

it("typing searches once, 200 ms after the last key, with #123 as the pull request", () => {
  vi.useFakeTimers();
  setup();
  expect(calls).toEqual([["", null, null]]);
  type("re");
  type("retry #12");
  vi.advanceTimersByTime(199);
  expect(calls.length).toBe(1);
  vi.advanceTimersByTime(1);
  expect(calls).toEqual([["", null, null], ["retry", null, 12]]);
});

it("a late answer for an older query is dropped", async () => {
  vi.useFakeTimers();
  setup();
  type("old");
  vi.advanceTimersByTime(200);
  type("new");
  vi.advanceTimersByTime(200);
  answers[2]({ hits: [hit({ snippet: "new one" })], total: 1 });
  await vi.runAllTimersAsync();
  answers[1]({ hits: [hit({ snippet: "old one" })], total: 1 });
  answers[0]({ hits: [], total: 0 });
  await vi.runAllTimersAsync();
  expect(host.querySelector(".ts-snippet")?.textContent).toBe("new one");
});

it("a row shows the pull request, title, file and line, the snippet with the match bold, the date and badges", async () => {
  vi.useFakeTimers();
  setup();
  type("STOPS");
  vi.advanceTimersByTime(200);
  answers[1]({ hits: [hit({ fixed: true, reply_state: "ready" })], total: 1 });
  await vi.runAllTimersAsync();
  const row = host.querySelector(".ts-row")!;
  expect(row.querySelector(".ts-pr")?.textContent).toBe("#3426");
  expect(row.querySelector(".ts-title")?.textContent).toBe("Retry fix");
  expect(row.querySelector(".ts-place")?.textContent).toBe("src/retry.ts:12");
  expect(row.querySelector(".ts-snippet b")?.textContent).toBe("stops");
  expect(row.querySelector(".ts-date")?.textContent).toBe("2d ago");
  expect([...row.querySelectorAll(".ts-badge")].map((b) => b.textContent)).toEqual(["fixed", "reply ready"]);
  expect(host.querySelector(".ts-status")?.textContent).toBe("1 conversation");
});

it("an older hit has no title or line, and a posted reply says so", async () => {
  setup();
  answers[0]({ hits: [hit({ title: null, line: null, reply_state: "posted" })], total: 1 });
  await settle();
  expect(host.querySelector(".ts-title")).toBeNull();
  expect(host.querySelector(".ts-place")?.textContent).toBe("src/retry.ts");
  expect([...host.querySelectorAll(".ts-badge")].map((b) => b.textContent)).toEqual(["posted"]);
});

it("a snippet from a dropped draft is marked", async () => {
  setup();
  answers[0]({ hits: [hit({ dropped: true })], total: 1 });
  await settle();
  expect(host.querySelector(".ts-dropped")?.textContent).toBe("dropped");
});

it("clicking a row opens the hit", async () => {
  setup();
  const h = hit();
  answers[0]({ hits: [h], total: 1 });
  await settle();
  host.querySelector<HTMLElement>(".ts-row")!.click();
  expect(opened).toEqual([h]);
});

it("Esc and Back return to the previous view", () => {
  setup();
  host.querySelector<HTMLElement>(".ts-back")!.click();
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(backs).toBe(2);
});

it("the month picker sends that month as a millisecond range", () => {
  setup();
  const select = host.querySelector<HTMLSelectElement>("select")!;
  expect([...select.options].map((o) => o.textContent)).toEqual(["Any month", "November 2026", "October 2026", "September 2026"]);
  select.value = select.options[2].value;
  select.dispatchEvent(new Event("change"));
  expect(calls[1]).toEqual(["", monthRange(2026, 10), null]);
});

it("over the cap it says to narrow the search", async () => {
  setup();
  answers[0]({ hits: Array.from({ length: 200 }, (_, i) => hit({ thread: i })), total: 340 });
  await settle();
  expect(host.querySelectorAll(".ts-row").length).toBe(200);
  expect(host.querySelector(".ts-status")?.textContent).toBe("Showing 200 of 340, narrow the search");
});

it("a failed search is reported", async () => {
  const errors: string[] = [];
  setup({ search: () => Promise.reject(new Error("boom")), reportError: (t) => errors.push(t) });
  await settle();
  expect(errors).toEqual(["Couldn't search the conversations"]);
  expect(host.querySelector(".ts-status")?.textContent).toBe("Couldn't search.");
});
