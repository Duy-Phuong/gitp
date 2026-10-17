// What a `repo-changed` event from the backend's filesystem watcher should
// refresh. Kept free of the DOM and Tauri so it can be unit-tested.

import type { RepoChanged } from "./types";

export interface WatchRefresh {
  // Whether the log can have changed. An edit or a `git add` touches only the
  // working tree and the index; only refs or HEAD moving changes history.
  history: boolean;
}

// null when there's nothing to do: no repo is open, or the event is for a tab
// that isn't active — that one refreshes when it's activated, as before.
export function watchRefresh(ev: RepoChanged, activePath: string): WatchRefresh | null {
  if (!activePath || ev.path !== activePath) return null;
  return { history: ev.kinds.includes("refs") || ev.kinds.includes("head") };
}
