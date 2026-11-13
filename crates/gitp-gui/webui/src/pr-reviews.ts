// The review of each pull request, by repository and number: the review
// command running in the background for it, and the draft comments it (or a
// loaded review file) left to approve or discard. It outlives the pull request
// view — opening another one, or another repo tab, keeps it — so a review that
// takes half an hour can be started and come back to. The sidebar shows its
// state as a badge on the pull request.
//
// The file a review was read from is remembered across restarts; its drafts
// are read again from it the next time they are asked for. So are the drafts
// already posted — a review read again leaves them out — and the head commit
// last reviewed, so new commits since can be pointed out.

import type { DraftComment } from "./review-drafts";
import type { ReviewFix, ReviewKey, ReviewVerdict, StoredReview } from "./types";
import { fixRunningOn, queuedFixes, runningTurns } from "./pr-threads";

// A loaded finding and what the user decided about it — or that a fix
// answered it, with the commit (kept on disk, see setReviewSaver).
export interface Draft extends DraftComment {
  id: number;
  status: "pending" | "approved" | "discarded" | "fixed";
  // The text as the review wrote it, before any edit: what marks it posted.
  original: string;
  fix?: ReviewFix | null;
  // Kept (fixed or discarded) from a run before the last, which didn't find
  // it again: its line belongs to an older head, so it counts as moved.
  stale?: boolean;
}

// Whether a pull request's review can go once the approved drafts were
// posted: nothing open is left, and no fixed mark worth keeping.
export function nothingLeftAfterPost(drafts: Draft[]): boolean {
  return !drafts.some((d) => isOpen(d) || d.status === "fixed");
}

// Still waiting for a decision: neither discarded nor fixed.
export const isOpen = (d: Draft): boolean => d.status === "pending" || d.status === "approved";

// What a fix round's "**Fix status:**" line says: `label` for a badge, and
// `tone` — "done" (fixed), "warn" (still open, changed, not approved) or
// "open" (proposed). Null when the notes have no status line.
export function fixState(notes: string | undefined): { label: string; tone: "done" | "warn" | "open" } | null {
  const m = notes && /\*\*Fix status:?\*\*:?\s*(.+)/i.exec(notes);
  if (!m) return null;
  const said = m[1].trim();
  const label = (/re-check:\s*(.+)$/i.exec(said)?.[1] ?? said).trim();
  if (/still open|not approved|changed|⚠|⏳/i.test(said)) return { label, tone: "warn" };
  if (/✅|\bfixed\b|fixed-local|pushed in/i.test(said)) return { label, tone: "done" };
  return { label, tone: "open" };
}

// Fixed by a fix round, though still open here: nothing left to post.
export const fixedByNotes = (d: Draft): boolean => fixState(d.fixNotes)?.tone === "done";

// Left to decide: open, and not fixed by a fix round either.
export const toDecide = (d: Draft): boolean => d.status === "pending" && !fixedByNotes(d);

export interface PrReview {
  // The review command is running for it.
  running: boolean;
  // Why the last run failed; null once it succeeded or was dismissed.
  error: string | null;
  drafts: Draft[];
  // The review the approved drafts will be posted as.
  verdict: ReviewVerdict;
  body: string;
  // The review page the drafts came from, when they came from a file.
  file: string | null;
  // The commit reviewed and, for a branch, the base it was reviewed against.
  head?: string;
  base?: string;
}

const FILES_KEY = "gitp-pr-review-files";
const reviews = new Map<string, PrReview>();
const listeners = new Set<() => void>();

const keyOf = (repo: string, number: number) => `${repo}\n${number}`;

