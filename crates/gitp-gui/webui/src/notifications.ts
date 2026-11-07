// Desktop notifications for what finishes while you are elsewhere: a Claude
// job done or failed, a check failed on your pull request, a review asked of
// you. Each has a switch in Settings → Notifications; none shows while gitp's
// window has focus (the status bar and the toasts tell you there).

import { notify } from "./api";
import type { ClaudeJob } from "./api";
import { inboxPaths, type InboxPr, type InboxRepo } from "./inbox";
import { loadInbox } from "./inbox-api";
import { loadFavoriteRepos, loadRecentRepos } from "./prefs";

export interface NotifyPrefs {
  claude: boolean;
  checks: boolean;
  reviews: boolean;
}

const KEY = "gitp-notify";
const DEFAULTS: NotifyPrefs = { claude: true, checks: true, reviews: true };

export function loadNotifyPrefs(): NotifyPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<NotifyPrefs>;
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveNotifyPrefs(prefs: NotifyPrefs): void {
  localStorage.setItem(KEY, JSON.stringify(prefs));
}

export interface Note {
  title: string;
  body: string;
}

// The jobs that stopped running since the last look: done or failed. A
// stopped one was the user's own doing.
export function jobNotes(before: Map<number, ClaudeJob["state"]>, jobs: ClaudeJob[]): Note[] {
  const notes: Note[] = [];
  for (const j of jobs) {
    if (before.get(j.id) !== "running") continue;
    if (j.state === "done") notes.push({ title: "Claude job finished", body: j.label });
    else if (j.state === "failed" || j.state === "interrupted") {
      notes.push({ title: "Claude job failed", body: j.error ? `${j.label}: ${j.error}` : j.label });
    }
  }
  return notes;
}

const prKey = (pr: InboxPr) => `${pr.repo}#${pr.number}`;

// What the inbox shows now that it didn't at the last look: a check failed
// on one of your pull requests, or a review newly asked of you. Returns the
// new state to compare with next time.
export function inboxNotes(
  seen: { failing: Set<string>; requested: Set<string> },
  prs: InboxPr[],
): { notes: Note[]; seen: { failing: Set<string>; requested: Set<string> } } {
  const failing = new Set(prs.filter((p) => p.mine && p.checks === "failure").map(prKey));
  const requested = new Set(prs.filter((p) => p.review_requested).map(prKey));
  const notes: Note[] = [];
  for (const p of prs) {
    const k = prKey(p);
    if (failing.has(k) && !seen.failing.has(k)) notes.push({ title: "A check failed", body: `${k} ${p.title}` });
    if (requested.has(k) && !seen.requested.has(k)) notes.push({ title: "Review requested", body: `${k} ${p.title} by ${p.author}` });
  }
  return { notes, seen: { failing, requested } };
}

function send(notes: Note[]): void {
  if (document.hasFocus()) return;
  for (const n of notes) void notify(n.title, n.body).catch(() => {});
}

// --- Claude jobs: fed by the jobs poll (claude-jobs.ts) ---------------------

let jobStates: Map<number, ClaudeJob["state"]> | null = null;

export function noticeJobs(jobs: ClaudeJob[]): void {
  const before = jobStates;
  jobStates = new Map(jobs.map((j) => [j.id, j.state]));
  // The first look only learns what runs.
  if (!before || !loadNotifyPrefs().claude) return;
  send(jobNotes(before, jobs));
}

// --- Pull requests: the inbox, read in the background -----------------------

const INBOX_MS = 5 * 60_000;
let inboxSeen: { failing: Set<string>; requested: Set<string> } | null = null;
let reading = false;

async function checkInbox(): Promise<void> {
  const prefs = loadNotifyPrefs();
  if ((!prefs.checks && !prefs.reviews) || reading) return;
  reading = true;
  try {
    const repos: InboxRepo[] = [];
    await loadInbox(inboxPaths(loadRecentRepos(), loadFavoriteRepos()), (r) => repos.push(r));
    const prs = repos.flatMap((r) => r.prs);
    const first = inboxSeen === null;
    const out = inboxNotes(inboxSeen ?? { failing: new Set(), requested: new Set() }, prs);
    inboxSeen = out.seen;
    if (first) return;
    send(out.notes.filter((n) => (n.title === "A check failed" ? prefs.checks : prefs.reviews)));
  } catch {
    // Offline or gh signed out: the next check tries again.
  } finally {
    reading = false;
  }
}

export function setupNotifications(): void {
  void checkInbox();
  setInterval(() => void checkInbox(), INBOX_MS);
}
