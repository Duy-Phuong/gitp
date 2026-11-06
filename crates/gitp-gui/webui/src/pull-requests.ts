// Pull requests: the pure parts of the sidebar section and the pull request
// view — the filters, the conversation in time order, line-comment threads,
// and where on a diff a new comment goes. The DOM is in views/sidebar.ts and
// views/pull-request.ts.

import type {
  DiffLine,
  FileDiff,
  GitHubRepoSettings,
  MergeMethod,
  PrCheck,
  PrFilter,
  PrReview,
  PrComment,
  PrReviewComment,
  PullRequest,
  PullRequestDetail,
} from "./types";

export const PR_FILTERS: { value: PrFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "mine", label: "Created by me" },
  { value: "review_requested", label: "Review requested" },
  { value: "reviewed", label: "Reviewed" },
];

// The tags that make a pull request stand out in the sidebar and the Pull
// Requests view: line comments still to answer, and two approvals or more
// (ready to merge, as most repositories ask for two). `short` is for the
// narrow sidebar.
export function prAttentionTags(
  pr: Pick<PullRequest, "approvals" | "unresolved_threads">,
): { kind: "unresolved" | "approvals"; text: string; short: string; title: string }[] {
  const tags: { kind: "unresolved" | "approvals"; text: string; short: string; title: string }[] = [];
  const open = pr.unresolved_threads ?? 0;
  if (open > 0) {
    tags.push({ kind: "unresolved", text: `${open} unresolved`, short: `💬 ${open}`, title: `${open} comment thread${open === 1 ? "" : "s"} not resolved` });
  }
  if (pr.approvals >= 2) {
    tags.push({ kind: "approvals", text: `✓ ${pr.approvals} approvals`, short: `✓ ${pr.approvals}`, title: `Approved by ${pr.approvals} reviewers` });
  }
  return tags;
}

// The Pull Requests view's own filters, beside the sidebar's; "" (no
// author) lets any through.
export interface PrListFilters {
  // Any of these.
  authors: string[];
  base: string;
  // success / failure / pending, or "none" for no checks.
  checks: string;
  // APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED, or "none".
  review: string;
  // "draft" or "ready".
  draft: string;
}

export const NO_PR_LIST_FILTERS: PrListFilters = { authors: [], base: "", checks: "", review: "", draft: "" };

export function hasPrListFilters(f: PrListFilters): boolean {
  return f.authors.length > 0 || Boolean(f.base || f.checks || f.review || f.draft);
}

export function filterPrList(list: PullRequest[], f: PrListFilters): PullRequest[] {
  return list.filter(
    (pr) =>
      (f.authors.length === 0 || f.authors.includes(pr.author)) &&
      (!f.base || pr.base === f.base) &&
      (!f.checks || (pr.checks ?? "none") === f.checks) &&
      (!f.review || (pr.review_decision ?? "none") === f.review) &&
      (!f.draft || pr.is_draft === (f.draft === "draft")),
  );
}

// The authors and base branches in `list`, for the view's dropdowns, A to Z.
export function prListChoices(list: PullRequest[]): { authors: string[]; bases: string[] } {
  const sorted = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
  return { authors: sorted(list.map((pr) => pr.author)), bases: sorted(list.map((pr) => pr.base)) };
}

export type PrSortKey = "number" | "title" | "author" | "branches" | "review" | "updated";

// `list` sorted by `key`: A to Z, oldest or smallest first, or the other way
// when `descending`; ties keep the newest number first.
export function sortPrList(list: PullRequest[], key: PrSortKey, descending: boolean): PullRequest[] {
  const text = (pr: PullRequest): string =>
    key === "title" ? pr.title : key === "author" ? pr.author : key === "branches" ? `${pr.base}\0${pr.head}` : (pr.review_decision ?? "");
  const compare = (a: PullRequest, b: PullRequest): number =>
    key === "number" ? a.number - b.number : key === "updated" ? time(a.updated_at) - time(b.updated_at) : text(a).localeCompare(text(b));
  return [...list].sort((a, b) => (descending ? compare(b, a) : compare(a, b)) || b.number - a.number);
}

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

// How many current threads each file has, for its header in the Files tab.
export function threadsPerFile(threads: Thread[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of threads) {
    if (t.root.line !== null) out.set(t.root.path, (out.get(t.root.path) ?? 0) + 1);
  }
  return out;
}

