// Preferences persisted in localStorage, and the theme.

import { isTauri } from "./api";
import { $ } from "./dom";
import type { DetailTab } from "./views/detail";
import type { PullMode } from "./types";
import { state, ui } from "./app-state";

// --- Persisted preferences (localStorage) ----------------------------------

const ALL_BRANCHES_KEY = "gitp-all-branches";

const REPOS_KEY = "gitp-repos";

const PULL_DEFAULT_KEY = "gitp-pull-default";

// Which commit-detail tab to open with. The pane already keeps your last tab as
// you move between commits; this carries that across restarts too.
const DETAIL_TAB_KEY = "gitp-detail-tab";

export function loadDetailTab(): DetailTab {
  const saved = localStorage.getItem(DETAIL_TAB_KEY);
  // Changes is the default: a commit click should show what changed.
  return saved === "commit" || saved === "changes" || saved === "tree" ? saved : "changes";
}

export function saveDetailTab(tab: DetailTab): void {
  localStorage.setItem(DETAIL_TAB_KEY, tab);
}

// What the plain Pull button runs. "FetchAll" isn't a real pull (no merge) but
// is offered alongside the pull strategies, GitKraken-style.
export type PullDefault = "FetchAll" | PullMode;

export const PULL_DEFAULTS: PullDefault[] = ["FetchAll", "FastForward", "FastForwardOnly", "Rebase"];

export const PULL_DEFAULT_LABEL: Record<PullDefault, string> = {
  FetchAll: "Fetch All",
  FastForward: "Pull (fast-forward if possible)",
  FastForwardOnly: "Pull (fast-forward only)",
  Rebase: "Pull (rebase)",
};

export function loadPullDefault(): PullDefault {
  const v = localStorage.getItem(PULL_DEFAULT_KEY);
  return (PULL_DEFAULTS as string[]).includes(v ?? "") ? (v as PullDefault) : "FastForward";
}

export function savePullDefault(mode: PullDefault): void {
  localStorage.setItem(PULL_DEFAULT_KEY, mode);
  updatePullButtonTitle();
}

export function updatePullButtonTitle(): void {
  $<HTMLButtonElement>("#pull-btn").title = PULL_DEFAULT_LABEL[loadPullDefault()];
}

// Width of the ref-badge column on the GitKraken themes, dragged in the log
// header.
const REF_COLUMN_KEY = "gitp-ref-column";

export const REF_COLUMN_DEFAULT = 170;

export function loadRefColumnWidth(): number {
  const v = Number(localStorage.getItem(REF_COLUMN_KEY));
  return Number.isFinite(v) && v > 0 ? v : REF_COLUMN_DEFAULT;
}

export function saveRefColumnWidth(width: number): void {
  localStorage.setItem(REF_COLUMN_KEY, String(Math.round(width)));
}

// The history toggle, persisted across restarts. Defaults to all branches.
export function loadAllBranches(): boolean {
  return localStorage.getItem(ALL_BRANCHES_KEY) !== "current";
}

export function saveAllBranches(all: boolean): void {
  localStorage.setItem(ALL_BRANCHES_KEY, all ? "all" : "current");
}

// The open repos + which is active, so the last workspace reopens on restart.
// Only persisted in the desktop shell (preview uses mock repos).
export function saveWorkspace(): void {
  if (!isTauri()) return;
  const data = { paths: state.repos.map((r) => r.path), active: state.repoPath };
  localStorage.setItem(REPOS_KEY, JSON.stringify(data));
}

// Repositories opened before, most recent first — Quick Launch's top section.
//
// The workspace list (REPOS_KEY) only holds what's open *now*, so it can't
// answer "that repo I was in last week". This is a separate MRU that only
// grows, capped at MAX_RECENT_REPOS.
export function loadRecentRepos(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_REPOS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

export function rememberRecentRepo(path: string): void {
  if (!path) return;
  const next = [path, ...loadRecentRepos().filter((p) => p !== path)].slice(0, MAX_RECENT_REPOS);
  localStorage.setItem(RECENT_REPOS_KEY, JSON.stringify(next));
}

export function forgetRecentRepo(path: string): void {
  localStorage.setItem(
    RECENT_REPOS_KEY,
    JSON.stringify(loadRecentRepos().filter((p) => p !== path)),
  );
}

// Starred repositories, in the order they were starred: Quick Launch lists them
// above the recent ones, and Cmd/Ctrl+1…9 switch to the first nine. Unlike the
// recent list nothing ever drops off it — only unstarring removes one.
const FAVORITE_REPOS_KEY = "gitp-favorite-repos";

export function loadFavoriteRepos(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITE_REPOS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

export function isFavoriteRepo(path: string): boolean {
  return loadFavoriteRepos().includes(path);
}

// Star `path`, or unstar it if it already is. Returns whether it's now starred.
export function toggleFavoriteRepo(path: string): boolean {
  const next = withFavoriteToggled(loadFavoriteRepos(), path);
  localStorage.setItem(FAVORITE_REPOS_KEY, JSON.stringify(next));
  return next.includes(path);
}

// A newly starred repo goes last, so the shortcuts of the ones before it
// don't move.
export function withFavoriteToggled(favorites: string[], path: string): string[] {
  return favorites.includes(path) ? favorites.filter((p) => p !== path) : [...favorites, path];
}

export function loadWorkspace(): { paths: string[]; active: string } | null {
  try {
    const raw = localStorage.getItem(REPOS_KEY);
    return raw ? (JSON.parse(raw) as { paths: string[]; active: string }) : null;
  } catch {
    return null;
  }
}

// --- Theme (System / Light / Dark / GitKraken / GitKraken Neon) ------------

// The GitKraken themes are dark palettes that also change how the commit graph
// is drawn (see GRAPH_THEMES in views/log.ts).
export type ThemeChoice = "system" | "light" | "dark" | "gitkraken" | "gitkraken-neon";

const THEME_CHOICES: ThemeChoice[] = ["system", "light", "dark", "gitkraken", "gitkraken-neon"];

const THEME_KEY = "gitp-theme";

const RECENT_REPOS_KEY = "gitp-recent-repos";

// Enough to fill Quick Launch's list without it becoming an archive.
const MAX_RECENT_REPOS = 12;

export function currentTheme(): ThemeChoice {
  const v = localStorage.getItem(THEME_KEY);
  return (THEME_CHOICES as string[]).includes(v ?? "") ? (v as ThemeChoice) : "system";
}

// Apply and persist a theme. "system" clears the override so CSS follows the OS
// via prefers-color-scheme; any other choice forces its palette via data-theme.
export function applyTheme(choice: ThemeChoice): void {
  if (choice === "system") {
    document.documentElement.removeAttribute("data-theme");
    localStorage.removeItem(THEME_KEY);
  } else {
    document.documentElement.dataset.theme = choice;
    localStorage.setItem(THEME_KEY, choice);
  }
  // xterm keeps its palette as JS values, so the CSS change alone leaves the
  // terminal on the old theme until it's told.
  ui.terminal?.syncTheme();
}