function loadFiles(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(FILES_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveFile(key: string, file: string | null): void {
  const files = loadFiles();
  if (file) files[key] = file;
  else delete files[key];
  try {
    localStorage.setItem(FILES_KEY, JSON.stringify(files));
  } catch {
    // Full or blocked storage: the drafts just don't survive a restart.
  }
}

// The review file remembered for a pull request from an earlier run of the
// app, whose drafts aren't loaded yet.
export function rememberedFile(repo: string, number: number): string | null {
  const key = keyOf(repo, number);
  return reviews.has(key) ? null : (loadFiles()[key] ?? null);
}

// The pull request's review, made empty the first time it is asked for.
export function prReview(repo: string, number: number): PrReview {
  return reviewAt(keyOf(repo, number));
}

// The review of a pull request or, kept in the same map, of a local branch.
export function reviewFor(repo: string, key: ReviewKey): PrReview {
  return reviewAt(mapKey(repo, key));
}

const mapKey = (repo: string, key: ReviewKey) => ("branch" in key ? `${repo}\nbranch:${key.branch}` : keyOf(repo, key.pr));

// The repo and review key a map key stands for.
function parseKey(k: string): [string, ReviewKey] {
  const at = k.lastIndexOf("\n");
  const rest = k.slice(at + 1);
  return [k.slice(0, at), rest.startsWith("branch:") ? { branch: rest.slice(7) } : { pr: Number(rest) }];
}

function reviewAt(key: string): PrReview {
  let r = reviews.get(key);
  if (!r) {
    r = { running: false, error: null, drafts: [], verdict: "comment", body: "", file: null };
    reviews.set(key, r);
  }
  return r;
}

// Add `found` as pending drafts after the ones already there.
export function addDrafts(r: PrReview, found: DraftComment[]): void {
  const next = r.drafts.length ? Math.max(...r.drafts.map((d) => d.id)) + 1 : 1;
  r.drafts = [...r.drafts, ...found.map((d, i) => ({ ...d, id: next + i, status: "pending" as const, original: d.body }))];
}

// --- Posted drafts and the reviewed head --------------------------------------

const STATE_KEY = "gitp-pr-review-state";
// Enough for any one pull request's reviews; the oldest go first.
const POSTED_LIMIT = 500;

interface Remembered {
  posted?: string[];
  head?: string;
}

function loadState(): Record<string, Remembered> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STATE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, Remembered>) : {};
  } catch {
    return {};
  }
}

function changeState(repo: string, number: number, change: (s: Remembered) => void): void {
  const all = loadState();
  const key = keyOf(repo, number);
  const s = all[key] ?? {};
  change(s);
  all[key] = s;
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(all));
  } catch {
    // Full or blocked storage: posted drafts may come back after a restart.
  }
}

// What a draft is known by: where it goes and the text the review wrote.
const fingerprint = (d: DraftComment & { original?: string }) =>
  `${d.path}:${d.line}:${d.side}:${(d.original ?? d.body).trim()}`;

// Remember `drafts` as posted on the pull request.
export function markPosted(repo: string, number: number, drafts: Draft[]): void {
  changeState(repo, number, (s) => {
    const posted = new Set(s.posted ?? []);
    for (const d of drafts) posted.add(fingerprint(d));
    s.posted = [...posted].slice(-POSTED_LIMIT);
  });
}

// The findings of `found` not posted on the pull request before.
export function unposted(repo: string, number: number, found: DraftComment[]): DraftComment[] {
  const posted = new Set(loadState()[keyOf(repo, number)]?.posted ?? []);
  return found.filter((d) => !posted.has(fingerprint(d)));
}

// The head commit the pull request was last reviewed at, full or abbreviated.
export function reviewedHead(repo: string, number: number): string | null {
  return loadState()[keyOf(repo, number)]?.head ?? null;
}

export function setReviewedHead(repo: string, number: number, head: string): void {
  changeState(repo, number, (s) => (s.head = head));
}

// Whether `head` is a later commit than the `reviewed` one — either may be
// abbreviated.
export function hasNewCommits(reviewed: string | null, head: string): boolean {
  if (!reviewed || !head) return false;
  return !(head.startsWith(reviewed) || reviewed.startsWith(head));
}

// Whether the pull request's review covers its `head` commit: "reviewed" when
// a review was made at it (or names no commit), "stale" when commits came
// since — time to review again. `reviewed` are the commits the reviews say they
// looked at: gitp's own record and the saved review file's header.
export interface ReviewMark {
  kind: "reviewed" | "stale";
  text: string;
  short: string;
  title: string;
}

export function reviewMark(reviewed: (string | null | undefined)[], saved: boolean, head: string): ReviewMark | null {
  const known = reviewed.filter((h): h is string => Boolean(h));
  if (known.length === 0 && !saved) return null;
  const current = known.find((h) => !hasNewCommits(h, head));
  if (known.length === 0 || current) {
    const at = current ? ` at ${current.slice(0, 8)}, its head commit` : "";
    return { kind: "reviewed", text: "✓ Reviewed", short: "✓ rev", title: `Reviewed${at}` };
  }
  return {
    kind: "stale",
    text: "↻ Review again",
    short: "↻ rev",
    title: `New commits since the review (${known[0].slice(0, 8)} → ${head.slice(0, 8)}): run the review again`,
  };
}

