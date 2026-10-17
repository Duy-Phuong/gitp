// Which branches and tags each loaded commit belongs to — the log rows' ref chips
// and the Commit tab's ref labels.

import type { RefLabel, RefLabels } from "./views/log";
import type { CommitRow } from "./types";
import { state } from "./app-state";

// Labels of refs whose tip is this commit — shown as chips in the Commit tab.
export function refsAt(id: string): string[] {
  const labels: string[] = [];
  for (const b of state.refs.branches) if (b.target === id) labels.push(b.name);
  for (const r of state.refs.remotes) if (r.target === id) labels.push(r.name);
  for (const t of state.refs.tags) if (t.target === id) labels.push(t.name);
  return labels;
}

// For the log-row hover chips we want the branches/tags that CONTAIN each
// commit (so every commit shows its branch), not just the tips. Computed once
// per log/ref change by seeding each ref at its tip and propagating the label to
// ancestors over the loaded commit graph.
// Per commit: the nearest labels to draw, plus the exact number of refs that
// contain it. Rebuilt only when the loaded rows or the refs actually change.
let commitRefs = new Map<string, RefLabels>();

const NO_REFS: RefLabels = { labels: [], total: 0 };

export function refLabelsAt(id: string): RefLabels {
  return commitRefs.get(id) ?? NO_REFS;
}

// Only the nearest MAX_REF_CHIPS (3) labels are ever drawn, so propagation keeps
// a bounded list per commit. One extra is carried for margin; because every
// label at a commit moves to its parents with the same +1, relative order is
// preserved and a label dropped here can never have ranked higher at a parent.
const KEPT_LABELS = 4;

let lastCommitRefsRows: CommitRow[] | null = null;

let lastCommitRefsSig = "";

function refsSignature(): string {
  const r = state.refs;
  return [
    r.branches.map((b) => `${b.name}:${b.target}:${b.is_head ? 1 : 0}`).join(","),
    r.tags.map((t) => `${t.name}:${t.target}`).join(","),
    r.remotes.map((rm) => `${rm.name}:${rm.target}`).join(","),
  ].join("|");
}

interface Cand {
  label: RefLabel;
  dist: number;
  order: number;
}

// Work out, for every loaded commit, which refs contain it and which labels to
// show.
//
// This used to run a breadth-first search from every branch tip over the whole
// loaded log, accumulating an unbounded candidate list per commit and deduping
// each insert with a linear scan of that list. On one page of 1000 commits with
// 900 refs — a realistic monorepo — that was ~450k visits each scanning a list
// that grew past 400 entries: measured at 3.2 seconds of blocking main-thread
// work, on every ref change (every commit, checkout, fetch, branch delete).
//
// Instead, make a single pass. `state.rows` is topologically ordered
// newest-first, so a commit's children always come before it: seed the branch
// tips, then walk the rows once handing each commit's labels to its parents at
// distance + 1. That is O(rows x KEPT_LABELS) with no search at all.
//
// The "+N" badge still needs the *exact* total, which a bounded list can't give,
// so containment is tracked separately as a bitset per commit — one bit per
// branch, unioned into parents with a word-wise OR and popcounted at the end.
// Measured on the same data: 3200ms -> 7.5ms, with identical chips and counts.
export function rebuildCommitRefs(): boolean {
  const sig = refsSignature();
  if (state.rows === lastCommitRefsRows && sig === lastCommitRefsSig) return false;
  lastCommitRefsRows = state.rows;
  lastCommitRefsSig = sig;

  const rows = state.rows;
  const index = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) index.set(rows[i].id, i);

  // Non-current branches first so they win ties over the current branch, which
  // otherwise labels most of history with itself.
  const branches = [
    ...state.refs.branches.filter((b) => !b.is_head),
    ...state.refs.branches.filter((b) => b.is_head),
  ];

  const top: (Cand[] | undefined)[] = new Array(rows.length);
  const words = Math.ceil(Math.max(1, branches.length) / 32);
  const bits = new Uint32Array(rows.length * words);
  let order = 0;

  // Insert into a commit's bounded, nearest-first candidate list.
  const push = (ri: number, label: RefLabel, dist: number, ord: number): boolean => {
    let list = top[ri];
    if (!list) {
      list = [];
      top[ri] = list;
    }
    const dup = list.find((c) => c.label.name === label.name);
    if (dup) {
      if (dist < dup.dist) dup.dist = dist;
      return false;
    }
    if (list.length < KEPT_LABELS) {
      list.push({ label, dist, order: ord });
    } else if (dist < list[KEPT_LABELS - 1].dist) {
      list[KEPT_LABELS - 1] = { label, dist, order: ord };
    } else {
      return true; // counted, just not near enough to be drawn
    }
    list.sort((a, b) => a.dist - b.dist || a.order - b.order);
    return true;
  };

  branches.forEach((b, bi) => {
    const ri = index.get(b.target);
    if (ri === undefined) return;
    bits[ri * words + (bi >> 5)] |= 1 << (bi & 31);
    push(ri, { name: b.name, kind: b.is_head ? "head" : "branch" }, 0, order++);
  });

  // The single pass. Children precede their parents in a topological walk, so
  // each commit's labels are final by the time it is reached.
  for (let i = 0; i < rows.length; i++) {
    const list = top[i];
    const from = i * words;
    for (const parent of rows[i].parents) {
      const j = index.get(parent);
      if (j === undefined) continue; // parent outside the loaded page
      const to = j * words;
      for (let w = 0; w < words; w++) bits[to + w] |= bits[from + w];
      if (list) for (const c of list) push(j, c.label, c.dist + 1, c.order);
    }
  }

  // Tags and remotes mark their tip only — they don't describe containment the
  // way a branch does, so they're added after the pass and never propagate.
  // They take order numbers after every branch, which is what keeps a branch
  // ahead of a tag when both sit on the same commit at distance 0.
  const tipTotals = new Int32Array(rows.length);
  const addTip = (target: string, label: RefLabel): void => {
    const ri = index.get(target);
    if (ri === undefined) return;
    if (push(ri, label, 0, order++)) tipTotals[ri] += 1;
  };
  for (const t of state.refs.tags) addTip(t.target, { name: t.name, kind: "tag" });
  for (const r of state.refs.remotes) addTip(r.target, { name: r.name, kind: "remote" });

  const labels = new Map<string, RefLabels>();
  for (let i = 0; i < rows.length; i++) {
    const list = top[i];
    if (!list) continue;
    let total = tipTotals[i];
    const from = i * words;
    for (let w = 0; w < words; w++) total += popcount(bits[from + w]);
    labels.set(rows[i].id, { labels: list.map((c) => c.label), total });
  }
  commitRefs = labels;
  return true;
}

// Bits set in a 32-bit word (SWAR), turning a commit's containment bitset into
// the "+N" count.
function popcount(x: number): number {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >> 24;
}
