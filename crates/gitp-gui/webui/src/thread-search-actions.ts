// "Search conversations" (the Pull Requests view's header, Quick Launch): the
// thread search view over the active repo's stored conversations, back to
// the view it was opened from, and a hit opened on its thread.

import { state, ui, type View } from "./app-state";
import { searchThreadConversations, threadConversation } from "./api";
import { setConversation, threadsChanged } from "./pr-threads";
import { readFailed } from "./report";
import { showPullRequest, showView } from "./shell";
import type { ThreadSearchCallbacks } from "./views/thread-search";
import type { ThreadHit } from "./types";

let backTo: View = "history";

export function showThreadSearch(): void {
  if (state.view !== "threadsearch") backTo = state.view;
  showView("threadsearch");
  ui.threadSearchView?.show();
}

// The pull request on the hit's thread, with its conversation read afresh:
// a resolved thread or one gone from GitHub shows it from the store.
async function openThreadHit(hit: ThreadHit): Promise<void> {
  const repo = state.repoPath;
  try {
    setConversation(repo, hit.pr, hit.thread, await threadConversation(repo, hit.pr, hit.thread));
    threadsChanged();
  } catch (err) {
    readFailed("Couldn't read Claude's conversation", err);
  }
  showPullRequest(hit.pr);
  ui.prView?.focusThread(hit.thread);
}

export const threadSearchCallbacks: ThreadSearchCallbacks = {
  search: (query, range, pr) => searchThreadConversations(state.repoPath, query, range, pr),
  open: (hit) => void openThreadHit(hit),
  back: () => showView(backTo),
  reportError: readFailed,
};
