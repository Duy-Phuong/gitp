// The welcome screen: what the main panel shows when no repository is open —
// the ways to get one (Open, Clone, Init, Workspaces) and the repositories
// already known, favorites first, each a click away. Replaces an empty graph
// and a status-bar hint, which gave a first launch nothing to do.

import { clear, el } from "../dom";
import { tildePath } from "../prefs";

export interface WelcomeCallbacks {
  open: (path: string) => void;
  browse: () => void;
  clone: () => void;
  init: () => void;
  workspaces: () => void;
  favorites: () => string[];
  recent: () => string[];
}

export interface WelcomeHandle {
  /// Show the screen (and redraw its lists) or hide it, depending on whether
  /// a repository is open.
  sync: (repoOpen: boolean) => void;
}

/// How many recent repositories to list: the screen is a launcher, not a history.
const RECENT_LIMIT = 8;

export function setupWelcome(host: HTMLElement, cb: WelcomeCallbacks): WelcomeHandle {
  const render = () => {
    clear(host);
    const favorites = cb.favorites();
    const recent = cb.recent()
      .filter((p) => !favorites.includes(p))
      .slice(0, RECENT_LIMIT);

    const action = (label: string, hint: string, run: () => void) => {
      const btn = el("button", { class: "btn ghost welcome-action", title: hint }, [
        el("span", { class: "welcome-action-label", text: label }),
        el("span", { class: "welcome-action-hint", text: hint }),
      ]);
      btn.addEventListener("click", run);
      return btn;
    };

    const panel = el("div", { class: "welcome-panel" }, [
      el("div", { class: "welcome-brand", text: "gitp" }),
      el("div", { class: "welcome-sub", text: "Open a repository to see its history, or start a new one." }),
      el("div", { class: "welcome-actions" }, [
        action("Open…", "a folder with a git repository", cb.browse),
        action("Clone…", "a remote repository", cb.clone),
        action("Init…", "a new repository", cb.init),
        action("Workspaces…", "groups of repositories", cb.workspaces),
      ]),
    ]);

    if (favorites.length > 0) panel.append(repoList("Favorites", favorites, cb.open, true));
    if (recent.length > 0) panel.append(repoList("Recent", recent, cb.open, false));
    if (favorites.length === 0 && recent.length === 0) {
      panel.append(el("div", { class: "welcome-empty", text: "Repositories you open show up here." }));
    }

    panel.append(el("div", { class: "welcome-tips", text: "⌘K Quick Launch · ⌘/ Keyboard shortcuts" }));
    host.append(panel);
  };

  return {
    sync(repoOpen) {
      host.classList.toggle("hidden", repoOpen);
      if (repoOpen) clear(host);
      else render();
    },
  };
}

// A titled list of repositories: name, then the path as ~/…. Favorites show
// their Cmd+1…9 key, as Quick Launch does.
function repoList(title: string, paths: string[], open: (path: string) => void, numbered: boolean): HTMLElement {
  const list = el("section", { class: "welcome-list" }, [el("h3", { text: title })]);
  paths.forEach((path, i) => {
    const row = el("button", { class: "welcome-repo", title: path }, [
      el("span", { class: "welcome-repo-name", text: path.split("/").filter(Boolean).pop() ?? path }),
      el("span", { class: "welcome-repo-path", text: tildePath(path) }),
      ...(numbered && i < 9 ? [el("kbd", { text: `⌘${i + 1}` })] : []),
    ]);
    row.addEventListener("click", () => open(path));
    list.append(row);
  });
  return list;
}
