// Fuzzy matching for file paths, as quick open uses it: the query's
// characters in order anywhere in the path, scored so that runs of adjacent
// hits, hits at the start of a path segment and hits in the file name beat
// scattered ones. (Quick Launch has its own scorer, tuned for command labels.)

export interface FuzzyMatch {
  score: number;
  /// Indices into the text of each matched character.
  positions: number[];
}

/// How well `query` matches `text`; null unless every character appears in order.
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const lastSlash = t.lastIndexOf("/");
  const isStart = (i: number) => i === 0 || "/._-".includes(t[i - 1]);
  // The first character may start anywhere it occurs ("cart" in "src/cart.ts"
  // must not latch onto the c of src); each later one continues a run when it
  // can, else takes a segment start, else the next occurrence.
  let best: FuzzyMatch | null = null;
  for (let start = t.indexOf(q[0]); start >= 0; start = t.indexOf(q[0], start + 1)) {
    const positions = [start];
    let score = (isStart(start) ? 6 : 0) + (start > lastSlash ? 4 : 0) - Math.min(start, 4);
    let prev = start;
    let ok = true;
    for (const ch of q.slice(1)) {
      let idx = t.indexOf(ch, prev + 1);
      if (idx < 0) {
        ok = false;
        break;
      }
      if (idx !== prev + 1) {
        for (let j = idx; j >= 0 && j < t.length; j = t.indexOf(ch, j + 1)) {
          if (isStart(j)) {
            idx = j;
            break;
          }
        }
      }
      positions.push(idx);
      if (idx === prev + 1) score += 8; // a run of adjacent hits
      if (isStart(idx)) score += 6; // a segment start
      if (idx > lastSlash) score += 4; // in the file name
      score -= Math.min(idx - prev - 1, 4); // a gap
      prev = idx;
    }
    if (ok && (!best || score > best.score)) best = { score, positions };
  }
  if (!best) return null;
  return { score: best.score - Math.min(text.length, 64) / 16, positions: best.positions };
}

/// The `limit` best matches of `query` over `items`, best first; ties go to
/// the shorter text.
export function rankFuzzy<T>(query: string, items: T[], text: (item: T) => string, limit = 50): { item: T; match: FuzzyMatch }[] {
  const out: { item: T; match: FuzzyMatch }[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, text(item));
    if (match) out.push({ item, match });
  }
  out.sort((a, b) => b.match.score - a.match.score || text(a.item).length - text(b.item).length);
  return out.slice(0, limit);
}
