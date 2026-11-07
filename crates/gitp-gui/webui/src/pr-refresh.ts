// The pull request view and list refreshing on their own: how often they
// poll, whether a poll found a change, and what the notice says changed.

import type { PrSignature, PullRequest, PullRequestDetail } from "./types";

export const PR_VIEW_POLL_MS = 30_000;
export const PR_LIST_POLL_MS = 60_000;
// GitHub's rate limit answered: no polling for ten minutes.
export const RATE_LIMIT_PAUSE_MS = 10 * 60_000;
export const RATE_LIMIT_NOTICE = "GitHub rate limit, polling paused";
// How long the notice stays.
export const NOTICE_MS = 10_000;

// Whether the pull request moved since `before`; with no `before` yet, the
// poll only sets it.
export function signatureChanged(before: PrSignature | null, now: PrSignature): boolean {
  return before !== null && JSON.stringify(before) !== JSON.stringify(now);
}

// Whether the sidebar's rows differ.
export function listChanged(before: PullRequest[] | null, now: PullRequest[]): boolean {
  return JSON.stringify(before) !== JSON.stringify(now);
}

// A failure that is GitHub's rate limit (the core's message, or gh's own).
export function isRateLimit(err: unknown): boolean {
  return /rate limit/i.test(String(err));
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// What the notice says moved from `old` to `now`: "Updated: 1 new commit ·
// 2 new comments · 1 thread resolved · checks finished", or "Updated" when
// none of those did (an edit, a label, a review without a body).
export function refreshNotice(old: PullRequestDetail, now: PullRequestDetail): string {
  const commits = new Set(old.commits.map((c) => c.oid));
  const newCommits = now.commits.filter((c) => !commits.has(c.oid)).length;
  // Comments by id: the conversation's, the lines', and reviews with a body
  // (which have no id: by author and time).
  const ids = (d: PullRequestDetail) =>
    new Set([
      ...d.comments.map((c) => `c${c.id}`),
      ...d.review_comments.map((c) => `l${c.id}`),
      ...d.reviews.filter((r) => r.body.trim()).map((r) => `r${r.author}@${r.submitted_at}`),
    ]);
  const before = ids(old);
  const newComments = [...ids(now)].filter((id) => !before.has(id)).length;
  const wasOpen = new Set(old.review_threads.filter((t) => !t.resolved).map((t) => t.id));
  const resolved = now.review_threads.filter((t) => t.resolved && wasOpen.has(t.id)).length;
  const running = (d: PullRequestDetail) => d.checks.some((c) => c.state === "pending");
  const finished = running(old) && now.checks.length > 0 && !running(now);
  const parts = [
    newCommits ? count(newCommits, "new commit", "new commits") : "",
    newComments ? count(newComments, "new comment", "new comments") : "",
    resolved ? `${count(resolved, "thread", "threads")} resolved` : "",
    finished ? "checks finished" : "",
  ].filter(Boolean);
  return parts.length ? `Updated: ${parts.join(" · ")}` : "Updated";
}
