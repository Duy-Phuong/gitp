// What dropping one branch on another can do — GitKraken's drag-and-drop menu.
// Pure, so the rules are unit-tested (ref-drop.test.ts); ref-actions.ts turns
// them into menu items and views/ref-drag.ts does the dragging.

import type { CommitRow } from "./types";

// A branch being dragged or dropped on: a local branch, or a remote branch by
// its full name ("origin/dev").
export interface DragRef {
  kind: "local" | "remote";
  name: string;
}

// A DragRef with the commit it points at.
export interface DropRef extends DragRef {
  target: string;
}

export type DropAction =
  // Merge the dragged branch into the checked-out branch it was dropped on.
  | "merge"
  // The checked-out branch was dragged: rebase it onto the drop target, plain
  // or interactively, or reset it there.
  | "rebase"
  | "interactive-rebase"
  | "reset"
  // Move the local branch dropped on up to the dragged one.
  | "fast-forward"
  // Push the dragged local branch to the remote branch dropped on.
  | "push";

// The actions that make sense for dropping `src` on `dst`, in menu order.
// `head` is the checked-out branch (null when detached); `isAncestor(a, d)`
// says whether commit `a` is an ancestor of commit `d`.
export function dropActions(
  src: DropRef,
  dst: DropRef,
  head: string | null,
  isAncestor: (ancestor: string, descendant: string) => boolean,
): DropAction[] {
  if (src.kind === dst.kind && src.name === dst.name) return [];
  const isCurrent = (r: DropRef) => r.kind === "local" && r.name === head;
  const moved = src.target !== dst.target;
  const actions: DropAction[] = [];
  if (isCurrent(dst) && moved) actions.push("merge");
  if (isCurrent(src) && moved) actions.push("rebase", "interactive-rebase", "reset");
  if (dst.kind === "local" && moved && isAncestor(dst.target, src.target)) actions.push("fast-forward");
  if (src.kind === "local" && dst.kind === "remote") actions.push("push");
  return actions;
}

// Whether `ancestor` is reachable from `descendant` over the loaded rows.
// The rows are topologically ordered (children before parents), so one pass
// from the descendant down to the ancestor settles it; a commit that isn't
// loaded counts as not an ancestor.
export function isAncestorInRows(rows: CommitRow[], ancestor: string, descendant: string): boolean {
  const from = rows.findIndex((r) => r.id === descendant);
  if (from < 0) return false;
  const reached = new Set([descendant]);
  for (let i = from; i < rows.length; i++) {
    const row = rows[i];
    if (row.id === ancestor) return reached.has(ancestor);
    if (reached.has(row.id)) for (const p of row.parents) reached.add(p);
  }
  return false;
}
