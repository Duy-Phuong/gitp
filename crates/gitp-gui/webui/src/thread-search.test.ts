import { expect, it } from "vitest";
import { highlightParts, keptMonths, monthRange, parseThreadQuery, searchStatus, storedThread } from "./thread-search";

it("parses #123 and pr:123 out as the pull request, the last one winning", () => {
  expect(parseThreadQuery("retry #123 loop")).toEqual({ text: "retry loop", pr: 123 });
  expect(parseThreadQuery("PR:45")).toEqual({ text: "", pr: 45 });
  expect(parseThreadQuery("#1 pr:2")).toEqual({ text: "", pr: 2 });
});

it("keeps any other number, and a bare #, as a plain word", () => {
  expect(parseThreadQuery("  123  retry ")).toEqual({ text: "123 retry", pr: null });
  expect(parseThreadQuery("# #x pr:")).toEqual({ text: "# #x pr:", pr: null });
});

it("bolds every word of the query, case-insensitively, merging overlaps", () => {
  expect(highlightParts("Retry stops early", "retry EARLY")).toEqual([
    { text: "Retry", bold: true },
    { text: " stops ", bold: false },
    { text: "early", bold: true },
  ]);
  expect(highlightParts("abcd", "abc bcd")).toEqual([{ text: "abcd", bold: true }]);
  expect(highlightParts("no match", "")).toEqual([{ text: "no match", bold: false }]);
});

it("matches regex characters literally", () => {
  expect(highlightParts("call retry( now; a.b", "retry( a.b")).toEqual([
    { text: "call ", bold: false },
    { text: "retry(", bold: true },
    { text: " now; ", bold: false },
    { text: "a.b", bold: true },
  ]);
  expect(highlightParts("aXb", "a.b")).toEqual([{ text: "aXb", bold: false }]);
});

it("gives a month as a millisecond [from, to) range in local time", () => {
  expect(monthRange(2026, 11)).toEqual([new Date(2026, 10, 1).getTime(), new Date(2026, 11, 1).getTime()]);
  expect(monthRange(2026, 12)).toEqual([new Date(2026, 11, 1).getTime(), new Date(2027, 0, 1).getTime()]);
});

it("lists the months the kept conversations can be in, newest first", () => {
  expect(keptMonths(new Date(2026, 10, 7))).toEqual([
    { year: 2026, month: 11, label: "November 2026" },
    { year: 2026, month: 10, label: "October 2026" },
    { year: 2026, month: 9, label: "September 2026" },
  ]);
  expect(keptMonths(new Date(2027, 0, 15), 20).map((m) => m.label)).toEqual(["January 2027", "December 2026"]);
});

it("says how many were found, and to narrow over the cap", () => {
  expect(searchStatus(200, 340)).toBe("Showing 200 of 340, narrow the search");
  expect(searchStatus(1, 1)).toBe("1 conversation");
  expect(searchStatus(3, 3)).toBe("3 conversations");
  expect(searchStatus(0, 0)).toBe("No conversations");
});

it("rebuilds a thread from a stored conversation, for one gone from GitHub", () => {
  const t = storedThread({ version: 1, pr: 7, thread: 500, path: "src/a.ts", line: 12, comments: [{ author: "anna", body: "why?" }], turns: [] });
  expect(t.replies).toEqual([]);
  expect([t.root.id, t.root.path, t.root.line, t.root.author, t.root.body]).toEqual([500, "src/a.ts", 12, "anna", "why?"]);
  const old = storedThread({ version: 1, pr: 7, thread: 501, path: "b", turns: [] });
  expect([old.root.line, old.root.author]).toEqual([null, ""]);
});
