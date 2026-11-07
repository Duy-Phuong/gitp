// One poller for the views that read again on a timer (the review inbox, the
// pull request view): each named by a key, at most one timer per key. Nobody
// looking means nothing to refresh, so a tick is skipped while the window is
// unfocused or the document hidden, and coming back polls at once. A tick
// still running when the next is due is not started twice.

interface Poll {
  intervalMs: number;
  tick: () => Promise<void> | void;
  timer: ReturnType<typeof setInterval>;
  running: boolean;
}

const polls = new Map<string, Poll>();
let focused = true;
let pausedUntil = 0;
let listening = false;

function looking(): boolean {
  return focused && !document.hidden;
}

function run(poll: Poll): void {
  if (poll.running || !looking() || Date.now() < pausedUntil) return;
  poll.running = true;
  const done = () => {
    poll.running = false;
  };
  try {
    void Promise.resolve(poll.tick()).then(done, done);
  } catch {
    done();
  }
}

// Back in view: every poll at once, its timer started over from now.
function resume(): void {
  if (!looking()) return;
  for (const poll of polls.values()) {
    clearInterval(poll.timer);
    poll.timer = setInterval(() => run(poll), poll.intervalMs);
    run(poll);
  }
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("blur", () => {
    focused = false;
  });
  window.addEventListener("focus", () => {
    focused = true;
    resume();
  });
  document.addEventListener("visibilitychange", resume);
}

/// Call `tick` every `intervalMs` while the window is in view, under `key`:
/// a later start with the same key replaces this one. Returns the stop.
export function startPolling(key: string, intervalMs: number, tick: () => Promise<void> | void): () => void {
  listen();
  const old = polls.get(key);
  if (old) clearInterval(old.timer);
  const poll: Poll = { intervalMs, tick, running: false, timer: setInterval(() => run(poll), intervalMs) };
  polls.set(key, poll);
  return () => {
    clearInterval(poll.timer);
    if (polls.get(key) === poll) polls.delete(key);
  };
}

/// Skip every tick due in the next `ms` (gitp is busy with something of its
/// own); polling goes on as before after that.
export function pausePollingFor(ms: number): void {
  pausedUntil = Math.max(pausedUntil, Date.now() + ms);
}
