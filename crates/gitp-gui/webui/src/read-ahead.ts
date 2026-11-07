// Reading a pull request a moment before it is opened: the pointer resting
// on its row starts the read, and opening it takes that read instead of
// starting another. One read is kept, the last one pointed at.

import { fetchPullRequest } from "./api";
import { state } from "./app-state";
import type { PullRequestDetail } from "./types";

// How long the pointer rests before the read starts: passing over a row
// on the way elsewhere doesn't.
const REST_MS = 150;
// How long a read ahead stays good to take.
const FRESH_MS = 10_000;

let ahead: { key: string; at: number; promise: Promise<unknown>; failed: boolean } | null = null;

// Start reading `key` with `fetch`, unless a fresh read of it is under way.
export function readAhead(key: string, fetch: () => Promise<unknown>): void {
  if (ahead?.key === key && !ahead.failed && Date.now() - ahead.at < FRESH_MS) return;
  const read = { key, at: Date.now(), promise: fetch(), failed: false };
  read.promise.catch(() => {
    read.failed = true;
  });
  ahead = read;
}

// The read ahead of `key`, given once; null when there is none that is
// fresh and didn't fail.
export function takeReadAhead<T>(key: string): Promise<T> | null {
  const read = ahead;
  if (!read || read.key !== key || read.failed || Date.now() - read.at >= FRESH_MS) return null;
  ahead = null;
  return read.promise as Promise<T>;
}

const prKey = (n: number) => `${state.repoPath ?? ""}#${n}`;

// Start reading pull request `n`, unless it is the one on screen.
export function readPullRequestAhead(n: number): void {
  if (state.view === "pr" && state.prs.open === n) return;
  readAhead(prKey(n), () => fetchPullRequest(n));
}

// Pull request `n`: the read started ahead of opening it, or a new one.
export function readPullRequest(n: number): Promise<PullRequestDetail> {
  return takeReadAhead<PullRequestDetail>(prKey(n)) ?? fetchPullRequest(n);
}

export function resetReadAhead(): void {
  ahead = null;
}

// Call `start` once the pointer has rested on `row` a moment.
export function whenPointedAt(row: HTMLElement, start: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  row.addEventListener("mouseenter", () => {
    clearTimeout(timer);
    timer = setTimeout(start, REST_MS);
  });
  row.addEventListener("mouseleave", () => clearTimeout(timer));
}
