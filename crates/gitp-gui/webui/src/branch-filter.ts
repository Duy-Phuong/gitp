// The Branch menu's filter: the branches whose name holds every word typed,
// in any case and any order, in the order given.
export function matchBranches<T extends string>(names: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return names;
  return names.filter((n) => {
    const name = n.toLowerCase();
    return words.every((w) => name.includes(w));
  });
}

// How many recent branches the Branch menu shows above the rest.
const RECENT_MAX = 5;

// The branches checked out last (`recent`, newest first), for the top of the
// Branch menu: not the one checked out now, nor one since deleted.
export function recentBranches(recent: string[], names: string[], current: string | null): string[] {
  const have = new Set(names);
  return recent.filter((n) => n !== current && have.has(n)).slice(0, RECENT_MAX);
}
