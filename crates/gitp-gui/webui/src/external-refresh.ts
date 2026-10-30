// Picking up changes made outside gitp (a terminal, an IDE, another git client).

import { onRepoChanged } from "./api";
import { state, ui } from "./app-state";
import { watchRefresh } from "./repo-watch";
import { loadSidebar, operationInFlight, refreshHistory } from "./shell";

// --- Picking up changes made outside gitp ---------------------------------
//
// Another app — a terminal, an IDE, another git GUI — can stage, commit, or
// check out at any moment. The backend already serves fresh data whenever it's
// asked (its `git status` cache is guarded by a worktree watcher *and* the
// `.git/index` stamp), but nothing was asking: loadSidebar() ran only after
// gitp's own actions, so an external `git add` stayed invisible until the user
// happened to do something in gitp that refreshed.
//
// So refresh on the two signals that mean "the user is looking at this now":
// the window regaining focus (stage elsewhere, switch back — the reported
// case), and interaction, throttled, for when gitp already had focus.
//
// And, primarily now, when the backend's filesystem watcher says the active
// repo changed on disk: an edit saved in an editor or a commit in a terminal
// shows up while gitp sits untouched beside it. Focus and interaction stay as
// the fallback for when no watcher could be started (watch limits exhausted
// on a huge tree) — then the backend never sends anything.
//
// The watcher can't feed back into itself: a refresh only reads, and the one
// read that used to write — `git status` refreshing stat data in
// `.git/index` — runs with --no-optional-locks. gitp's own operations do
// produce one trailing event each, ~300ms after they finish; that refresh
// finds the state the operation already showed (history is skipped by its
// fingerprint) and writes nothing, so it ends there.

const INTERACTION_REFRESH_THROTTLE_MS = 3_000;

let lastDiskRefreshAt = 0;

// Re-read refs, staging lists and history from disk. `force` skips the
// interaction throttle — window focus and watcher events are deliberate and
// infrequent, so they shouldn't be swallowed by a click a moment earlier.
// `history: false` skips the history probe when only files changed; `diff`
// re-reads the file open in Local Changes, whose status entry (and so the
// staging lists) can stay the same while its content changes.
function refreshFromDisk(force: boolean, history = true, diff = true): void {
  if (!state.repoPath) return;
  // An operation in flight refreshes on its own when it finishes.
  if (operationInFlight()) return;
  const now = Date.now();
  if (!force && now - lastDiskRefreshAt < INTERACTION_REFRESH_THROTTLE_MS) return;
  lastDiskRefreshAt = now;
  void (async () => {
    await loadSidebar({ abortIfBusy: true });
    // A binary image is re-read only on these deliberate signals (see
    // keepRecheckedDiff), not on every throttled click.
    if (diff) void ui.changesView?.recheckDiff(force);
    // Commits made outside gitp change history too. This is the passive mode:
    // it compares the first page and returns without touching anything when
    // history is unchanged, which is the common case.
    if (state.view === "history") {
      if (history) await refreshHistory({ keepSelection: true });
    }
    // A file resolved in a terminal/editor must leave the resolver's list too.
    else if (state.view === "conflict") await ui.conflictView?.reload();
  })();
}

export function setupExternalChangeRefresh(): void {
  // Coming back to the window: the reported case, and the cheapest signal there
  // is that the user wants to see current state.
  window.addEventListener("focus", () => refreshFromDisk(true));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshFromDisk(true);
  });

  // Already focused: any interaction is a hint the user is here and looking.
  // Throttled, and skipped while a modal is open — mid-dialog the file lists
  // aren't what's being looked at, and repainting them underneath is a
  // surprise, not a service.
  const onInteract = (e: Event) => {
    if (document.querySelector(".modal-overlay")) return;
    // A keystroke inside a text field means the user is writing, not navigating.
    // Re-reading the workspace mid-sentence rebuilds the staging view under
    // them; render() puts the caret back, but the churn buys nothing.
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    refreshFromDisk(false);
  };
  document.addEventListener("pointerdown", onInteract, true);
  document.addEventListener("keydown", onInteract, true);

  void onRepoChanged((ev) => {
    const plan = watchRefresh(ev, state.repoPath);
    if (plan) refreshFromDisk(true, plan.history, plan.diff);
  });
}
