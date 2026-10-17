// A submodule in Local Changes. git records a submodule as a commit id, not
// file contents, so its "diff" is one line on each side —
//
//   -Subproject commit 1a2b…
//   +Subproject commit 3c4d…-dirty
//
// (`-dirty` when its files have local changes). Shown as text that reads like
// a one-line file edit; recognised here so it can be shown as what it is.

import type { FileDiff } from "./types";

export interface SubmoduleChange {
  // The commit recorded before (null for a newly added submodule) and now
  // (null when it's being removed).
  from: string | null;
  to: string | null;
  // The submodule's own files have uncommitted changes.
  dirty: boolean;
}

const SUBPROJECT = /^Subproject commit ([0-9a-f]{7,64})(-dirty)?$/;

// The submodule change `file`'s diff describes, or null when it isn't one.
export function parseSubmoduleDiff(file: FileDiff): SubmoduleChange | null {
  const lines = file.hunks.flatMap((h) => h.lines);
  if (lines.length === 0) return null;
  const change: SubmoduleChange = { from: null, to: null, dirty: false };
  for (const line of lines) {
    const m = SUBPROJECT.exec(line.content);
    if (!m || (line.origin !== "-" && line.origin !== "+")) return null;
    if (line.origin === "-") change.from = m[1];
    else {
      change.to = m[1];
      change.dirty = m[2] != null;
    }
  }
  return change;
}

// "1a2b3c4 → 3c4d5e6", "added at 3c4d5e6", or, for a submodule whose only
// change is inside it, "1a2b3c4 with local changes".
export function describeSubmoduleChange(c: SubmoduleChange): string {
  const short = (id: string) => id.slice(0, 7);
  const dirty = c.dirty ? " with local changes" : "";
  if (c.from && c.to) return c.from === c.to ? `${short(c.to)}${dirty}` : `${short(c.from)} → ${short(c.to)}${dirty}`;
  if (c.to) return `added at ${short(c.to)}${dirty}`;
  return c.from ? `removed (was ${short(c.from)})` : "";
}
