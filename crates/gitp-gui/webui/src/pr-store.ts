// Pull requests and lists of them shown before, kept across restarts: one
// shown again after gitp starts, or after another repository, is drawn at
// once from what it last showed, then read afresh. The newest twenty of
// each; a pull request's changed files aren't kept (too big).

import type { PrFilter, PullRequest, PullRequestDetail } from "./types";

const KEY = "gitp-pr-details";
const LISTS_KEY = "gitp-pr-lists";
const MAX = 20;

type Entry = { repo: string; detail: PullRequestDetail };
type ListEntry = { repo: string; filter: PrFilter; list: PullRequest[] };

function read<T>(key: string = KEY): T[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(list) ? (list as T[]) : [];
  } catch {
    return [];
  }
}

// Write `list` (oldest first) under `key`, the newest MAX of it; when the
// storage is full the oldest go until it fits (or nothing is kept).
function write<T>(key: string, list: T[]): void {
  while (list.length > MAX) list.shift();
  while (list.length) {
    try {
      localStorage.setItem(key, JSON.stringify(list));
      return;
    } catch {
      list.shift();
    }
  }
}

// Pull request `number` of `repo` as it was last shown, or null.
export function storedPullRequest(repo: string, number: number): PullRequestDetail | null {
  return read<Entry>().find((e) => e.repo === repo && e.detail?.number === number)?.detail ?? null;
}

// Keep `detail` as the newest.
export function storePullRequest(repo: string, detail: PullRequestDetail): void {
  const list = read<Entry>().filter((e) => !(e.repo === repo && e.detail?.number === detail.number));
  list.push({ repo, detail });
  write(KEY, list);
}

// `repo`'s pull requests under `filter` as last listed, or null.
export function storedPullRequestList(repo: string, filter: PrFilter): PullRequest[] | null {
  return read<ListEntry>(LISTS_KEY).find((e) => e.repo === repo && e.filter === filter)?.list ?? null;
}

// Keep `list` as `repo`'s newest under `filter`.
export function storePullRequestList(repo: string, filter: PrFilter, list: PullRequest[]): void {
  const lists = read<ListEntry>(LISTS_KEY).filter((e) => !(e.repo === repo && e.filter === filter));
  lists.push({ repo, filter, list });
  write(LISTS_KEY, lists);
}
