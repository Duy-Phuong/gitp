// The log's optional columns (GitKraken themes): which of Author, Date and SHA
// show, in what order, and the Author column's filter. Pure — the header in
// views/log.ts draws them, prefs.ts stores them per repo.

import type { CommitRow } from "./types";

// The commit message is not here: it is always shown, always first.
export type LogColumn = "author" | "date" | "sha";

export const LOG_COLUMNS: LogColumn[] = ["author", "date", "sha"];

export const LOG_COLUMN_LABEL: Record<LogColumn, string> = { author: "Author", date: "Date", sha: "SHA" };

export interface LogColumns {
  /// Every column exactly once, hidden ones included, so showing one again
  /// puts it back where it was.
  order: LogColumn[];
  hidden: LogColumn[];
}

export const DEFAULT_LOG_COLUMNS: LogColumns = { order: LOG_COLUMNS, hidden: [] };

// Whatever was stored, as a valid LogColumns: unknown names and duplicates are
// dropped, and a column missing from the order (one added in a later version)
// goes on the end.
export function normalizeLogColumns(raw: unknown): LogColumns {
  const r = (raw ?? {}) as { order?: unknown; hidden?: unknown };
  const known = (v: unknown): LogColumn[] =>
    Array.isArray(v) ? [...new Set(v.filter((c): c is LogColumn => (LOG_COLUMNS as unknown[]).includes(c)))] : [];
  const order = known(r.order);
  for (const c of LOG_COLUMNS) if (!order.includes(c)) order.push(c);
  return { order, hidden: known(r.hidden) };
}

export function shownColumns(cols: LogColumns): LogColumn[] {
  return cols.order.filter((c) => !cols.hidden.includes(c));
}

export function withColumnToggled(cols: LogColumns, col: LogColumn): LogColumns {
  const hidden = cols.hidden.includes(col) ? cols.hidden.filter((c) => c !== col) : [...cols.hidden, col];
  return { ...cols, hidden };
}

// `col` dragged to just before `before` (null: to the end).
export function withColumnMoved(cols: LogColumns, col: LogColumn, before: LogColumn | null): LogColumns {
  if (col === before) return cols;
  const order = cols.order.filter((c) => c !== col);
  const at = before ? order.indexOf(before) : -1;
  order.splice(at < 0 ? order.length : at, 0, col);
  return { ...cols, order };
}

// --- Author filter -----------------------------------------------------------
//
// Filtering by author is an `author:` term in the commit search box rather than
// a filter of its own: the search already hides the commits that don't match,
// over the whole graph rather than just the loaded pages, and the term stays
// visible and editable next to whatever else is being searched for.

// The query split into terms the way the search reads them: a quoted value
// stays one term.
function terms(query: string): string[] {
  return query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
}

const AUTHOR_TERM = /^author:/i;

// The value of the query's author: term (quotes removed), or null.
export function authorTerm(query: string): string | null {
  const t = terms(query).find((term) => AUTHOR_TERM.test(term));
  const value = t?.slice("author:".length).replace(/"/g, "");
  return value ? value : null;
}

// What an author: term for `author` can hold. The search has no escape for a
// quote — it only opens or closes a quoted value — so a name with quotes in it
// is cut to its longest quote-free piece: the search matches part of a name,
// and that piece is still part of this one.
export function authorSearchValue(author: string): string {
  return author
    .split('"')
    .map((piece) => piece.trim())
    .reduce((best, piece) => (piece.length > best.length ? piece : best), "");
}

// The query with its author: terms replaced by one for `author`, or removed
// when `author` is null; every other term stays.
export function withAuthorTerm(query: string, author: string | null): string {
  const rest = terms(query).filter((t) => !AUTHOR_TERM.test(t));
  const value = author ? authorSearchValue(author) : "";
  if (value) rest.push(/\s/.test(value) ? `author:"${value}"` : `author:${value}`);
  return rest.join(" ");
}

export interface LogAuthor {
  name: string;
  email: string;
  commits: number;
}

// The authors of `rows`, one per email, most commits first.
export function authorsOf(rows: CommitRow[]): LogAuthor[] {
  const byEmail = new Map<string, LogAuthor>();
  for (const r of rows) {
    const key = r.author_email.toLowerCase();
    const a = byEmail.get(key);
    if (a) a.commits += 1;
    else byEmail.set(key, { name: r.author_name, email: r.author_email, commits: 1 });
  }
  return [...byEmail.values()].sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
}
