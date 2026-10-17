// The status bar's "fetched 3m ago": how fresh each repo's remote-tracking refs are.

import { $ } from "./dom";
import { relativeTime } from "./timeago";
import { state } from "./app-state";

// --- Fetch freshness -------------------------------------------------------
//
// Every ahead/behind count in the sidebar is only as current as the last fetch,
// and there was no way to tell whether that was ten seconds or forty minutes
// ago. Per repo, because the counts are per repo: switching to a tab that hasn't
// been fetched in an hour shouldn't claim the freshness of the one you left.

export const remoteFetchedAt = new Map<string, number>();

// How often the label is re-rendered. Only a text write, so the cost is nil and
// "1m ago" doesn't sit there reading "just now".
const FETCH_AGE_TICK_MS = 30_000;

export function markRemoteFetched(): void {
  if (state.repoPath) remoteFetchedAt.set(state.repoPath, Date.now());
  renderFetchAge();
}

function fetchAgeLabel(at: number | undefined): string {
  if (at === undefined) return "not fetched yet";
  return `fetched ${relativeTime(Math.floor(at / 1000))}`;
}

export function renderFetchAge(): void {
  const slot = $("#status-fetched");
  slot.classList.toggle("hidden", !state.repoPath);
  if (!state.repoPath) return;
  slot.textContent = fetchAgeLabel(remoteFetchedAt.get(state.repoPath));
}

export function setupFetchAgeIndicator(): void {
  renderFetchAge();
  window.setInterval(renderFetchAge, FETCH_AGE_TICK_MS);
}
