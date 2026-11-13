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

// `short` is for the narrow sidebar.
export const PR_FILTERS: { value: PrFilter; label: string; short: string }[] = [
  { value: "all", label: "All", short: "All" },
  { value: "mine", label: "Created by me", short: "Mine" },
  { value: "review_requested", label: "Review requested", short: "Requested" },
  { value: "reviewed", label: "Reviewed", short: "Reviewed" },
  // Reviewed before commits came: time to review again.
  { value: "rereview", label: "Review again", short: "Again" },
  // The last 20 merged, the latest merge first.
  { value: "merged", label: "Merged", short: "Merged" },
];

// What gh lists for a filter: Reviewed is All narrowed to the pull requests
// with a saved review, and Review again to those with commits since; so both
// read All's list.
export type PrListing = Exclude<PrFilter, "reviewed" | "rereview">;
export function listingOf(filter: PrFilter): PrListing {
  return filter === "reviewed" || filter === "rereview" ? "all" : filter;
}

// The listings besides `filter`'s, read ahead so a switch shows at once.
export function otherListings(filter: PrFilter): PrListing[] {
  const own = listingOf(filter);
  return PR_FILTERS.map((f) => listingOf(f.value)).filter((l, i, all) => l !== own && all.indexOf(l) === i);
}

// The group a pull request of the All list belongs to, for its colour: Review
// again or Reviewed when there is a saved review, else Review requested when
// that list holds it, else Created by me; null for none of them.
export function prGroup(
  pr: Pick<PullRequest, "number" | "author">,
  login: string | null,
  requested: ReadonlySet<number>,
  mark: "reviewed" | "stale" | null,
): PrFilter | null {
  if (mark === "stale") return "rereview";
  if (mark === "reviewed") return "reviewed";
  if (requested.has(pr.number)) return "review_requested";
  if (login && pr.author === login) return "mine";
  return null;
}

// The tags that make a pull request stand out in the sidebar and the Pull
// Requests view: conflicts to resolve, line comments still to answer, and two
// approvals or more (ready to merge, as most repositories ask for two).
// `short` is for the narrow sidebar.
export function prAttentionTags(
  pr: Pick<PullRequest, "approvals" | "unresolved_threads"> & { conflicting?: boolean },
): { kind: "conflicts" | "unresolved" | "approvals"; text: string; short: string; title: string }[] {
  const tags: { kind: "conflicts" | "unresolved" | "approvals"; text: string; short: string; title: string }[] = [];
  if (pr.conflicting) {
    tags.push({ kind: "conflicts", text: "⚠ Conflicts", short: "⚠", title: "Has conflicts with its base branch: resolve them before it can be merged" });
  }
  const open = pr.unresolved_threads ?? 0;
  if (open > 0) {
    tags.push({ kind: "unresolved", text: `${open} unresolved`, short: `💬 ${open}`, title: `${open} comment thread${open === 1 ? "" : "s"} not resolved` });
  }
  if (pr.approvals >= 2) {
    tags.push({ kind: "approvals", text: `✓ ${pr.approvals} approvals`, short: `✓ ${pr.approvals}`, title: `Approved by ${pr.approvals} reviewers` });
  }
  return tags;
}

// --- Several pull requests at once (⌘-click) ---------------------------------

// The selection with `n` added, or taken out when it was in.
export function toggledSelection(selected: number[], n: number): number[] {
  return selected.includes(n) ? selected.filter((x) => x !== n) : [...selected, n];
}

// The pull requests a right-click on `clicked` acts on: the whole selection
// when it is one of two or more selected (and still listed), else itself.
export function menuTargets(selected: number[], clicked: number, listed: number[]): number[] {
  const live = selected.filter((n) => listed.includes(n));
  return live.length > 1 && live.includes(clicked) ? live : [clicked];
}