// The mark of pull request `pr` in `repo`, whose saved reviews are `files`.
export function prReviewMark(repo: string, pr: { number: number; head_oid?: string }, files: { number: number; head?: string | null }[]): ReviewMark | null {
  const file = files.find((f) => f.number === pr.number);
  return reviewMark([reviewedHead(repo, pr.number), file?.head], Boolean(file), pr.head_oid ?? "");
}

// Remember (or forget) the file the pull request's drafts came from.
export function setReviewFile(repo: string, number: number, file: string | null): void {
  prReview(repo, number).file = file;
  saveFile(keyOf(repo, number), file);
}

// Throw away the drafts — all posted, or cleared — and the file they came from.
export function clearDrafts(repo: string, number: number): void {
  const r = prReview(repo, number);
  r.drafts = [];
  r.body = "";
  r.error = null;
  setReviewFile(repo, number, null);
}

// What the sidebar shows on the pull request: running, failed, or how many
// drafts wait for a decision. Null when there is nothing to show.
export function reviewBadge(repo: string, number: number): { text: string; kind: "running" | "failed" | "ready" } | null {
  const r = reviews.get(keyOf(repo, number));
  if (r?.running) return { text: "reviewing…", kind: "running" };
  // A Claude turn on one of its threads (pr-threads.ts) counts the same; a
  // fix, with the ones queued after it.
  const queued = queuedFixes(repo, number).length;
  if (fixRunningOn(repo, number) !== null || queued > 0) return { text: `fixing…${queued ? ` · ${queued} queued` : ""}`, kind: "running" };
  if (runningTurns(repo, number) > 0) return { text: "thinking…", kind: "running" };
  if (r?.error) return { text: "review failed", kind: "failed" };
  const pending = r ? r.drafts.filter((d) => isOpen(d) && !fixedByNotes(d)).length : 0;
  if (pending) return { text: `${pending} draft${pending === 1 ? "" : "s"}`, kind: "ready" };
  if (!r && loadFiles()[keyOf(repo, number)]) return { text: "drafts", kind: "ready" };
  return null;
}

// Whether pull request `number` has drafts here already, without making its
// review (prReview would).
export function hasDrafts(repo: string, number: number): boolean {
  return (reviews.get(keyOf(repo, number))?.drafts.length ?? 0) > 0;
}

export function onReviewsChange(listener: () => void): void {
  listeners.add(listener);
}

export function reviewsChanged(): void {
  saveSoon();
  for (const l of listeners) l();
}

// --- Merging a new run, and keeping drafts on disk ------------------------------

// What a draft is known by across runs of the review: its file and the first
// 80 characters of the text the review wrote — without the copy-block wrapper
// an older gitp left in it, so such a draft is found again.
export function fingerprintOf(d: { path: string; body: string; original?: string }): string {
  let text = d.original ?? d.body;
  const wrapped = /^\s*<div class="copy-block"[^>]*>([\s\S]*?)(?:<\/div>|$)/i.exec(text);
  if (wrapped) text = wrapped[1];
  return `${d.path}\n${text.trim().slice(0, 80)}`;
}

// The drafts after a new run found `found`: a draft found again keeps its
// status, edit and fix (and takes the new run's line); a new one is added
// pending; an open one not found again goes; fixed and discarded ones stay.
export function mergeDrafts(existing: Draft[], found: DraftComment[]): Draft[] {
  const byPrint = new Map<string, DraftComment[]>();
  for (const f of found) byPrint.set(fingerprintOf(f), [...(byPrint.get(fingerprintOf(f)) ?? []), f]);
  const out: Draft[] = [];
  for (const d of existing) {
    const again = byPrint.get(fingerprintOf(d))?.shift();
    if (again) out.push({ ...d, ...withCleanBody(d, again), path: again.path, line: again.line, side: again.side, stale: false, ...findingText(again, true) });
    else if (!isOpen(d)) out.push({ ...d, stale: true });
  }
  const fresh = [...byPrint.values()].flat();
  const keep = new Set(fresh);
  const next = existing.length ? Math.max(...existing.map((d) => d.id)) + 1 : 1;
  out.push(
    ...found
      .filter((f) => keep.has(f))
      .map((d, i) => ({ ...d, id: next + i, status: "pending" as const, original: d.body })),
  );
  return out;
}

