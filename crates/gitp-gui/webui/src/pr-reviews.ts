// The review of each pull request, by repository and number: the review
// command running in the background for it, and the draft comments it (or a
// loaded review file) left to approve or discard. It outlives the pull request
// view — opening another one, or another repo tab, keeps it — so a review that
// takes half an hour can be started and come back to. The sidebar shows its
// state as a badge on the pull request.
//
// The file a review was read from is remembered across restarts; its drafts
// are read again from it the next time they are asked for.

import type { DraftComment } from "./review-drafts";
import type { ReviewVerdict } from "./types";

// A loaded finding and what the user decided about it.
export interface Draft extends DraftComment {
  id: number;
  status: "pending" | "approved" | "discarded";
}

export interface PrReview {
  // The review command is running for it.
  running: boolean;
  // Why the last run failed; null once it succeeded or was dismissed.
  error: string | null;
  drafts: Draft[];
  // The review the approved drafts will be posted as.
  verdict: ReviewVerdict;
  body: string;
  // The review page the drafts came from, when they came from a file.
  file: string | null;
}

const FILES_KEY = "gitp-pr-review-files";
const reviews = new Map<string, PrReview>();
const listeners = new Set<() => void>();

const keyOf = (repo: string, number: number) => `${repo}\n${number}`;

function loadFiles(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(FILES_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveFile(key: string, file: string | null): void {
  const files = loadFiles();
  if (file) files[key] = file;
  else delete files[key];
  try {
    localStorage.setItem(FILES_KEY, JSON.stringify(files));
  } catch {
    // Full or blocked storage: the drafts just don't survive a restart.
  }
}

// The review file remembered for a pull request from an earlier run of the
// app, whose drafts aren't loaded yet.
export function rememberedFile(repo: string, number: number): string | null {
  const key = keyOf(repo, number);
  return reviews.has(key) ? null : (loadFiles()[key] ?? null);
}

// The pull request's review, made empty the first time it is asked for.
export function prReview(repo: string, number: number): PrReview {
  const key = keyOf(repo, number);
  let r = reviews.get(key);
  if (!r) {
    r = { running: false, error: null, drafts: [], verdict: "comment", body: "", file: null };
    reviews.set(key, r);
  }
  return r;
}

// Add `found` as pending drafts after the ones already there.
export function addDrafts(r: PrReview, found: DraftComment[]): void {
  const next = r.drafts.length ? Math.max(...r.drafts.map((d) => d.id)) + 1 : 1;
  r.drafts = [...r.drafts, ...found.map((d, i) => ({ ...d, id: next + i, status: "pending" as const }))];
}

// Remember (or forget) the file the pull request's drafts came from.
export function setReviewFile(repo: string, number: number, file: string | null): void {
  prReview(repo, number).file = file;
  saveFile(keyOf(repo, number), file);
}

// Throw away the drafts — all posted, or cleared — and the file they came from.
export function clearDrafts(repo: string, number: number): void {
  const r = prReview(repo, number);
  r.drafts = [];
  r.body = "";
  r.error = null;
  setReviewFile(repo, number, null);
}

// What the sidebar shows on the pull request: running, failed, or how many
// drafts wait for a decision. Null when there is nothing to show.
export function reviewBadge(repo: string, number: number): { text: string; kind: "running" | "failed" | "ready" } | null {
  const r = reviews.get(keyOf(repo, number));
  if (r?.running) return { text: "reviewing…", kind: "running" };
  if (r?.error) return { text: "review failed", kind: "failed" };
  const pending = r ? r.drafts.filter((d) => d.status !== "discarded").length : 0;
  if (pending) return { text: `${pending} draft${pending === 1 ? "" : "s"}`, kind: "ready" };
  if (!r && loadFiles()[keyOf(repo, number)]) return { text: "drafts", kind: "ready" };
  return null;
}

export function onReviewsChange(listener: () => void): void {
  listeners.add(listener);
}

export function reviewsChanged(): void {
  for (const l of listeners) l();
}
