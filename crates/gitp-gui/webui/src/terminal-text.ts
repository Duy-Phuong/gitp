// Pure text helpers for the terminal panel: numbering its tabs and quoting the
// paths dropped into it.

// The number for a new tab: the lowest one not in use, so closing "zsh 2" and
// opening another gives "zsh 2" again rather than counting up forever.
export function tabNumber(used: number[]): number {
  let n = 1;
  while (used.includes(n)) n++;
  return n;
}

// `path` as one shell word. Plain paths go in as they are, readable; anything
// else is single-quoted, the one quoting in which nothing ($, `, \, !, spaces)
// is special — a single quote itself has to close the quote, add an escaped
// one, and reopen.
export function shellQuote(path: string): string {
  if (/^[\w@%+=:,./-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
