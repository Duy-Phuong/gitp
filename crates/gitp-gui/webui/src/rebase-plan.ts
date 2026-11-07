// The pure parts of the interactive-rebase editor: what a plan produces
// (squash groups, the "9 commits → 5" summary), the edits that work on many
// rows at once (move, squash into one, autosquash), and the steps sent to the
// backend. views/rebase.ts draws it.

import type { RebaseAction, RebaseCommit, RebaseStep } from "./types";

export interface PlanRow {
  commit: RebaseCommit;
  action: RebaseAction;
  // The full message: the subject until the commit's own message is loaded
  // (`loaded`), then that, as the reword editor shows and edits it.
  message: string;
  loaded: boolean;
}

export const isMeld = (a: RebaseAction) => a === "squash" || a === "fixup";

// The row a squash/fixup at `i` melds into: the nearest earlier row that lands
// a commit of its own (dropped rows and other melds are skipped). -1 for a row
// that isn't a meld, or a meld with nothing before it.
export function groupHead(rows: PlanRow[], i: number): number {
  if (!isMeld(rows[i].action)) return -1;
  for (let k = i - 1; k >= 0; k--) {
    const a = rows[k].action;
    if (a === "drop" || isMeld(a)) continue;
    return k;
  }
  return -1;
}

// Each group head's melds, in order: head index → meld indices.
export function groups(rows: PlanRow[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  rows.forEach((_, i) => {
    const head = groupHead(rows, i);
    if (head < 0) return;
    const list = out.get(head) ?? [];
    list.push(i);
    out.set(head, list);
  });
  return out;
}

export interface PlanSummary {
  before: number;
  after: number;
  dropped: number;
  melded: number;
}

export function planSummary(rows: PlanRow[]): PlanSummary {
  const dropped = rows.filter((r) => r.action === "drop").length;
  const melded = rows.filter((r) => isMeld(r.action)).length;
  return { before: rows.length, after: rows.length - dropped - melded, dropped, melded };
}

// The message git makes for a squash group: the head's message, then each
// squashed commit's (a fixup's is left out).
export function defaultGroupMessage(head: string, melds: { action: RebaseAction; message: string }[]): string {
  const parts = [head.trimEnd()];
  for (const m of melds) if (m.action === "squash") parts.push(m.message.trimEnd());
  return parts.join("\n\n");
}

// Why the plan can't run, or null: git refuses a first commit that melds into
// nothing, and an empty message.
export function planProblem(rows: PlanRow[], groupMessages: Map<string, string>, melds: string): string | null {
  const first = rows.find((r) => r.action !== "drop");
  if (first && isMeld(first.action)) return `The first applied commit can't be ${melds}.`;
  const empty = rows.find((r) => r.action === "reword" && r.loaded && !r.message.trim());
  if (empty) return `The new message for ${empty.commit.short_sha} is empty.`;
  for (const [head, msg] of groupMessages) {
    if (!msg.trim() && rows.some((r) => r.commit.sha === head)) return "A combined message is empty.";
  }
  return null;
}

// The steps for the backend. A reword sends its message; the last meld of a
// group sends the group's edited message, when there is one.
export function planSteps(rows: PlanRow[], groupMessages: Map<string, string>): RebaseStep[] {
  const lastMeld = new Map<number, string>(); // meld index → its head's sha
  for (const [head, melds] of groups(rows)) lastMeld.set(melds[melds.length - 1], rows[head].commit.sha);
  return rows.map((r, i) => {
    let message: string | null = null;
    if (r.action === "reword") message = r.message;
    const head = lastMeld.get(i);
    if (head !== undefined) message = groupMessages.get(head) ?? null;
    return { sha: r.commit.sha, action: r.action, message };
  });
}

// Move every selected row by `delta` (±1), keeping their order. Null when a
// selected row is already at that end.
export function moveRows(rows: PlanRow[], selected: Set<number>, delta: 1 | -1): { rows: PlanRow[]; selected: Set<number> } | null {
  const idx = [...selected].sort((a, b) => a - b);
  if (!idx.length) return null;
  if (delta < 0 ? idx[0] === 0 : idx[idx.length - 1] === rows.length - 1) return null;
  const out = rows.slice();
  const order = delta < 0 ? idx : idx.slice().reverse();
  for (const i of order) [out[i], out[i + delta]] = [out[i + delta], out[i]];
  return { rows: out, selected: new Set(idx.map((i) => i + delta)) };
}

// "Squash into one": the selected rows gather under the first of them, which
// lands the commit (pick, unless it was already edit or reword), and the
// rest squash into it.
export function squashIntoOne(rows: PlanRow[], selected: Set<number>): { rows: PlanRow[]; selected: Set<number> } | null {
  const idx = [...selected].sort((a, b) => a - b);
  if (idx.length < 2) return null;
  const first = { ...rows[idx[0]] };
  if (first.action === "drop" || isMeld(first.action)) first.action = "pick";
  const melds = idx.slice(1).map((i): PlanRow => ({ ...rows[i], action: "squash" }));
  const taken = new Set(idx);
  const out: PlanRow[] = [];
  rows.forEach((r, i) => {
    if (i === idx[0]) out.push(first, ...melds);
    else if (!taken.has(i)) out.push(r);
  });
  const at = out.indexOf(first);
  return { rows: out, selected: new Set(idx.map((_, k) => at + k)) };
}

// What a "fixup! X" / "squash! X" / "amend! X" subject points at: X, after
// any repeated prefixes, and the action it asks for. Null for other subjects.
export function autosquashTarget(subject: string): { target: string; action: RebaseAction } | null {
  const m = /^(fixup|squash|amend)! (.+)$/.exec(subject);
  if (!m) return null;
  let target = m[2];
  while (/^(fixup|squash|amend)! /.test(target)) target = target.replace(/^(fixup|squash|amend)! /, "");
  return { target, action: m[1] === "squash" ? "squash" : "fixup" };
}

// git rebase --autosquash: each "fixup!/squash!/amend!" commit moves under the
// commit it names (by subject, or by a sha prefix of four or more characters)
// and melds into it. Null when no commit in the plan names another.
export function autosquash(rows: PlanRow[]): PlanRow[] | null {
  const find = (target: string, self: number) =>
    rows.findIndex(
      (r, i) =>
        i !== self &&
        !autosquashTarget(r.commit.subject) &&
        (r.commit.subject === target || (target.length >= 4 && !target.includes(" ") && r.commit.sha.startsWith(target))),
    );
  const moves = new Map<number, number[]>(); // target index → meld indices, in order
  const moving = new Set<number>();
  rows.forEach((r, i) => {
    const t = autosquashTarget(r.commit.subject);
    if (!t) return;
    const at = find(t.target, i);
    if (at < 0) return;
    moving.add(i);
    moves.set(at, [...(moves.get(at) ?? []), i]);
  });
  if (!moving.size) return null;
  const out: PlanRow[] = [];
  rows.forEach((r, i) => {
    if (moving.has(i)) return;
    out.push(r);
    for (const m of moves.get(i) ?? []) {
      out.push({ ...rows[m], action: autosquashTarget(rows[m].commit.subject)!.action });
    }
  });
  return out;
}

// How many "fixup!/squash!" rows autosquash would move or change — for its
// button; 0 when they are all in place already.
export function autosquashCount(rows: PlanRow[]): number {
  const after = autosquash(rows);
  if (!after) return 0;
  return after.filter(
    (r, i) => autosquashTarget(r.commit.subject) && (rows[i].commit.sha !== r.commit.sha || rows[i].action !== r.action),
  ).length;
}
