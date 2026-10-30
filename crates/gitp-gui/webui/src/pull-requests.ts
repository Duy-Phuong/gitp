// Pull requests: the pure parts of the sidebar section and the pull request
// view — the filters, the conversation in time order, line-comment threads,
// and where on a diff a new comment goes. The DOM is in views/sidebar.ts and
// views/pull-request.ts.

import type { DiffLine, PrCheck, PrFilter, PrReview, PrComment, PrReviewComment, PullRequest, PullRequestDetail } from "./types";

export const PR_FILTERS: { value: PrFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "mine", label: "Created by me" },
  { value: "review_requested", label: "Review requested" },
];

// A line comment and its replies, oldest first.
export interface Thread {
  root: PrReviewComment;
  replies: PrReviewComment[];
}

export type TimelineItem =
  | { kind: "comment"; at: string; comment: PrComment }
  | { kind: "review"; at: string; review: PrReview }
  | { kind: "thread"; at: string; thread: Thread };

const time = (iso: string) => Date.parse(iso) || 0;

// Line comments as threads, in the order they were started. GitHub points
// every reply at the thread's first comment, so one level is all there is;
// a reply whose first comment isn't there (deleted) starts its own thread.
export function reviewThreads(comments: PrReviewComment[]): Thread[] {
  const byTime = [...comments].sort((a, b) => time(a.created_at) - time(b.created_at));
  const threads = new Map<number, Thread>();
  for (const c of byTime) {
    const parent = c.in_reply_to !== null ? threads.get(c.in_reply_to) : undefined;
    if (parent) parent.replies.push(c);
    else threads.set(c.id, { root: c, replies: [] });
  }
  return [...threads.values()];
}

// The conversation as GitHub shows it: comments, reviews and line-comment
// threads by when each began. A review that only carries line comments (a
// "commented" one with no text of its own) adds nothing the threads don't
// show, so it is left out.
export function prTimeline(pr: PullRequestDetail): TimelineItem[] {
  const items: TimelineItem[] = [
    ...pr.comments.map((comment) => ({ kind: "comment" as const, at: comment.created_at, comment })),
    ...pr.reviews
      .filter((r) => r.body.trim() || r.state !== "COMMENTED")
      .map((review) => ({ kind: "review" as const, at: review.submitted_at, review })),
    ...reviewThreads(pr.review_comments).map((thread) => ({ kind: "thread" as const, at: thread.root.created_at, thread })),
  ];
  // Stable: same-instant items keep comments, then reviews, then threads.
  return items.map((item, i) => ({ item, i })).sort((a, b) => time(a.item.at) - time(b.item.at) || a.i - b.i).map((x) => x.item);
}

// Where a comment on `line` goes: the new file's line for an added or
// unchanged one (RIGHT), the old file's for a removed one (LEFT).
export function lineTarget(line: DiffLine): { line: number; side: "LEFT" | "RIGHT" } | null {
  if (line.origin === "-") return line.old_lineno != null ? { line: line.old_lineno, side: "LEFT" } : null;
  if (line.origin === "+" || line.origin === " ") return line.new_lineno != null ? { line: line.new_lineno, side: "RIGHT" } : null;
  return null;
}

// The key a diff line and a thread on it share (see threadsByLine).
export function lineKey(path: string, side: "LEFT" | "RIGHT", line: number): string {
  return `${side}:${line}:${path}`;
}

// The current (not outdated) threads, by the line they are on.
export function threadsByLine(threads: Thread[]): Map<string, Thread[]> {
  const out = new Map<string, Thread[]>();
  for (const t of threads) {
    if (t.root.line === null) continue;
    const key = lineKey(t.root.path, t.root.side, t.root.line);
    out.set(key, [...(out.get(key) ?? []), t]);
  }
  return out;
}

// A reply to a comment that has no thread on GitHub (one on the pull request
// itself, or a review): a new comment that quotes it.
export function quoteReply(author: string, body: string): string {
  const quoted = body.trim().split("\n").map((l) => `> ${l}`.trimEnd());
  return `@${author} wrote:\n${quoted.join("\n")}\n\n`;
}

// "2 failing, 1 pending, 3 passing" — what the Checks tab and the header say.
export function checksSummary(checks: PrCheck[]): string {
  const count = (state: string) => checks.filter((c) => c.state === state).length;
  const parts = [
    [count("failure"), "failing"],
    [count("pending"), "pending"],
    [count("success"), "passing"],
    [count("skipped") + count("neutral"), "skipped"],
  ]
    .filter(([n]) => n)
    .map(([n, word]) => `${n} ${word}`);
  return parts.length ? parts.join(", ") : "No checks";
}

// The review state in words, for a badge.
export function reviewDecisionLabel(decision: string | null): string | null {
  switch (decision) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes requested";
    case "REVIEW_REQUIRED":
      return "review required";
    default:
      return null;
  }
}

// What a review did, after its author's name.
export function reviewVerb(state: string): string {
  switch (state) {
    case "APPROVED":
      return "approved these changes";
    case "CHANGES_REQUESTED":
      return "requested changes";
    case "DISMISSED":
      return "reviewed (dismissed)";
    default:
      return "reviewed";
  }
}

// Whether the sidebar filter text matches a pull request: its number, title,
// author or branch.
export function prMatches(pr: PullRequest, match: (text: string) => boolean): boolean {
  return match(`#${pr.number}`) || match(pr.title) || match(pr.author) || match(pr.head);
}

// "3h ago" for GitHub's ISO times.
export function isoSeconds(iso: string): number {
  return Math.floor(time(iso) / 1000);
}
