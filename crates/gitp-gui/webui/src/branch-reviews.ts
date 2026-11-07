// The review of a local branch before any pull request exists: per repo and
// branch, the panel's data (the diff against the base, how the files moved
// since the reviewed head, the worktree), whether a review or a fix runs, and
// the base chosen in "Against". The drafts themselves live in pr-reviews.ts
// (reviewFor with a branch key), so both views share them.
//
// A draft's line is where it was at the reviewed head. When the branch moved
// on, each line is carried through the diff from that head to the current
// one: pure hunk arithmetic, below.

import type { Draft } from "./pr-reviews";
import type { BranchReviewData, FileDiff } from "./types";

export interface BranchReviewState {
  branch: string;
  base: string;
  data: BranchReviewData | null;
  loading: boolean;
  running: boolean;
  error: string | null;
  // The draft a fix runs on, if any: one fix per branch.
  fixing: number | null;
}

const states = new Map<string, BranchReviewState>();

export function branchState(repo: string, branch: string): BranchReviewState {
  const key = `${repo}\n${branch}`;
  let s = states.get(key);
  if (!s) {
    s = { branch, base: "", data: null, loading: false, running: false, error: null, fixing: null };
    states.set(key, s);
  }
  return s;
}

// --- The base, per branch -------------------------------------------------------

const BASE_KEY = "gitp-review-base";

function loadBases(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(BASE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function loadReviewBase(repo: string, branch: string): string | null {
  return loadBases()[`${repo}\n${branch}`] ?? null;
}

export function saveReviewBase(repo: string, branch: string, base: string): void {
  const all = loadBases();
  all[`${repo}\n${branch}`] = base;
  try {
    localStorage.setItem(BASE_KEY, JSON.stringify(all));
  } catch {
    // Full or blocked storage: the default base next time.
  }
}

// --- Carrying a line to the current head -----------------------------------------

// "@@ -os,oc +ns,nc @@": the counts default to 1.
function hunkRange(header: string): { os: number; oc: number; nc: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!m) return null;
  return { os: Number(m[1]), oc: m[2] === undefined ? 1 : Number(m[2]), nc: m[4] === undefined ? 1 : Number(m[4]) };
}

// Where old line `line` of the file is after `file`'s change (the diff from
// the reviewed head to now; undefined when the file didn't change). Null when
// the line itself was removed or changed.
export function remapLine(line: number, file: FileDiff | undefined): number | null {
  if (!file) return line;
  if (file.status === "Deleted") return null;
  let delta = 0;
  for (const h of file.hunks) {
    const r = hunkRange(h.header);
    if (!r) continue;
    // A pure insertion (oc 0) sits after old line os.
    if (r.oc === 0 ? line <= r.os : line < r.os) return line + delta;
    if (r.oc > 0 && line < r.os + r.oc) {
      const at = h.lines.find((l) => l.old_lineno === line);
      return at && at.origin === " " ? at.new_lineno : null;
    }
    delta += r.nc - r.oc;
  }
  // Past the hunks of a diff cut at its line cap: the shift is unknown.
  return file.truncated ? null : line + delta;
}

export interface Placed {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  moved: boolean;
}

// Where draft `d` is now: its new-file line carried through `moves` (null:
// the reviewed head is gone, so every such line counts as moved). A removed
// line (LEFT) is in the base, which the branch moving doesn't change.
export function placeDraft(d: Draft, moves: FileDiff[] | null): Placed {
  const same: Placed = { path: d.path, line: d.line, side: d.side, moved: false };
  // Kept from a run older than the reviewed head: its line is from then.
  if (d.stale && d.path) return { ...same, moved: true };
  if (d.side === "LEFT" || !d.path) return same;
  if (moves === null) return { ...same, moved: true };
  const file = moves.find((f) => (f.old_path ?? f.path) === d.path);
  const line = remapLine(d.line, file);
  return line === null ? { ...same, moved: true } : { path: file?.path ?? d.path, line, side: d.side, moved: false };
}

// The hunk of `files` that holds `line` of `path` on `side`, as diff text
// ("@@ … @@" then each line with its origin); "" when no hunk has it.
export function hunkAround(files: FileDiff[], path: string, line: number, side: "LEFT" | "RIGHT"): string {
  const file = files.find((f) => f.path === path);
  const hunk = file?.hunks.find((h) => h.lines.some((l) => (side === "LEFT" ? l.old_lineno : l.new_lineno) === line));
  if (!hunk) return "";
  return [hunk.header, ...hunk.lines.map((l) => `${l.origin}${l.content}`)].join("\n");
}

// Why Fix is off for draft `d`, placed at `placed`; null when it can run.
export function fixDisabledReason(s: BranchReviewState, d: Draft, placed: Placed): string | null {
  if (d.status === "fixed") return "Fixed already";
  if (d.status === "discarded") return "Discarded";
  if (placed.moved) return "The line moved since the review: run it again";
  if (s.fixing !== null) return `A fix is running on ${s.branch}`;
  if (!s.data?.worktree) return `Check ${s.branch} out first`;
  if (s.data.dirty) return `Commit or stash the changes in ${s.data.worktree} first`;
  return null;
}

// The Create Pull Request dialog's line about the branch's review: "" when
// every finding is fixed or discarded.
export function openFindingsNote(open: number): string {
  if (open === 0) return "";
  return open === 1 ? "1 review finding is not fixed or discarded." : `${open} review findings are not fixed or discarded.`;
}
