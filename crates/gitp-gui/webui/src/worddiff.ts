// Intra-line (word-level) diff between a removed line and its paired added
// line, so the changed words within a line can be highlighted. A token-level
// LCS marks which tokens are common; the rest are the intra-line changes.

export interface Seg {
  text: string;
  changed: boolean;
}

// Split into words, whitespace runs, and single punctuation chars, so that
// changing one word doesn't mark the whole line.
function tokenize(s: string): string[] {
  return s.match(/\w+|\s+|[^\w\s]/g) ?? [];
}

export function wordDiff(a: string, b: string): { left: Seg[]; right: Seg[] } {
  const A = tokenize(a);
  const B = tokenize(b);
  const n = A.length;
  const m = B.length;

  // dp[i][j] = LCS length of A[i..] and B[j..].
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const aEq = new Array<boolean>(n).fill(false);
  const bEq = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      aEq[i] = true;
      bEq[j] = true;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  return { left: merge(A, aEq), right: merge(B, bEq) };
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
