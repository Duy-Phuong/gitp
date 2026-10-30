// The decisions behind the worktree actions, kept pure so they're unit-tested
// (worktree-rules.test.ts): what dropping a branch on the Worktrees section
// creates, what a New Worktree from a commit checks out, and how unsaved work
// is described before a remove. worktree-actions.ts runs them.

import type { DragRef } from "./ref-drop";
import type { Worktree, WorktreeTarget, WorktreeUnsavedWork } from "./types";

// What a branch dropped on the Worktrees section does: open the worktree that
// already has it (git allows a branch in only one), or add one for it.
export type WorktreeDrop =
  | { kind: "open"; worktree: Worktree }
  | { kind: "add"; branch: string; target: WorktreeTarget };

// `localBranches`: every local branch name. `remote`: the remote a remote
// branch belongs to ("origin" for "origin/feat").
export function worktreeDrop(
  src: DragRef,
  localBranches: string[],
  worktrees: Worktree[],
  remote?: string,
): WorktreeDrop {
  // A remote branch gets a local one of the same name, as checking it out
  // would — unless that local branch exists already, which is used instead.
  const branch = src.kind === "remote" && remote ? src.name.slice(remote.length + 1) : src.name;
  const holder = worktrees.find((w) => w.branch === branch);
  if (holder) return { kind: "open", worktree: holder };
  if (src.kind === "local" || localBranches.includes(branch)) return { kind: "add", branch, target: { kind: "branch", name: branch } };
  return { kind: "add", branch, target: { kind: "new_branch", name: branch, start: src.name } };
}

// New Worktree at a commit or tag: on a new branch when one is named, else a
// detached HEAD there.
export function worktreeAtTarget(rev: string, newBranch: string): WorktreeTarget {
  const name = newBranch.trim();
  return name ? { kind: "new_branch", name, start: rev } : { kind: "detached", rev };
}

export function hasUnsavedWork(work: WorktreeUnsavedWork): boolean {
  return work.changed.length > 0 || work.unpushed > 0;
}

// How many changed paths the warning names before "and N more".
const LISTED_PATHS = 8;

// The warning's specifics, one paragraph per kind of risk. `branch` is what the
// worktree has checked out, null when detached.
export function describeUnsavedWork(work: WorktreeUnsavedWork, branch: string | null): string {
  const parts: string[] = [];
  const n = work.changed.length;
  if (n) {
    const untracked = work.untracked ? ` (${work.untracked} untracked)` : "";
    const shown = work.changed.slice(0, LISTED_PATHS).map((p) => `  ${p}`);
    if (n > LISTED_PATHS) shown.push(`  …and ${n - LISTED_PATHS} more`);
    parts.push(`${plural(n, "uncommitted change")}${untracked}, deleted with the folder:\n${shown.join("\n")}`);
  }
  if (work.unpushed) {
    const commits = plural(work.unpushed, "commit");
    parts.push(
      branch
        ? `${commits} on ${branch} not pushed to any remote.`
        : `${commits} on no branch (detached HEAD), which removing the worktree would orphan.`,
    );
  }
  return parts.join("\n\n");
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
