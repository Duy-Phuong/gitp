// The repo's other worktrees in the graph: a WIP row for each one with
// uncommitted changes (GitKraken shows one per worktree), and which branches
// they have checked out, for the worktree mark on those branches' badges.

import type { Worktree } from "./types";
import { worktreeName } from "./views/sidebar";

// One WIP row above the graph.
export interface WipRow {
  changes: number;
  // The commit its dashed line runs down to; null on an unborn branch.
  head: string | null;
  // Set on another worktree's row: what it is labelled with and opens.
  worktree?: { name: string; path: string };
}

// The other worktrees that have uncommitted changes, as WIP rows. The counts
// are joined to the worktree list by path, which supplies each one's HEAD; a
// count for a worktree that isn't listed (any more, or not in this repo after
// a tab switch) is dropped, as is the current worktree, which has its own row.
export function otherWipRows(worktrees: Worktree[], counts: { path: string; changes: number }[]): WipRow[] {
  const changes = new Map(counts.map((c) => [c.path, c.changes]));
  const out: WipRow[] = [];
  for (const w of worktrees) {
    const n = changes.get(w.path) ?? 0;
    if (w.is_current || w.prunable || n === 0) continue;
    out.push({ changes: n, head: w.head, worktree: { name: worktreeName(w), path: w.path } });
  }
  return out;
}

// The WIP rows top to bottom: the current worktree's first, where it has
// always been, then the others in the graph order of their HEADs — so each
// dashed line is short as it can be and lines in one lane don't cross — and
// those whose HEAD isn't loaded last. `rowOf` gives a commit's row, or -1.
export function orderWipRows(current: WipRow | null, others: WipRow[], rowOf: (id: string) => number): WipRow[] {
  // Each HEAD looked up once: `rowOf` scans the loaded log.
  const keyed = others.map((r) => {
    const i = r.head ? rowOf(r.head) : -1;
    return { r, at: i < 0 ? Infinity : i };
  });
  keyed.sort((a, b) => a.at - b.at || (a.r.worktree?.name ?? "").localeCompare(b.r.worktree?.name ?? ""));
  const sorted = keyed.map((k) => k.r);
  return current ? [current, ...sorted] : sorted;
}

// Local branches checked out in another worktree, to that worktree's path.
// They can't be checked out here — git refuses — so their badges open the
// worktree instead.
export function branchesElsewhere(worktrees: Worktree[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of worktrees) if (w.branch && !w.is_current && !w.prunable) out.set(w.branch, w.path);
  return out;
}
