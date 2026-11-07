// Polling GitHub (or anything) on a timer, the polite way: one timer per key,
// nothing while the window is unfocused or hidden, an immediate poll when it
// comes back, never two ticks of one key at once, and a pause every key
// honours (GitHub's rate limit, say).
//
// The pull request view, the Pull Requests list and the review inbox each
// register under a key of their own; starting a key again replaces it.

interface Poll {
  intervalMs: number;
  tick: () => Promise<void> | void;
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
}

const polls = new Map<string, Poll>();
// No poll runs before this time (ms since the epoch).
let pausedUntil = 0;
let focused = typeof document === "undefined" ? true : document.hasFocus();

const active = () => focused && !document.hidden;

async function run(poll: Poll): Promise<void> {
  if (poll.running || !active() || Date.now() < pausedUntil) return;
  poll.running = true;
  try {
    await poll.tick();
  } catch {
    // The tick reports its own failures; the next one tries again.
  } finally {
    poll.running = false;
  }
}

function schedule(poll: Poll): void {
  if (poll.timer !== null) clearInterval(poll.timer);
  poll.timer = active() ? setInterval(() => void run(poll), poll.intervalMs) : null;
}

// The window came back: poll each key now, then on its interval from here.
function resume(): void {
  for (const poll of polls.values()) {
    schedule(poll);
    void run(poll);
  }
}

function pause(): void {
  for (const poll of polls.values()) {
    if (poll.timer !== null) clearInterval(poll.timer);
    poll.timer = null;
  }
}

function changed(update: () => void): void {
  const was = active();
  update();
  const now = active();
  if (was && !now) pause();
  else if (!was && now) resume();
}

if (typeof window !== "undefined") {
  // The window's own focus and blur, not an element's.
  window.addEventListener("focus", (e) => {
    if (!(e.target instanceof Node)) changed(() => (focused = true));
  });
  window.addEventListener("blur", (e) => {
    if (!(e.target instanceof Node)) changed(() => (focused = false));
  });
  // `document.hidden` has already changed when this fires.
  let wasHidden = document.hidden;
  document.addEventListener("visibilitychange", () => {
    const hidden = document.hidden;
    if (hidden === wasHidden) return;
    wasHidden = hidden;
    if (!focused) return;
    if (hidden) pause();
    else resume();
  });
}

// Call `tick` every `intervalMs` under `key`, replacing what that key ran
// before. The first tick is one interval away (the caller has just loaded).
// Returns the stop function; a stop for a key started again since does
// nothing.
export function startPolling(key: string, intervalMs: number, tick: () => Promise<void> | void): () => void {
  const old = polls.get(key);
  if (old?.timer != null) clearInterval(old.timer);
  const poll: Poll = { intervalMs, tick, timer: null, running: false };
  polls.set(key, poll);
  schedule(poll);
  return () => {
    if (polls.get(key) !== poll) return;
    if (poll.timer !== null) clearInterval(poll.timer);
    polls.delete(key);
  };
}

// Skip every key's ticks for the next `ms` (0 ends a pause).
export function pausePollingFor(ms: number): void {
  pausedUntil = ms > 0 ? Date.now() + ms : 0;
}
