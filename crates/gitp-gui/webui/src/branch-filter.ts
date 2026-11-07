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
