// Intra-line (word-level) diff between a removed line and its paired added
// line, so the changed words within a line can be highlighted. A token-level
// LCS marks which tokens are common; the rest are the intra-line changes.
//
// When a pair has little in common, or is too large to diff cheaply, there is
// no word diff (`null`) and the lines are shown as plain whole-line changes —
// highlighting nearly every token of a rewritten line only adds noise.

export interface Seg {
  text: string;
  changed: boolean;
}

// Lines longer than this (either side) are not word-diffed: the LCS is
// quadratic in tokens, and minified/generated lines aren't worth reading
// word by word anyway.
export const MAX_LINE_LENGTH = 1000;
// Hunks with more lines than this get no word diffs at all.
export const MAX_HUNK_LINES = 1000;
// Total work (sum of len a × len b over the pairs diffed) a hunk may spend on
// word diffs; pairs past it fall back to whole-line marks. Bounds a hunk of
// many long, all-different lines to roughly 100ms instead of seconds.
export const MAX_HUNK_WORK = 20_000_000;
// Fraction of the pair's characters that must be unchanged for word marks to
// be shown (2 × unchanged / (len a + len b), like difflib's ratio).
export const MIN_UNCHANGED_RATIO = 0.3;

// Words (letters, digits, `_`, combining marks), whitespace runs, flag pairs,
// and otherwise one code point at a time — with any trailing combining marks,
// emoji modifiers and ZWJ-joined code points — so changing one word doesn't
// mark the whole line, and a span boundary never cuts a character (surrogate
// pair) or an emoji sequence in two.
const TOKEN =
  /[\p{L}\p{N}\p{M}_]+|\s+|[\u{1F1E6}-\u{1F1FF}]{2}|\P{M}[\p{M}\u{1F3FB}-\u{1F3FF}]*(?:‍\P{M}[\p{M}\u{1F3FB}-\u{1F3FF}]*)*/gu;

export function tokenize(s: string): string[] {
  return s.match(TOKEN) ?? [];
}

export function wordDiff(a: string, b: string): { left: Seg[]; right: Seg[] } | null {
  if (a.length > MAX_LINE_LENGTH || b.length > MAX_LINE_LENGTH) return null;
  const A = tokenize(a);
  const B = tokenize(b);

  // Common prefix and suffix are unchanged; only the middle needs the LCS.
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const n = A.length - pre - suf;
  const m = B.length - pre - suf;

  const aEq = new Array<boolean>(A.length).fill(true);
  const bEq = new Array<boolean>(B.length).fill(true);
  for (let i = 0; i < n; i++) aEq[pre + i] = false;
  for (let j = 0; j < m; j++) bEq[pre + j] = false;

  // dp[i][j] = LCS length of the middles from i / j onwards.
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[pre + i] === B[pre + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[pre + i] === B[pre + j]) {
      aEq[pre + i] = true;
      bEq[pre + j] = true;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  // Too dissimilar: fall back to whole-line. (Two empty lines are identical.)
  const total = a.length + b.length;
  const unchanged = A.reduce((sum, t, k) => (aEq[k] ? sum + t.length : sum), 0);
  if (total > 0 && (2 * unchanged) / total < MIN_UNCHANGED_RATIO) return null;

  return { left: merge(A, aEq), right: merge(B, bEq) };
}

// Word diffs for one hunk's lines, keyed by the line's index in the hunk. Like
// git and GitHub, within each run of changed lines (between context lines) the
// k-th deletion is paired with the k-th addition; leftover lines of the longer
// side, and pairs without a word diff, get no entry.
export function hunkWordDiffs(lines: { origin: string; content: string }[]): Map<number, Seg[]> {
  const out = new Map<number, Seg[]>();
  if (lines.length > MAX_HUNK_LINES) return out;
  let dels: number[] = [];
  let adds: number[] = [];
  let work = 0;
  const flush = () => {
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const a = lines[dels[k]].content;
      const b = lines[adds[k]].content;
      work += a.length * b.length;
      if (work > MAX_HUNK_WORK) break;
      const wd = wordDiff(a, b);
      if (!wd) continue;
      out.set(dels[k], wd.left);
      out.set(adds[k], wd.right);
    }
    dels = [];
    adds = [];
  };
  lines.forEach((line, idx) => {
    if (line.origin === "-") dels.push(idx);
    else if (line.origin === "+") adds.push(idx);
    else flush();
  });
  flush();
  return out;
}

// Collapse runs of same changed/unchanged tokens into single segments.
function merge(tokens: string[], equal: boolean[]): Seg[] {
  const segs: Seg[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const changed = !equal[i];
    const last = segs[segs.length - 1];
    if (last && last.changed === changed) last.text += tokens[i];
    else segs.push({ text: tokens[i], changed });
  }
  return segs;
}