// `prs` split into the ones `login` may approve and their own, which GitHub
// refuses.
export function approvable<T extends { author: string }>(prs: T[], login: string | null): { others: T[]; own: T[] } {
  return { others: prs.filter((p) => !login || p.author !== login), own: login ? prs.filter((p) => p.author === login) : [] };
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
// when `descending`; ties keep the newest number first. "updated" is when a
// merged one was merged.
export function sortPrList(list: PullRequest[], key: PrSortKey, descending: boolean): PullRequest[] {
  // A merged one's time is its merge.
  const when = (pr: PullRequest) => time(pr.merged_at ?? pr.updated_at);
  const text = (pr: PullRequest): string =>
    key === "title" ? pr.title : key === "author" ? pr.author : key === "branches" ? `${pr.base}\0${pr.head}` : (pr.review_decision ?? "");
  const compare = (a: PullRequest, b: PullRequest): number =>
    key === "number" ? a.number - b.number : key === "updated" ? when(a) - when(b) : text(a).localeCompare(text(b));
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

// Whether it has conflicts with its base: GitHub says CONFLICTING, or DIRTY
// for the merge.
export function hasConflicts(pr: Pick<PullRequestDetail, "state" | "mergeable" | "merge_state">): boolean {
  return pr.state === "OPEN" && (pr.mergeable === "CONFLICTING" || pr.merge_state === "DIRTY");
}

// The reviewers whose latest approve-or-request-changes review approves, as
// GitHub counts them: a later comment doesn't take an approval back, a
// dismissal does.
export function approvalCount(reviews: Pick<PrReview, "author" | "state" | "submitted_at">[]): number {
  const latest = new Map<string, string>();
  const ordered = [...reviews].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
  for (const r of ordered) if (r.state !== "COMMENTED" && r.state !== "PENDING") latest.set(r.author, r.state);
  return [...latest.values()].filter((s) => s === "APPROVED").length;
}

// The pull request's reviewers, as GitHub's Reviewers box lists them: each
// person who reviewed, by the verdict that counts (their latest approve,
// request for changes or dismissal; a comment when that is all they left),
// and each one asked and not answered since. The author's own comments
// aren't a review.
export type ReviewerState = "requested" | "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
export interface ReviewerRow {
  id: string;
  team: boolean;
  state: ReviewerState;
  // Asked (again) and not answered since.
  requested: boolean;
}

export function reviewerRows(pr: Pick<PullRequestDetail, "author" | "reviews"> & { review_requests?: PullRequestDetail["review_requests"] }): ReviewerRow[] {
  const requests = pr.review_requests ?? [];
  const asked = new Set(requests.map((r) => r.id));
  const verdict = new Map<string, ReviewerState>();
  const ordered = [...pr.reviews].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
  for (const r of ordered) {
    if (r.author === pr.author || r.state === "PENDING") continue;
    if (r.state === "COMMENTED") {
      if (!verdict.has(r.author)) verdict.set(r.author, "COMMENTED");
    } else verdict.set(r.author, r.state as ReviewerState);
  }
  const rows: ReviewerRow[] = [...verdict].map(([id, state]) => ({ id, team: false, state, requested: asked.has(id) }));
  for (const r of requests) {
    if (!verdict.has(r.id)) rows.push({ id: r.id, team: r.team, state: "requested", requested: true });
  }
  return rows.sort((a, b) => Number(a.team) - Number(b.team) || a.id.toLowerCase().localeCompare(b.id.toLowerCase()));
}

// The logins to offer in the reviewer picker for `query`: the ones that
// contain it, those that start with it first, without `exclude` (already
// reviewers, the author), at most `limit`.
export function reviewerMatches(all: string[], query: string, exclude: string[], limit = 8): string[] {
  const q = query.trim().replace(/^@/, "").toLowerCase();
  const skip = new Set(exclude.map((e) => e.toLowerCase()));
  return all
    .filter((l) => !skip.has(l.toLowerCase()) && l.toLowerCase().includes(q))
    .sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)) || a.localeCompare(b))
    .slice(0, limit);
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

// Whether the signed-in user (`login`) may Fix the review drafts of a pull
// request by `author`: only their own; on someone else's the author fixes.
export function canFixDrafts(login: string | null | undefined, author: string): boolean {
  return !!login && login.toLowerCase() === author.toLowerCase();
}
