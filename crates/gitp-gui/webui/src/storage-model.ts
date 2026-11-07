// The Clean Up Storage dialog's rules: which worktrees are safe to remove,
// which merged branches to offer, and sizes in words.

import type { Worktree, WorktreeUnsavedWork } from "./types";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// A linked worktree is safe to remove when nothing in it would be lost: no
// changed or untracked files, and its commits are pushed or already in the
// default branch. Otherwise, why not.
export function worktreeVerdict(
  w: Worktree,
  work: WorktreeUnsavedWork,
  merged: Set<string>,
): { safe: boolean; why: string } {
  if (w.is_main) return { safe: false, why: "the main worktree" };
  if (w.is_current) return { safe: false, why: "open in this tab" };
  if (w.locked) return { safe: false, why: "locked" };
  const lost: string[] = [];
  if (work.changed.length) lost.push(plural(work.changed.length, "changed file"));
  if (work.untracked) lost.push(plural(work.untracked, "untracked file"));
  const mergedHere = w.branch !== null && merged.has(w.branch);
  if (work.unpushed && !mergedHere) lost.push(plural(work.unpushed, "unpushed commit"));
  if (lost.length) return { safe: false, why: lost.join(", ") };
  return { safe: true, why: mergedHere ? "merged, nothing uncommitted" : "pushed, nothing uncommitted" };
}

// The merged branches git can delete now: not checked out in any worktree.
export function deletableBranches(merged: string[], worktrees: Worktree[]): string[] {
  const out = new Set(worktrees.map((w) => w.branch).filter((b): b is string => b !== null));
  return merged.filter((b) => !out.has(b));
}
