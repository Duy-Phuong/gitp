// The review inbox's model: which pull requests need the user, why, and in
// which order (see views/inbox.ts for the view). The rows come from gitp-core's
// `InboxPr`, one repository at a time.

export interface InboxPr {
  repo: string;
  // The local repository it was read through: what a click opens.
  path: string;
  number: number;
  title: string;
  author: string;
  url: string;
  updated_at: string;
  checks: string | null;
  review_decision: string | null;
  // GitHub's mergeStateStatus: CLEAN when it can be merged now.
  merge_state: string;
  mine: boolean;
  review_requested: boolean;
  unresolved: number | null;
  // Unresolved threads with a reply ready or a fix commit.
  prepared: number;
}

// One repository's answer: its rows, or why there are none.
export interface InboxRepo {
  path: string;
  repo: string | null;
  prs: InboxPr[];
  error: string | null;
}

function readyToMerge(pr: InboxPr): boolean {
  return pr.review_decision === "APPROVED" && pr.merge_state === "CLEAN";
}

// Why it needs the user, in a few words each, as the row's tags. Unresolved
// threads have a column of their own, so they aren't one.
export function inboxReasons(pr: InboxPr): string[] {
  const reasons: string[] = [];
  if (pr.review_requested) reasons.push("review requested");
  if (!pr.mine) return reasons;
  if (pr.checks === "failure") reasons.push("checks failed");
  if (readyToMerge(pr)) reasons.push("ready to merge");
  return reasons;
}

export function needsYou(pr: InboxPr): boolean {
  return inboxReasons(pr).length > 0 || (pr.mine && (pr.unresolved ?? 0) > 0);
}

// Failed check first, then review requested, then the most unresolved
// threads, then the latest activity.
export function sortInbox(prs: InboxPr[]): InboxPr[] {
  const key = (pr: InboxPr) => [pr.checks === "failure" ? 0 : 1, pr.review_requested ? 0 : 1, -(pr.unresolved ?? 0)];
  return [...prs].sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0;
  });
}

export function groupInbox(prs: InboxPr[]): { needs: InboxPr[]; waiting: InboxPr[] } {
  const sorted = sortInbox(prs);
  return { needs: sorted.filter(needsYou), waiting: sorted.filter((pr) => !needsYou(pr)) };
}

// The repositories to ask: Open Recent, then the starred ones not in it. The
// backend merges two paths of one GitHub repository, keeping the first.
export function inboxPaths(recent: string[], starred: string[]): string[] {
  return [...new Set([...recent, ...starred])];
}
