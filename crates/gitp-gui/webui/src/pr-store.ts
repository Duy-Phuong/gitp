// Pull requests shown before, kept across restarts: one opened again after
// gitp starts is drawn at once from what it last showed, then read afresh.
// The newest twenty, by repository and number; their changed files aren't
// kept (too big).

import type { PullRequestDetail } from "./types";

const KEY = "gitp-pr-details";
const MAX = 20;

type Entry = { repo: string; detail: PullRequestDetail };

function read(): Entry[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? (list as Entry[]) : [];
  } catch {
    return [];
  }
}

// Pull request `number` of `repo` as it was last shown, or null.
export function storedPullRequest(repo: string, number: number): PullRequestDetail | null {
  return read().find((e) => e.repo === repo && e.detail?.number === number)?.detail ?? null;
}

// Keep `detail` as the newest; when the storage is full, the oldest go
// until it fits (or nothing is kept).
export function storePullRequest(repo: string, detail: PullRequestDetail): void {
  const list = read().filter((e) => !(e.repo === repo && e.detail?.number === detail.number));
  list.push({ repo, detail });
  while (list.length > MAX) list.shift();
  while (list.length) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
      return;
    } catch {
      list.shift();
    }
  }
}
