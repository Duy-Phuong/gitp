// The Claude conversation of each line-comment thread of a pull request, by
// repository, number and thread: the turn running on it, why the last one
// failed, and the conversation as last loaded or returned. Pure state: the
// view calls the api and feeds the results in, as pr-actions does for
// reviews. It outlives the pull request view, so a Check that takes minutes
// can be started, the tab switched, and come back to; the sidebar counts the
// running turns with the running reviews.

import type { ThreadConversation, ThreadTurn, TurnKind } from "./types";

export interface ThreadState {
  // The kind of turn running on the thread, if one is.
  running: TurnKind | null;
  // Why the last turn failed; null once one succeeded or the state was loaded.
  error: string | null;
  conversation: ThreadConversation | null;
  // Whether the saved conversation was asked for yet (null may mean "none").
  loaded: boolean;
}

const threads = new Map<string, ThreadState>();
const listeners = new Set<() => void>();

const keyOf = (repo: string, number: number, thread: number) => `${repo}\n${number}\n${thread}`;

// The thread's state, made empty the first time it is asked for.
export function threadState(repo: string, number: number, thread: number): ThreadState {
  const key = keyOf(repo, number, thread);
  let s = threads.get(key);
  if (!s) {
    s = { running: null, error: null, conversation: null, loaded: false };
    threads.set(key, s);
  }
  return s;
}

// What the store holds for the thread: the saved conversation, or none.
// `keepError`: a reload after a failed turn, whose error stays on screen.
export function setConversation(repo: string, number: number, thread: number, c: ThreadConversation | null, opts: { keepError?: boolean } = {}): void {
  const s = threadState(repo, number, thread);
  s.conversation = c;
  s.loaded = true;
  if (!opts.keepError) s.error = null;
}

// Mark a turn of `kind` as running; false when one already is.
export function startTurn(repo: string, number: number, thread: number, kind: TurnKind): boolean {
  const s = threadState(repo, number, thread);
  if (s.running) return false;
  s.running = kind;
  s.error = null;
  threadsChanged();
  return true;
}

// The turn is over: with the conversation it was kept in, or why it failed.
export function finishTurn(repo: string, number: number, thread: number, result: ThreadConversation | { error: string }): void {
  const s = threadState(repo, number, thread);
  s.running = null;
  if ("error" in result) s.error = result.error;
  else setConversation(repo, number, thread, result);
  threadsChanged();
}

// How many turns run on the pull request's threads, for the sidebar.
export function runningTurns(repo: string, number: number): number {
  const prefix = `${repo}\n${number}\n`;
  let n = 0;
  for (const [key, s] of threads) if (key.startsWith(prefix) && s.running) n++;
  return n;
}

// The last thing the user said in the conversation — the option a reply
// draft builds on — or nothing.
export function lastUserText(c: ThreadConversation | null): string {
  if (!c) return "";
  for (let i = c.turns.length - 1; i >= 0; i--) if (c.turns[i].role === "user") return c.turns[i].text;
  return "";
}

// Whether the user chose an option: a user turn after the last Check, and
// after the last Fix, which used the option before it up.
export function hasChosenOption(c: ThreadConversation | null): boolean {
  if (!c) return false;
  const after = Math.max(...c.turns.map((t, i) => (t.kind === "check" || (t.kind === "fix" && t.commit) ? i : -1)));
  return c.turns.some((t, i) => i > after && t.role === "user");
}

// The reply the thread has ready: its latest draft, unless posted or dropped.
export function preparedReply(c: ThreadConversation | null): ThreadTurn | null {
  const last = c ? [...c.turns].reverse().find((t) => t.kind === "reply-draft" && t.role === "claude") : undefined;
  return last && !last.posted && !last.dropped ? last : null;
}

// The latest fix that made a commit.
export function lastFix(c: ThreadConversation | null): ThreadTurn | null {
  return (c ? [...c.turns].reverse().find((t) => t.kind === "fix" && t.commit) : undefined) ?? null;
}

// How many loaded threads of the pull request have a reply ready.
export function preparedReplies(repo: string, number: number): number {
  const prefix = `${repo}\n${number}\n`;
  let n = 0;
  for (const [key, s] of threads) if (key.startsWith(prefix) && preparedReply(s.conversation)) n++;
  return n;
}

// The thread a fix runs on in the pull request, if one does: one fix per
// pull request at a time, since they share the branch's worktree.
export function fixRunningOn(repo: string, number: number): number | null {
  const prefix = `${repo}\n${number}\n`;
  for (const [key, s] of threads) if (key.startsWith(prefix) && s.running === "fix") return Number(key.slice(prefix.length));
  return null;
}

// --- The fix queue ----------------------------------------------------------
//
// One fix runs per pull request at a time: they share the branch's worktree,
// and each starts from the commit the one before made. A fix asked for while
// another runs waits here, in the order asked, and starts when the running
// one ends — whether it committed, failed or was stopped. In memory only:
// quitting drops the waiting ones (the chosen options stay saved).

export interface QueuedFix<P = unknown, T = unknown> {
  repo: string;
  number: number;
  thread: number;
  // "path:line", for the notes and the menus.
  where: string;
  // What the fix needs to start: the pull request and the thread as asked.
  pr: P;
  input: T;
}

const fixQueue: QueuedFix[] = [];

export function queueFix(entry: QueuedFix): void {
  if (fixQueue.some((q) => q.repo === entry.repo && q.number === entry.number && q.thread === entry.thread)) return;
  fixQueue.push(entry);
  threadsChanged();
}

// Take the thread's fix off the queue; whether it was on it.
export function cancelQueuedFix(repo: string, number: number, thread: number): boolean {
  const i = fixQueue.findIndex((q) => q.repo === repo && q.number === number && q.thread === thread);
  if (i < 0) return false;
  fixQueue.splice(i, 1);
  threadsChanged();
  return true;
}

// The pull request's waiting fixes, in order; every repository's with no
// arguments (the jobs panel).
export function queuedFixes(repo?: string, number?: number): QueuedFix[] {
  return fixQueue.filter((q) => (repo === undefined || q.repo === repo) && (number === undefined || q.number === number));
}

// The next waiting fix of the pull request, taken off the queue.
export function takeQueuedFix(repo: string, number: number): QueuedFix | null {
  const i = fixQueue.findIndex((q) => q.repo === repo && q.number === number);
  if (i < 0) return null;
  const [next] = fixQueue.splice(i, 1);
  threadsChanged();
  return next;
}

// The thread's place in its pull request's queue, from 1; null when it
// isn't waiting.
export function queuePosition(repo: string, number: number, thread: number): number | null {
  const i = queuedFixes(repo, number).findIndex((q) => q.thread === thread);
  return i < 0 ? null : i + 1;
}

// "2nd", "3rd", "11th".
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

// Why Fix is off on a thread, or null when it is on: no option chosen, or a
// fix running at `elsewhere` (path:line) on the pull request. The checks on
// the worktree itself (checked out, clean, up to date) are core's, on click.
export const NO_OPTION_CHOSEN = "Send the option you want as a follow-up first";

export function fixDisabledReason(c: ThreadConversation | null, elsewhere: string | null): string | null {
  if (!hasChosenOption(c)) return NO_OPTION_CHOSEN;
  if (elsewhere) return `A fix is running on ${elsewhere}`;
  return null;
}

export function onThreadsChange(listener: () => void): void {
  listeners.add(listener);
}

export function threadsChanged(): void {
  for (const l of listeners) l();
}
