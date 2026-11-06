// The Claude conversation of each line-comment thread of a pull request, by
// repository, number and thread: the turn running on it, why the last one
// failed, and the conversation as last loaded or returned. Pure state: the
// view calls the api and feeds the results in, as pr-actions does for
// reviews. It outlives the pull request view, so a Check that takes minutes
// can be started, the tab switched, and come back to; the sidebar counts the
// running turns with the running reviews.

import type { ThreadConversation, TurnKind } from "./types";

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
export function setConversation(repo: string, number: number, thread: number, c: ThreadConversation | null): void {
  const s = threadState(repo, number, thread);
  s.conversation = c;
  s.loaded = true;
  s.error = null;
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

export function onThreadsChange(listener: () => void): void {
  listeners.add(listener);
}

export function threadsChanged(): void {
  for (const l of listeners) l();
}
