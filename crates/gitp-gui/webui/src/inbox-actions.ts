// The review inbox's place in the app: one view over the main panel, opened
// from the welcome screen, the Pull Requests view and Quick Launch, and
// closed by any other view (see showView). Opening a row is main.ts's
// (switch to the repository, then show the pull request), passed in so this
// module needs nothing of the shell.

import { inboxPaths } from "./inbox";
import { loadInbox } from "./inbox-api";
import { loadFavoriteRepos, loadRecentRepos } from "./prefs";
import { setupInbox, type InboxHandle } from "./views/inbox";

let view: InboxHandle | null = null;

export function setupReviewInbox(host: HTMLElement, open: (path: string, number: number) => Promise<void> | void): void {
  view = setupInbox(host, {
    paths: () => inboxPaths(loadRecentRepos(), loadFavoriteRepos()),
    load: loadInbox,
    open: (path, number) => {
      view?.hide();
      void open(path, number);
    },
    close: () => view?.hide(),
  });
}

export function openReviewInbox(): void {
  view?.show();
}

export function hideReviewInbox(): void {
  if (view?.isShowing()) view.hide();
}