// The review file's own words on a finding — its Explained simply text, its
// board id, the Explain more answers and a fix round's notes — as fields to
// spread, without the empty ones. `all`: every key, undefined when empty, so a
// spread replaces what an older read left.
type FindingText = Pick<DraftComment, "explained" | "finding" | "explanations" | "fixNotes">;
function findingText(d: FindingText, all = false): FindingText {
  const out: FindingText = all ? { explained: undefined, finding: undefined, explanations: undefined, fixNotes: undefined } : {};
  if (d.explained) out.explained = d.explained;
  if (d.finding) out.finding = d.finding;
  if (d.explanations?.length) out.explanations = d.explanations;
  if (d.fixNotes) out.fixNotes = d.fixNotes;
  return out;
}

// The comment the review file gives now, for a draft not edited here: a
// draft read before gitp unwrapped the comment from the fix notes after it
// takes the clean text.
function withCleanBody(d: Draft, again: DraftComment): Pick<Draft, "body" | "original"> {
  return d.body === d.original ? { body: again.body, original: again.body } : { body: d.body, original: d.original };
}

// `drafts` with what the review file, read again as `found`, says about each
// of their findings (a new Explain more answer, say): their decisions, edits
// and fixes stay as they are.
export function withFindingText(drafts: Draft[], found: DraftComment[]): Draft[] {
  const byPrint = new Map(found.map((f) => [fingerprintOf(f), f]));
  return drafts.map((d) => {
    const again = byPrint.get(fingerprintOf(d));
    return again ? { ...d, ...withCleanBody(d, again), ...findingText(again, true) } : d;
  });
}

// The review in the shape kept on disk.
export function toStored(r: PrReview, key: ReviewKey): StoredReview {
  return {
    version: 1,
    ...("branch" in key ? { branch: key.branch } : { pr: key.pr }),
    base: r.base ?? "",
    head: r.head ?? "",
    drafts: r.drafts.map((d) => ({
      id: d.id,
      path: d.path,
      line: d.line,
      side: d.side,
      body: d.body,
      severity: d.severity,
      original: d.original,
      status: d.status,
      ...(d.topic ? { topic: d.topic } : {}),
      ...(d.fix ? { fix: d.fix } : {}),
      ...(d.stale ? { stale: true } : {}),
      ...findingText(d),
    })),
  };
}

// Load `s`, read from disk, into the review at `key`: it replaces the drafts,
// and counts as saved.
export function applyStored(repo: string, key: ReviewKey, s: StoredReview): PrReview {
  const r = reviewFor(repo, key);
  r.drafts = s.drafts.map((d) => ({
    id: d.id,
    path: d.path,
    line: d.line,
    side: d.side,
    body: d.body,
    severity: d.severity,
    original: d.original,
    status: d.status,
    ...(d.topic ? { topic: d.topic } : {}),
    fix: d.fix ?? null,
    ...(d.stale ? { stale: true } : {}),
    ...findingText({ explained: d.explained ?? undefined, finding: d.finding ?? undefined, explanations: d.explanations, fixNotes: d.fixNotes ?? undefined }),
  }));
  r.head = s.head || undefined;
  r.base = s.base || undefined;
  savedAs.set(mapKey(repo, key), JSON.stringify(toStored(r, key)));
  return r;
}

export interface ReviewSaver {
  save(repo: string, review: StoredReview): Promise<void>;
  remove(repo: string, key: ReviewKey): Promise<void>;
}

let saver: ReviewSaver | null = null;
// What each review was last saved as, by map key.
const savedAs = new Map<string, string>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// Where the reviews are kept (the stored_review_* commands); none in tests
// that don't ask.
export function setReviewSaver(s: ReviewSaver | null): void {
  saver = s;
}

// Save every review that changed, after a short pause: typing in a draft
// calls this on every key.
export function saveSoon(): void {
  if (!saver) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSaves(), 400);
}

// Save now every review that changed since it was last saved, and remove the
// file of one left with no drafts. A failed save is tried again next time.
export async function flushSaves(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (!saver) return;
  const s = saver;
  for (const [k, r] of reviews) {
    const [repo, key] = parseKey(k);
    if (r.drafts.length === 0) {
      if (savedAs.has(k)) {
        savedAs.delete(k);
        await s.remove(repo, key).catch(() => undefined);
      }
      continue;
    }
    const stored = toStored(r, key);
    const text = JSON.stringify(stored);
    if (savedAs.get(k) === text) continue;
    try {
      await s.save(repo, stored);
      savedAs.set(k, text);
    } catch {
      // Kept unsaved: the next change tries again.
    }
  }
}