// The Files tab's search, per file: `null` when it doesn't match — neither
// its name (old or new) nor any line of its diff holds the query, ignoring
// case — else the [hunk, line] of each line that does, to mark. A blank
// query keeps every file and marks nothing.
export function searchFiles(files: FileDiff[], query: string): ([number, number][] | null)[] {
  const q = query.trim().toLowerCase();
  if (!q) return files.map(() => []);
  return files.map((file) => {
    const hits: [number, number][] = [];
    file.hunks.forEach((hunk, h) =>
      hunk.lines.forEach((line, k) => {
        if (line.content.toLowerCase().includes(q)) hits.push([h, k]);
      }),
    );
    const named = [file.path, file.old_path ?? ""].some((name) => name.toLowerCase().includes(q));
    return named || hits.length ? hits : null;
  });
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
// The pull request number a search names ("3531" or "#3531"), if it is one.
export function prNumberQuery(query: string): number | null {
  const m = /^#?(\d{1,9})$/.exec(query.trim());
  return m ? Number(m[1]) : null;
}

export function prMatches(pr: PullRequest, match: (text: string) => boolean): boolean {
  return match(`#${pr.number}`) || match(pr.title) || match(pr.author) || match(pr.head);
}

// "3h ago" for GitHub's ISO times.
export function isoSeconds(iso: string): number {
  return Math.floor(time(iso) / 1000);
}

// Before a merge: what stops it (GitHub would refuse it outright) or what
// GitHub may refuse it for, which the user can still try.
export function mergeAdvice(pr: PullRequestDetail): { blocked: string | null; warning: string | null } {
  const blocked = (text: string) => ({ blocked: text, warning: null });
  const warning = (text: string) => ({ blocked: null, warning: text });
  if (pr.state === "MERGED") return blocked(`#${pr.number} is already merged.`);
  if (pr.state !== "OPEN") return blocked(`#${pr.number} is closed.`);
  if (pr.is_draft || pr.merge_state === "DRAFT") return blocked(`#${pr.number} is a draft: mark it ready for review on GitHub first.`);
  if (pr.mergeable === "CONFLICTING" || pr.merge_state === "DIRTY") {
    return blocked(`#${pr.number} has conflicts with ${pr.base}: resolve them first.`);
  }
  switch (pr.merge_state) {
    case "BLOCKED":
      return warning("GitHub reports it blocked: a required review or check is missing, so the merge may be refused.");
    case "BEHIND":
      return warning(`${pr.head} is behind ${pr.base}; if the repository requires it up to date, the merge will be refused.`);
    case "UNSTABLE":
      return warning("Some checks are failing.");
    case "UNKNOWN":
      return warning("GitHub is still checking whether it merges cleanly.");
  }
  return { blocked: null, warning: null };
}

const MERGE_CHOICES: { value: MergeMethod; label: string; allowed: (s: GitHubRepoSettings) => boolean }[] = [
  { value: "squash", label: "Squash and merge", allowed: (s) => s.squash },
  { value: "merge", label: "Create a merge commit", allowed: (s) => s.merge_commit },
  { value: "rebase", label: "Rebase and merge", allowed: (s) => s.rebase },
];

// The merge methods to offer: those the repository allows, squash first — or
// every one, when GitHub didn't say (it then refuses any it doesn't allow).
export function mergeChoices(settings: GitHubRepoSettings): { value: MergeMethod; label: string }[] {
  const allowed = MERGE_CHOICES.filter((c) => c.allowed(settings));
  return (allowed.length ? allowed : MERGE_CHOICES).map(({ value, label }) => ({ value, label }));
}

// The method to pre-select for merging `head`: a merge commit for a release
// branch or a sync of develop, master or main — squashing one loses where the
// branches met, and the next sync brings the same changes back — else a squash,
// one commit per feature or fix. The first allowed one when that isn't.
export function defaultMergeMethod(head: string, choices: { value: MergeMethod }[]): MergeMethod {
  const wanted: MergeMethod = /^(release\/|develop(\/|$)|master$|main$)/.test(head) ? "merge" : "squash";
  return choices.some((c) => c.value === wanted) ? wanted : choices[0].value;
}

// The remote that holds `repo` ("owner/name", or "host/owner/name" off
// github.com), the one the pull requests are in: its branches are the bases.
export function githubRemoteName(remotes: { name: string; url: string | null }[], repo: string): string | null {
  const path = repo.split("/").slice(-2).join("/").toLowerCase();
  const found = remotes.find((r) => {
    const url = (r.url ?? "").toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
    return url.endsWith(`/${path}`) || url.endsWith(`:${path}`);
  });
  return found?.name ?? null;
}

// The branches a pull request can go into: `remote`'s, as last fetched, with
// the repository's default first (listed even when it isn't fetched).
export function baseBranches(remoteBranches: string[], remote: string, defaultBranch: string): string[] {
  const prefix = `${remote}/`;
  const names = remoteBranches.filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length));
  return [defaultBranch, ...names.filter((n) => n !== "HEAD" && n !== defaultBranch).sort()];
}
