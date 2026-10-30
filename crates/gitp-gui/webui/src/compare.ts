// Comparing two revisions in the detail pane — from two Cmd-clicked commits in
// the log, a ref's "Compare with Current Branch", or Quick Launch's Compare….
//
// The pane draws the comparison and is the one record of which is on screen
// (`ui.detailView.comparison()`); this only fetches it.

import { compareRevs, EMPTY_REV } from "./api";
import { state, ui } from "./app-state";
import { readFailed, setStatus } from "./report";
import { compareEndLabel } from "./views/detail";
import type { CommitRow } from "./types";

// Bumped by every request, and by every single-commit selection (see
// cancelComparison), so a slow comparison never lands over whatever the user
// asked for after it.
let seq = 0;

// Fetch and show the comparison of `base` with `head`. False when it failed
// (reported) or was overtaken by something newer.
export async function showComparison(base: string, head: string, threeDot: boolean): Promise<boolean> {
  const mine = ++seq;
  try {
    const cmp = await compareRevs(base, head, threeDot);
    if (mine !== seq) return false;
    ui.detailView?.showCompare(cmp);
    const n = cmp.files.length;
    setStatus(
      `${compareEndLabel(cmp.base)}${threeDot ? "..." : ".."}${compareEndLabel(cmp.head)}: ` +
        `${n} file${n === 1 ? "" : "s"} changed`,
    );
    return true;
  } catch (err) {
    if (mine === seq) readFailed("Compare failed", err);
    return false;
  }
}

// Drop any comparison still in flight — the user picked a single commit.
export function cancelComparison(): void {
  seq++;
}

// The two commits Cmd-clicked in the log, older as base, diffed directly
// (two-dot).
export function compareSelectedCommits(): Promise<boolean> {
  const [base, head] = olderFirst([...state.commitSelection], state.rows);
  return showComparison(base, head, false);
}

// The ends of the combined diff of `commits` (oldest first): from the oldest
// one's parent — the empty tree for a root commit — to the newest. Null unless
// they're one unbroken first-parent run, the only shape whose two-dot diff is
// exactly what those commits changed together.
export function combinedDiffEnds(commits: CommitRow[]): { base: string; head: string } | null {
  if (commits.length < 2) return null;
  for (let i = 1; i < commits.length; i++) {
    if (commits[i].parents[0] !== commits[i - 1].id) return null;
  }
  return { base: commits[0].parents[0] ?? EMPTY_REV, head: commits[commits.length - 1].id };
}

// Two commit ids, older first. `rows` is the log — newest-first and paged — so
// the older one sits further down, and one not loaded yet (a search hit, say)
// is older than any that is. Two such keep their order.
export function olderFirst([first, second]: string[], rows: CommitRow[]): [string, string] {
  const depth = (id: string) => {
    const i = rows.findIndex((r) => r.id === id);
    return i < 0 ? Infinity : i;
  };
  return depth(second) > depth(first) ? [second, first] : [first, second];
}
