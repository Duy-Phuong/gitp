// The search over the stored Claude thread conversations: what the query
// box means (words, and `#123` or `pr:123` for one pull request), the bold
// parts of a snippet, the months the kept conversations can be in, and the
// line that says how many were found. The view is views/thread-search.ts.

import type { Thread } from "./pull-requests";
import type { ThreadConversation } from "./types";

const PR_WORD = /^(?:#|pr:)(\d+)$/i;

// The words to search for, and the pull request a `#123` or `pr:123` names
// (the last one, when there are several).
export function parseThreadQuery(q: string): { text: string; pr: number | null } {
  let pr: number | null = null;
  const words: string[] = [];
  for (const w of q.split(/\s+/).filter(Boolean)) {
    const m = PR_WORD.exec(w);
    if (m) pr = Number(m[1]);
    else words.push(w);
  }
  return { text: words.join(" "), pr };
}

// Lowercase, one code point for one, so positions stay those of the original.
const fold = (s: string): string[] => [...s].map((c) => {
  const l = c.toLowerCase();
  return [...l].length === 1 ? l : c;
});

// `snippet` cut into plain and bold parts: every word of `text` bold wherever
// it is, case-insensitively and literally.
export function highlightParts(snippet: string, text: string): { text: string; bold: boolean }[] {
  const chars = [...snippet];
  const hay = fold(snippet);
  const bold = new Array<boolean>(chars.length).fill(false);
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const needle = fold(word);
    for (let i = 0; i + needle.length <= hay.length; i++) {
      if (needle.every((c, j) => hay[i + j] === c)) for (let j = 0; j < needle.length; j++) bold[i + j] = true;
    }
  }
  const parts: { text: string; bold: boolean }[] = [];
  chars.forEach((c, i) => {
    const last = parts[parts.length - 1];
    if (last && last.bold === bold[i]) last.text += c;
    else parts.push({ text: c, bold: bold[i] });
  });
  return parts.length ? parts : [{ text: snippet, bold: false }];
}

// Month `month` (1–12) of `year` as epoch milliseconds [from, to), in local time.
export function monthRange(year: number, month: number): [number, number] {
  return [new Date(year, month - 1, 1).getTime(), new Date(year, month, 1).getTime()];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// The months from `keepDays` before `now` to now, newest first.
export function keptMonths(now: Date, keepDays = 60): { year: number; month: number; label: string }[] {
  const oldest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays);
  const out: { year: number; month: number; label: string }[] = [];
  for (let d = new Date(now.getFullYear(), now.getMonth(), 1); d >= new Date(oldest.getFullYear(), oldest.getMonth(), 1); d.setMonth(d.getMonth() - 1)) {
    out.push({ year: d.getFullYear(), month: d.getMonth() + 1, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` });
  }
  return out;
}

// "3 conversations", or "Showing 200 of 340, narrow the search" over the cap.
export function searchStatus(shown: number, total: number): string {
  if (total === 0) return "No conversations";
  if (total > shown) return `Showing ${shown} of ${total}, narrow the search`;
  return `${total} conversation${total === 1 ? "" : "s"}`;
}

// A thread rebuilt from its stored conversation, for one no longer on GitHub.
export function storedThread(c: ThreadConversation): Thread {
  const first = c.comments?.[0];
  return {
    root: {
      id: c.thread,
      author: first?.author ?? "",
      body: first?.body ?? "",
      path: c.path,
      line: c.line ?? null,
      original_line: c.line ?? null,
      side: "RIGHT",
      created_at: "",
      in_reply_to: null,
      url: "",
      diff_hunk: "",
    },
    replies: [],
  };
}
