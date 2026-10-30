// Preferences persisted in localStorage, and the theme.

import { isTauri } from "./api";
import { $ } from "./dom";
import type { DetailTab } from "./views/detail";
import type { PullMode } from "./types";
import { state, ui } from "./app-state";
import { readFailed } from "./report";

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

// The diff toolbars' Wrap lines and Ignore whitespace toggles. One setting
// each, shared by the commit detail and Local Changes: a reader who wants long
// lines wrapped wants it in both places.
const DIFF_WRAP_KEY = "gitp-diff-wrap";
const DIFF_IGNORE_WS_KEY = "gitp-diff-ignore-whitespace";

export function loadDiffWrap(): boolean {
  return localStorage.getItem(DIFF_WRAP_KEY) === "1";
}

export function saveDiffWrap(on: boolean): void {
  localStorage.setItem(DIFF_WRAP_KEY, on ? "1" : "0");
}

export function loadIgnoreWhitespace(): boolean {
  return localStorage.getItem(DIFF_IGNORE_WS_KEY) === "1";
}

export function saveIgnoreWhitespace(on: boolean): void {
  localStorage.setItem(DIFF_IGNORE_WS_KEY, on ? "1" : "0");
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

// Fetch all remotes of the open repo every N minutes (Settings → Pull). 0, the
// default, leaves only the fetch on opening History / Local Changes.
const AUTO_FETCH_KEY = "gitp-auto-fetch-minutes";

export const AUTO_FETCH_MINUTES = [0, 1, 5, 15, 30];

export function loadAutoFetchMinutes(): number {
  const v = Number(localStorage.getItem(AUTO_FETCH_KEY));
  return AUTO_FETCH_MINUTES.includes(v) ? v : 0;
}

export function saveAutoFetchMinutes(minutes: number): void {
  localStorage.setItem(AUTO_FETCH_KEY, String(minutes));
}

// The commit box's "Push after commit" toggle. Off by default: pushing is a
// network action nobody should get without asking for it.
const PUSH_AFTER_COMMIT_KEY = "gitp-push-after-commit";

export function loadPushAfterCommit(): boolean {
  return localStorage.getItem(PUSH_AFTER_COMMIT_KEY) === "1";
}

export function savePushAfterCommit(on: boolean): void {
  localStorage.setItem(PUSH_AFTER_COMMIT_KEY, on ? "1" : "0");
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

// Per-repo graph settings, keyed by repo path: the branch pinned to the left,
// and the refs hidden from or soloed in the graph (full ref names; see
// ref-visibility.ts).
const GRAPH_PREFS_KEY = "gitp-graph:";

export interface GraphPrefs {
  pinned: string | null;
  hidden: string[];
  solo: string[];
}

export function loadGraphPrefs(repo: string): GraphPrefs {
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((n): n is string => typeof n === "string") : []);
  try {
    const raw = JSON.parse(localStorage.getItem(GRAPH_PREFS_KEY + repo) ?? "{}") as Partial<GraphPrefs>;
    return { pinned: typeof raw.pinned === "string" ? raw.pinned : null, hidden: names(raw.hidden), solo: names(raw.solo) };
  } catch {
    return { pinned: null, hidden: [], solo: [] };
  }
}

export function saveGraphPrefs(repo: string, prefs: GraphPrefs): void {
  localStorage.setItem(GRAPH_PREFS_KEY + repo, JSON.stringify(prefs));
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

// Names given to repo tabs (right-click → Rename Tab…), keyed by repo path.
// The tab shows the name instead of its folder; its tooltip keeps the path.
const TAB_ALIASES_KEY = "gitp-tab-aliases";

export function loadTabAliases(): Record<string, string> {
  return parseTabAliases(localStorage.getItem(TAB_ALIASES_KEY));
}

// Name the tab for `path`, or with null (or a blank name) go back to the
// folder name.
export function saveTabAlias(path: string, alias: string | null): void {
  localStorage.setItem(TAB_ALIASES_KEY, JSON.stringify(withTabAlias(loadTabAliases(), path, alias)));
}

export function parseTabAliases(raw: string | null): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

export function withTabAlias(aliases: Record<string, string>, path: string, alias: string | null): Record<string, string> {
  const next = { ...aliases };
  const name = alias?.trim();
  if (name) next[path] = name;
  else delete next[path];
  return next;
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

// --- Zoom -------------------------------------------------------------------

// The steps Cmd/Ctrl + = and Cmd/Ctrl + − walk through, as scale factors.
export const ZOOM_LEVELS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.5, 1.75, 2];

const ZOOM_KEY = "gitp-zoom";

export function loadZoom(): number {
  const v = Number(localStorage.getItem(ZOOM_KEY));
  return ZOOM_LEVELS.includes(v) ? v : 1;
}

// The level after `zoom` going up (1) or down (-1), staying put at the ends.
export function steppedZoom(zoom: number, step: 1 | -1): number {
  if (step > 0) return ZOOM_LEVELS.find((z) => z > zoom) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  return [...ZOOM_LEVELS].reverse().find((z) => z < zoom) ?? ZOOM_LEVELS[0];
}

// Apply and persist a zoom level for the whole window. The desktop app zooms
// the webview itself, like a browser's Cmd +; the browser preview can't reach
// that, so CSS zoom stands in for it there.
export async function applyZoom(zoom: number): Promise<void> {
  localStorage.setItem(ZOOM_KEY, String(zoom));
  try {
    if (isTauri()) {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      await getCurrentWebview().setZoom(zoom);
    } else {
      document.documentElement.style.zoom = zoom === 1 ? "" : String(zoom);
    }
  } catch (err) {
    readFailed("Couldn't zoom", err);
    return;
  }
  // The terminal's rows and columns come from the pixel size it measured;
  // after a zoom they no longer fill the panel until it measures again.
  requestAnimationFrame(() => ui.terminal?.fit());
}
