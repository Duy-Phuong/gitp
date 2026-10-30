// Which refs the graph shows ("Hide" / "Solo", GitKraken-style). Refs are named
// in full (`refs/heads/x`, `refs/remotes/origin/x`, `refs/tags/v1`), the way
// the backend walk takes them. Pure, so it's unit-tested (ref-visibility.test.ts).

import type { GraphPrefs } from "./prefs";
import type { Refs } from "./types";

export const branchRefName = (name: string) => `refs/heads/${name}`;
export const remoteRefName = (name: string) => `refs/remotes/${name}`;
export const tagRefName = (name: string) => `refs/tags/${name}`;

// The hidden and soloed refs as sets, for the per-row lookups.
export interface RefFilter {
  hidden: Set<string>;
  solo: Set<string>;
}

export function refFilter(prefs: GraphPrefs): RefFilter {
  return { hidden: new Set(prefs.hidden), solo: new Set(prefs.solo) };
}

// Whether the graph shows `refname`: while anything is soloed, only the soloed
// refs; otherwise every ref not hidden. The checked-out branch always shows,
// since HEAD is always walked.
export function refShown(f: RefFilter, refname: string, isHead = false): boolean {
  if (isHead) return true;
  return f.solo.size ? f.solo.has(refname) : !f.hidden.has(refname);
}

// How many of the repo's branches, remote branches and tags the graph leaves
// out — what the "N refs hidden" note above the log counts.
export function hiddenRefCount(f: RefFilter, refs: Refs): number {
  if (!f.hidden.size && !f.solo.size) return 0;
  let n = 0;
  for (const b of refs.branches) if (!refShown(f, branchRefName(b.name), b.is_head)) n++;
  for (const r of refs.remotes) if (!refShown(f, remoteRefName(r.name))) n++;
  for (const t of refs.tags) if (!refShown(f, tagRefName(t.name))) n++;
  return n;
}

// `prefs` with `refnames` hidden (or shown again). Sorted, so the same set
// always makes the same log scope, which the backend caches the log against.
export function withHidden(prefs: GraphPrefs, refnames: string[], hide: boolean): GraphPrefs {
  const hidden = new Set(prefs.hidden);
  for (const r of refnames) {
    if (hide) hidden.add(r);
    else hidden.delete(r);
  }
  return { ...prefs, hidden: [...hidden].sort() };
}

// `prefs` with `refnames` soloed (or no longer), likewise sorted.
export function withSolo(prefs: GraphPrefs, refnames: string[], solo: boolean): GraphPrefs {
  const set = new Set(prefs.solo);
  for (const r of refnames) {
    if (solo) set.add(r);
    else set.delete(r);
  }
  return { ...prefs, solo: [...set].sort() };
}
