// Preferences persisted in localStorage, and the theme.

import { isTauri } from "./api";
import { $ } from "./dom";
import type { DetailTab } from "./views/detail";
import type { PullMode, TurnKind } from "./types";
import { DEFAULT_LOG_COLUMNS, normalizeLogColumns, type LogColumns } from "./log-columns";
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

// The pull request Files tab's layout: side by side, or unified (the default).
const PR_DIFF_SPLIT_KEY = "gitp-pr-diff-split";

export function loadPrDiffSplit(): boolean {
  return localStorage.getItem(PR_DIFF_SPLIT_KEY) === "1";
}

export function savePrDiffSplit(on: boolean): void {
  localStorage.setItem(PR_DIFF_SPLIT_KEY, on ? "1" : "0");
}

// The file tree beside a pull request's diffs: shown unless hidden once.
const PR_FILES_TREE_KEY = "gitp-pr-files-tree";

export function loadPrFilesTree(): boolean {
  return localStorage.getItem(PR_FILES_TREE_KEY) !== "0";
}

export function savePrFilesTree(on: boolean): void {
  localStorage.setItem(PR_FILES_TREE_KEY, on ? "1" : "0");
}

// "Collapse comments" in a pull request's Files tab: the threads and draft
// cards under the code fold to one line each, so the code reads on its own.
const PR_COLLAPSE_COMMENTS_KEY = "gitp-pr-collapse-comments";

export function loadPrCollapseComments(): boolean {
  return localStorage.getItem(PR_COLLAPSE_COMMENTS_KEY) === "1";
}

export function savePrCollapseComments(on: boolean): void {
  localStorage.setItem(PR_COLLAPSE_COMMENTS_KEY, on ? "1" : "0");
}

export function loadIgnoreWhitespace(): boolean {
  return localStorage.getItem(DIFF_IGNORE_WS_KEY) === "1";
}

export function saveIgnoreWhitespace(on: boolean): void {
  localStorage.setItem(DIFF_IGNORE_WS_KEY, on ? "1" : "0");
}

// Settings → Editor & Diff. Syntax highlighting is read as each diff is drawn
// (highlight.ts); the code font, size, tab width and line numbers are CSS
// variables on :root (see applyCodePrefs), shared by the diffs, the blame view
// and the file editor; the terminal has a font of its own.
const SYNTAX_KEY = "gitp-syntax-highlight";
const CODE_FONT_KEY = "gitp-code-font";
const CODE_SIZE_KEY = "gitp-code-font-size";
const TAB_SIZE_KEY = "gitp-tab-size";
const LINE_NUMBERS_KEY = "gitp-diff-line-numbers";
const TERMINAL_FONT_KEY = "gitp-terminal-font";
const TERMINAL_SIZE_KEY = "gitp-terminal-font-size";

export const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20];
export const TAB_SIZES = [2, 4, 8];
// What the code panes used before these settings existed.
const DEFAULT_FONT_SIZE = 12;
const DEFAULT_TAB_SIZE = 4;

// Font families offered by name; anything else is typed in as Custom. ""
// is the app's own monospace stack (--mono).
export const FONT_FAMILIES = [
  "SF Mono",
  "Menlo",
  "Monaco",
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Source Code Pro",
  "Consolas",
  "Courier New",
];

export function loadSyntaxHighlight(): boolean {
  return localStorage.getItem(SYNTAX_KEY) !== "0";
}

export function saveSyntaxHighlight(on: boolean): void {
  localStorage.setItem(SYNTAX_KEY, on ? "1" : "0");
}

// The Code tab's inline blame after the caret's line; on unless turned off.
const INLINE_BLAME_KEY = "gitp-inline-blame";

export function loadInlineBlame(): boolean {
  return localStorage.getItem(INLINE_BLAME_KEY) !== "0";
}

export function saveInlineBlame(on: boolean): void {
  localStorage.setItem(INLINE_BLAME_KEY, on ? "1" : "0");
}

export interface CodePrefs {
  font: string;
  size: number;
  tabSize: number;
  lineNumbers: boolean;
}

function oneOf(raw: string | null, choices: number[], fallback: number): number {
  const v = Number(raw);
  return choices.includes(v) ? v : fallback;
}

export function loadCodePrefs(): CodePrefs {
  return {
    font: localStorage.getItem(CODE_FONT_KEY) ?? "",
    size: oneOf(localStorage.getItem(CODE_SIZE_KEY), FONT_SIZES, DEFAULT_FONT_SIZE),
    tabSize: oneOf(localStorage.getItem(TAB_SIZE_KEY), TAB_SIZES, DEFAULT_TAB_SIZE),
    lineNumbers: localStorage.getItem(LINE_NUMBERS_KEY) !== "0",
  };
}

export function saveCodePrefs(p: CodePrefs): void {
  localStorage.setItem(CODE_FONT_KEY, p.font);
  localStorage.setItem(CODE_SIZE_KEY, String(p.size));
  localStorage.setItem(TAB_SIZE_KEY, String(p.tabSize));
  localStorage.setItem(LINE_NUMBERS_KEY, p.lineNumbers ? "1" : "0");
  applyCodePrefs(p);
}

// The CSS variables that carry `p` (styles.css reads them).
export function codeCssVars(p: CodePrefs): Record<string, string> {
  return {
    "--code-font": fontStack(p.font, "var(--mono)"),
    "--code-size": `${p.size}px`,
    "--tab-size": String(p.tabSize),
  };
}

export function applyCodePrefs(p: CodePrefs = loadCodePrefs()): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(codeCssVars(p))) root.style.setProperty(name, value);
  root.toggleAttribute("data-no-line-numbers", !p.lineNumbers);
}

// A CSS font-family value: `family` first, then `fallback` for the glyphs it
// lacks (or for all of them, when it isn't installed). One family name with a
// space needs quotes; a list the user typed is used as written.
export function fontStack(family: string, fallback: string): string {
  const f = family.trim();
  if (!f) return fallback;
  const first = /[,"']/.test(f) || !/\s/.test(f) ? f : `"${f}"`;
  return `${first}, ${fallback}`;
}

export interface TerminalFont {
  font: string;
  size: number;
}

export function loadTerminalFont(): TerminalFont {
  return {
    font: localStorage.getItem(TERMINAL_FONT_KEY) ?? "",
    size: oneOf(localStorage.getItem(TERMINAL_SIZE_KEY), FONT_SIZES, DEFAULT_FONT_SIZE),
  };
}

export function saveTerminalFont(f: TerminalFont): void {
  localStorage.setItem(TERMINAL_FONT_KEY, f.font);
  localStorage.setItem(TERMINAL_SIZE_KEY, String(f.size));
  // Like the theme, xterm holds its font as JS values.
  ui.terminal?.syncFont();
}

// What the plain Pull button runs. "FetchAll" isn't a real pull (no merge) but
// is offered alongside the pull strategies, GitKraken-style.
// Merge is only offered when a pull stops on diverged branches, not as a default.
export type PullDefault = "FetchAll" | Exclude<PullMode, "Merge">;

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

// Whether the background fetch (auto-fetch, and the one on opening History or
// Local Changes) prunes remote-tracking branches deleted upstream. On by
// default — every fetch pruned before this was a setting. A fetch you start
// yourself always prunes.
const AUTO_FETCH_PRUNE_KEY = "gitp-auto-fetch-prune";

export function loadAutoFetchPrune(): boolean {
  return localStorage.getItem(AUTO_FETCH_PRUNE_KEY) !== "0";
}

export function saveAutoFetchPrune(on: boolean): void {
  localStorage.setItem(AUTO_FETCH_PRUNE_KEY, on ? "1" : "0");
}

// How dates read everywhere one is shown (see formatTime in timeago.ts):
// "3h ago", "2026-10-30 14:05", or the system locale's own short form.
export type DateFormat = "relative" | "absolute" | "locale";

export const DATE_FORMATS: { format: DateFormat; label: string }[] = [
  { format: "relative", label: "Relative (3h ago)" },
  { format: "absolute", label: "Absolute (2026-10-30 14:05)" },
  { format: "locale", label: "System locale" },
];

const DATE_FORMAT_KEY = "gitp-date-format";

export function loadDateFormat(): DateFormat {
  const v = localStorage.getItem(DATE_FORMAT_KEY);
  return v === "absolute" || v === "locale" ? v : "relative";
}

export function saveDateFormat(format: DateFormat): void {
  localStorage.setItem(DATE_FORMAT_KEY, format);
}

// What the graph's commit nodes show for their author: Gravatar images (the
// default), initials, or a picture of gitp's own (src/assets/avatars), the
// same one for an author every time. Initials and the pictures send nothing
// to gravatar.com.
export type AvatarStyle = "gravatar" | "initials" | "custom";
const AVATAR_STYLE_KEY = "gitp-avatar-style";
// The switch before Custom existed: "1" for initials.
const AUTHOR_INITIALS_KEY = "gitp-author-initials";

export function loadAvatarStyle(): AvatarStyle {
  const saved = localStorage.getItem(AVATAR_STYLE_KEY);
  if (saved === "gravatar" || saved === "initials" || saved === "custom") return saved;
  return localStorage.getItem(AUTHOR_INITIALS_KEY) === "1" ? "initials" : "gravatar";
}

export function saveAvatarStyle(style: AvatarStyle): void {
  localStorage.setItem(AVATAR_STYLE_KEY, style);
}

// The picture of gitp's own (its file name, "avatar-07.jpg") chosen for the
// user: on their own commits and the profile button. Null for none chosen.
const MY_AVATAR_KEY = "gitp-my-avatar";

export function loadMyAvatar(): string | null {
  return localStorage.getItem(MY_AVATAR_KEY) || null;
}

export function saveMyAvatar(name: string | null): void {
  if (name) localStorage.setItem(MY_AVATAR_KEY, name);
  else localStorage.removeItem(MY_AVATAR_KEY);
}

export function loadAuthorInitials(): boolean {
  return loadAvatarStyle() === "initials";
}

// The branch Init Repository starts a new repository on, prefilled in its
// dialog. "main" rather than git's own default, which depends on the git
// version and init.defaultBranch.
const DEFAULT_BRANCH_KEY = "gitp-default-branch";

export function loadDefaultBranch(): string {
  return localStorage.getItem(DEFAULT_BRANCH_KEY)?.trim() || "main";
}

export function saveDefaultBranch(name: string): void {
  localStorage.setItem(DEFAULT_BRANCH_KEY, name.trim());
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

// Per-repo log columns (which of Author, Date and SHA show, and their order),
// keyed by repo path like the graph settings. Kept apart from GraphPrefs:
// those describe which commits the log walks, and changing them reloads it;
// a column change only redraws the rows on screen.
const LOG_COLUMNS_KEY = "gitp-log-columns:";

export function loadLogColumns(repo: string): LogColumns {
  try {
    return normalizeLogColumns(JSON.parse(localStorage.getItem(LOG_COLUMNS_KEY + repo) ?? "{}"));
  } catch {
    return DEFAULT_LOG_COLUMNS;
  }
}

export function saveLogColumns(repo: string, cols: LogColumns): void {
  localStorage.setItem(LOG_COLUMNS_KEY + repo, JSON.stringify(cols));
}

// Hovering a branch fades the commits that aren't on it (Settings → History).
// On by default, as in GitKraken.
const BRANCH_HOVER_KEY = "gitp-branch-hover-fade";

export function loadBranchHoverFade(): boolean {
  return localStorage.getItem(BRANCH_HOVER_KEY) !== "0";
}

export function saveBranchHoverFade(on: boolean): void {
  localStorage.setItem(BRANCH_HOVER_KEY, on ? "1" : "0");
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

// The Code tab's recently opened files (Quick Open), keyed by repo path,
// newest first.
const CODE_RECENT_KEY = "gitp-code-recent";

export function loadCodeRecent(repo: string): string[] {
  return parseCodeRecent(localStorage.getItem(CODE_RECENT_KEY))[repo] ?? [];
}

export function saveCodeRecent(repo: string, paths: string[]): void {
  localStorage.setItem(CODE_RECENT_KEY, JSON.stringify(withCodeRecent(parseCodeRecent(localStorage.getItem(CODE_RECENT_KEY)), repo, paths)));
}

export function parseCodeRecent(raw: string | null): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([repo, v]) => (Array.isArray(v) ? [[repo, v.filter((p): p is string => typeof p === "string")]] : [])),
    );
  } catch {
    return {};
  }
}

export function withCodeRecent(all: Record<string, string[]>, repo: string, paths: string[]): Record<string, string[]> {
  const next = { ...all };
  if (paths.length) next[repo] = paths;
  else delete next[repo];
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

// The dark theme Toggle Theme goes back to: the last one chosen.
const LAST_DARK_THEME_KEY = "gitp-last-dark-theme";

const DARK_THEMES: ThemeChoice[] = ["dark", "gitkraken", "gitkraken-neon"];

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
    if (DARK_THEMES.includes(choice)) localStorage.setItem(LAST_DARK_THEME_KEY, choice);
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

// Toggle Theme (Quick Launch): from whatever is showing that is dark — a dark
// theme, or System while the OS is dark — to Light; from light back to the
// dark theme last chosen (Dark if none was). One keystroke flips between the
// two looks someone actually uses, without stepping through every theme.
export function toggledTheme(): ThemeChoice {
  const saved = localStorage.getItem(LAST_DARK_THEME_KEY);
  const lastDark = (DARK_THEMES as string[]).includes(saved ?? "") ? (saved as ThemeChoice) : "dark";
  return nextToggleTheme(currentTheme(), window.matchMedia("(prefers-color-scheme: dark)").matches, lastDark);
}

export function nextToggleTheme(current: ThemeChoice, osDark: boolean, lastDark: ThemeChoice): ThemeChoice {
  const showingDark = DARK_THEMES.includes(current) || (current === "system" && osDark);
  return showingDark ? "light" : lastDark;
}

// `~/…` rather than the absolute path, the way every git client shows it.
//
// Matched structurally rather than against a known home directory, which the
// webview has no way to ask for; a path under some *other* user's home would be
// shortened too, but that only ever affects how it reads, never where it opens.
export function tildePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+\//, "~/");
}

// A fresh run's Claude Code session id, which gitp offers in the environment
// (see run_shell in core): with it the Claude jobs view reads the run's
// transcript while it goes. Empty on a resume, so nothing is added then.
export const SESSION_ID_ARG = '${GITP_CLAUDE_NEW_SESSION:+--session-id "$GITP_CLAUDE_NEW_SESSION"}';

// The model and effort of every Claude run gitp starts (Settings → Claude
// model, Claude effort). gitp writes them into each command's --model and
// --effort as it starts it, so a command edited by hand follows them too; a
// command with neither flag runs as written.
export const CLAUDE_MODELS = ["opus", "sonnet", "haiku"] as const;
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];
export interface ClaudeChoice {
  model: ClaudeModel;
  effort: ClaudeEffort;
}
const CLAUDE_MODEL_KEY = "gitp-claude-model";
const CLAUDE_EFFORT_KEY = "gitp-claude-effort";
export const DEFAULT_CLAUDE_CHOICE: ClaudeChoice = { model: "opus", effort: "medium" };

const stored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export function loadClaudeChoice(): ClaudeChoice {
  const model = stored(CLAUDE_MODEL_KEY);
  const effort = stored(CLAUDE_EFFORT_KEY);
  return {
    model: CLAUDE_MODELS.find((m) => m === model) ?? DEFAULT_CLAUDE_CHOICE.model,
    effort: CLAUDE_EFFORTS.find((e) => e === effort) ?? DEFAULT_CLAUDE_CHOICE.effort,
  };
}

// The default forgets the key, like the commands.
export function saveClaudeChoice(choice: ClaudeChoice): void {
  try {
    if (choice.model === DEFAULT_CLAUDE_CHOICE.model) localStorage.removeItem(CLAUDE_MODEL_KEY);
    else localStorage.setItem(CLAUDE_MODEL_KEY, choice.model);
    if (choice.effort === DEFAULT_CLAUDE_CHOICE.effort) localStorage.removeItem(CLAUDE_EFFORT_KEY);
    else localStorage.setItem(CLAUDE_EFFORT_KEY, choice.effort);
  } catch {
    // Full or blocked storage: the choice just doesn't survive a restart.
  }
}

// `command` with every --model and --effort value set to `choice`: "--model
// x", "--model=x" or a quoted value.
export function withClaudeChoice(command: string, choice: ClaudeChoice = loadClaudeChoice()): string {
  return command
    .replace(/(--model)(\s+|=)("[^"]*"|'[^']*'|[^\s"']+)/g, `$1$2${choice.model}`)
    .replace(/(--effort)(\s+|=)("[^"]*"|'[^']*'|[^\s"']+)/g, `$1$2${choice.effort}`);
}

// The shell line that writes a review of a pull request's diff (on its
// stdin), for "Run Review Command". The default asks the Claude Code CLI — Opus
// at medium effort — for findings in the shape the Drafts tab reads.
const REVIEW_COMMAND_KEY = "gitp-review-command";

export const DEFAULT_REVIEW_COMMAND =
  `claude -p ${SESSION_ID_ARG} --model opus --effort medium ` +
  "'Review the pull request diff on stdin as a careful senior engineer. " +
  "Report only real problems: bugs, missing error handling, security issues, broken tests. " +
  "For each one write a block: a \"### path/to/file:line\" heading where line is in the new file, " +
  "a \"**Severity:** blocking|minor|nit\" line, then \"**Comment to paste:**\" and the comment for the author " +
  "between <!-- copy:start --> and <!-- copy:end --> markers, short and concrete, with a ```suggestion block when the fix is a few lines. " +
  "If nothing is wrong print exactly: No findings.'";

// "Use Review Skill" in Settings: the /review-pr-phuong Claude Code skill,
// which saves its review page in the review folder (gitp reads the drafts
// from there). gitp sets $GITP_REVIEW_DIR to that folder as Settings → Claude
// has it (review/ unless set) and $GITP_REVIEW_PATH to it in full. Nobody can
// answer a permission prompt in the background, so dontAsk refuses every
// tool the list doesn't name: reads, git and gh lookups, the skill's checks
// and page build, writes in the review folder, the Jira and Confluence reads
// and the Review Board.
const SKILL_TOOLS = [
  // Edit(path) covers every file-writing tool, Write included. A path rule
  // is relative to Claude's working directory, which a `cd` in a Bash call
  // moves (into the skill's folder, say), so the folder is also given by its
  // full path: "//" + $GITP_REVIEW_PATH.
  "Read", "Grep", "Glob", "Skill", "Edit($GITP_REVIEW_DIR/**)", "Edit(/$GITP_REVIEW_PATH/**)",
  "Bash(git diff *)", "Bash(git log *)", "Bash(git show *)", "Bash(git grep *)", "Bash(git fetch *)",
  "Bash(git rev-parse *)", "Bash(git merge-base *)", "Bash(git ls-files *)", "Bash(git blame *)",
  "Bash(gh pr view *)", "Bash(gh pr diff *)", "Bash(gh api --paginate repos/*)",
  "Bash(mkdir -p $GITP_REVIEW_DIR/*)", "Bash(mkdir -p $GITP_REVIEW_PATH/*)", "Bash(rm $GITP_REVIEW_DIR/*)",
  "Bash(curl -fsSL https://cdn.jsdelivr.net/*)", "Bash(python3 *)",
  ...["claude_ai_Atlassian", "claude_ai_Atlassian_MCP"].flatMap((server) =>
    ["getJiraIssue", "searchJiraIssuesUsingJql", "getConfluencePage"].map((tool) => `mcp__${server}__${tool}`),
  ),
  "ArtifactData",
];

// The prompt comes first: --allowedTools takes every word after it as a tool,
// so a prompt behind it would be swallowed and claude would get none.
export const SKILL_REVIEW_COMMAND =
  `claude -p "/review-pr-phuong $GITP_PR_URL board mode, with md, no questions: where you would ask, take the default ` +
  `(the sprint folder no-sprint when Jira has no sprint). Write the review Markdown under $GITP_REVIEW_DIR/, not in TMPDIR." ` +
  `--model opus --effort medium --permission-mode dontAsk ${SESSION_ID_ARG} --allowedTools "${SKILL_TOOLS.join(" ")}"`;

// Run Review Skill on a local branch (no pull request yet): the skill's
// branch form, against the base the panel's Against names, in the branch's
// worktree; not board mode, which is for pull requests.
export const BRANCH_SKILL_REVIEW_COMMAND =
  `claude -p "/review-pr-phuong $GITP_BRANCH against $GITP_BASE, with md, no questions: where you would ask, take the default ` +
  `(the sprint folder no-sprint when Jira has no sprint). Write the review Markdown under $GITP_REVIEW_DIR/, not in TMPDIR." ` +
  `--model opus --effort medium --permission-mode dontAsk ${SESSION_ID_ARG} --allowedTools "${SKILL_TOOLS.join(" ")}"`;

// "Explain more" on a finding of a saved review, done here as the review board
// does it, without the board: the /explain-simply skill on the finding, which
// comes on stdin with the answers it had already, and gitp adds the answer to
// the review's .md and .html. Claude reads the code at the reviewed head and
// writes only its scratch file and checks in the temp folder.
const EXPLAIN_TOOLS = [
  "Read", "Grep", "Glob", "Skill",
  // The temp folders by fixed paths ($TMPDIR is under /var/folders on macOS):
  // an unset variable can't widen a rule to the whole disk.
  "Edit(//tmp/**)", "Edit(//private/tmp/**)", "Edit(//var/folders/**)", "Edit(//private/var/folders/**)", "Bash(python3 *)",
  "Bash(git show *)", "Bash(git log *)", "Bash(git diff *)", "Bash(git grep *)", "Bash(git fetch *)", "Bash(git blame *)",
  "Bash(gh pr view *)", "Bash(gh pr diff *)",
];
export const EXPLAIN_FINDING_COMMAND =
  `claude -p "/explain-simply the review finding on stdin (finding $GITP_REVIEW_FINDING of $GITP_REVIEW_FILE), ` +
  `for the reviewer who must decide on it. Read the real code at the reviewed head $GITP_REVIEW_HEAD (git show <sha>:<path>; git fetch first when it is missing). ` +
  `When the finding has Explained more answers already, the reader did not understand them: explain it another way ` +
  `(another diagram shape, a daily-life comparison, or smaller steps) and repeat nothing of them. ` +
  `Write your scratch file with the Write tool, not through Bash, then run the STE check on it with python3. ` +
  `Ask no questions and change no file of the repository. Your last message is only the explanation in Markdown, as it goes into the review file: ` +
  `no note about the checks or the tools before or after it." ` +
  `--model opus --effort medium --permission-mode dontAsk --output-format json ${SESSION_ID_ARG} --allowedTools "${EXPLAIN_TOOLS.join(" ")}"`;

// "Explain with Claude" on a commit, a branch or a tag: what Claude reads
// comes on stdin (see claude_ask.rs). It may look at the repository for
// context but changes nothing.
const askCommand = (prompt: string) =>
  `claude -p "${prompt} Read the repository for context when it helps; change nothing and ask no questions. Answer in Markdown." ` +
  `--model opus --effort medium --permission-mode dontAsk --output-format json ${SESSION_ID_ARG} ` +
  `--allowedTools "Read Grep Glob Bash(git log *) Bash(git show *) Bash(git diff *) Bash(git blame *)"`;

export const ASK_COMMANDS = {
  commit: askCommand(
    "Explain the commit on stdin to a teammate: what it changes, why (from its message and the code), and anything risky or worth testing. Keep it short, with headings.",
  ),
  branch: askCommand(
    "Summarize the branch on stdin for a reviewer: what it does and why, the main changes by area, and what to look at closely. Keep it short, with headings.",
  ),
  release: askCommand(
    "Write release notes from the commits on stdin: group them under Features, Fixes and Other, one plain line each, leave out merges and chores.",
  ),
  myWork: askCommand(
    "Write my stand-up update from the work on stdin (my commits by repository, the pull requests I opened or updated, and the ones I reviewed): Done, In progress and Reviews, a few plain bullets each, grouped by ticket (keys such as UBIID-1234) or pull request, merged pull requests under Done. No preamble.",
  ),
} as const;

// "Suggest with Claude" in the conflict resolver: the conflicts of one file
// come on stdin (see conflictPrompt in conflict-help.ts), with the answer's
// JSON format. Claude may read the repository for context but change nothing:
// dontAsk refuses every tool the list doesn't name.
export const RESOLVE_CONFLICT_COMMAND =
  `claude -p "Resolve the merge conflicts described on stdin and answer exactly as it says. ` +
  `Read the repository for context when it helps, but change nothing and ask no questions." ` +
  `--model opus --effort medium --permission-mode dontAsk --output-format json ${SESSION_ID_ARG} ` +
  `--allowedTools "Read Grep Glob Bash(git log *) Bash(git show *) Bash(git diff *) Bash(git blame *)"`;

// "Resolve Conflicts with Claude" on a pull request: run in the branch's
// worktree in the middle of a merge of the base, with the conflicted files on
// stdin. Claude edits them and nothing else: no git add, no commit, no new
// file (gitp checks all three, stages the files and waits for the user).
export const RESOLVE_PR_CONFLICTS_COMMAND =
  `claude -p "Merging the base into this pull request's branch stopped with conflicts in the files listed on stdin. ` +
  `Resolve them: edit each file so it keeps what both sides meant, with no conflict marker left. ` +
  `Read git log, git show and git diff of both sides when it helps. Do not stage, commit or create files, ` +
  `and ask no questions. Then say in a few short lines what you chose in each file." ` +
  `--model opus --effort medium --permission-mode dontAsk --output-format json ` +
  `--allowedTools "Read Grep Glob Edit Bash(git log *) Bash(git show *) Bash(git diff *) Bash(git blame *) Bash(git status *)"`;

// The commands behind Check, Explain simply, a follow-up and Reply with
// Claude on a pull request thread. Read-only toward the checkout and GitHub:
// the review skill's lookups, none of its writes under review/, no python,
// no board — and no git fetch (gitp fetches the head itself; a fetch can move
// a branch) or gh api (it can post), since the thread's comments, written by
// other people, reach the model under dontAsk. The thread arrives as JSON in
// $GITP_THREAD_FILE, the user's text on stdin, and a kept session is resumed
// (see thread_claude_turn in core).
export const THREAD_TOOLS = [
  ...SKILL_TOOLS.filter((t) => !/^Edit\(|mkdir|\brm |python3|curl|ArtifactData|git fetch|gh api/.test(t)),
  "ToolSearch",
];

const THREAD_RULES =
  "Read the code at commit $GITP_PR_HEAD with git show $GITP_PR_HEAD:path, never the checkout. " +
  "Fix nothing, post nothing, ask no questions. Answer in Markdown.";

// The fix's tools: the thread's lookups, plus editing, staging, committing
// and the test runners — in the pull request branch's worktree, which gitp
// resets when the run fails. Never push, gh, or anything that moves branches.
export const FIX_TOOLS = [
  ...THREAD_TOOLS,
  "Edit",
  "Write",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(git status *)",
  "Bash(git stash list)",
  "Bash(npm test*)",
  "Bash(npx vitest *)",
  "Bash(cargo test *)",
  "Bash(./gradlew test)",
  "Bash(./gradlew test --tests *)",
  "Bash(mvn test)",
  "Bash(mvn test -*)",
  // Integration tests (failsafe) run under verify.
  "Bash(mvn verify)",
  "Bash(mvn verify -*)",
  "Bash(pytest *)",
  "Bash(go test *)",
];

// The prompt comes first: --allowedTools takes every word after it as a tool.
const threadCommand = (prompt: string, tools = THREAD_TOOLS) =>
  `claude -p "${prompt}" --model opus --effort medium --permission-mode dontAsk ` +
  `--allowedTools "${tools.join(" ")}" --output-format json ` +
  '${GITP_CLAUDE_SESSION:+--resume "$GITP_CLAUDE_SESSION"} ' +
  SESSION_ID_ARG;

export const DEFAULT_THREAD_COMMANDS: Record<TurnKind, string> = {
  check: threadCommand(
    "Read the review thread in $GITP_THREAD_FILE on pull request $GITP_PR_URL. Check the reviewer's claim " +
      "against the code for this one thread, as phase 2 steps 1 and 2 of the answer-pr-comments skill do: " +
      "then explain it simply: one bottom line, an ASCII flow with the place where it goes wrong marked, " +
      "when it really happens with proof as file:line, a worked example with real values, and the options " +
      "(the reviewer's suggestion, an alternative, no change) in a table. " +
      THREAD_RULES,
  ),
  explain: threadCommand(
    "Read the review thread in $GITP_THREAD_FILE on pull request $GITP_PR_URL. Explain what it is about " +
      "in the shape of the explain-simply skill: one bottom line, one ASCII diagram, one example with small " +
      "numbers. Do not judge whether the reviewer is right. " +
      THREAD_RULES,
  ),
  followup: threadCommand(
    "Continue the conversation about the review thread in $GITP_THREAD_FILE on pull request $GITP_PR_URL; " +
      "the file holds the conversation so far. The user's message is on stdin. " +
      THREAD_RULES,
  ),
  "reply-draft": threadCommand(
    "You are @$GITP_GH_LOGIN; the pull request $GITP_PR_URL is by @$GITP_PR_AUTHOR. Draft the reply you post " +
      "in the review thread in $GITP_THREAD_FILE, building on the conversation in it and on the option on " +
      "stdin when there is one. Plain, short, in the first person. Print only the reply, no heading, no " +
      "explanation. " +
      THREAD_RULES,
  ),
  // One Fix command for both: a thread (its conversation ends with the
  // option the user chose) and a review finding on a branch or on your own
  // pull request (JSON with "kind": "finding"; the finding's text on stdin).
  fix: threadCommand(
    "Read $GITP_THREAD_FILE: a review thread on a pull request, or a review finding on a branch " +
      "(JSON with kind finding: path, line, side, body, severity, diff_hunk, branch, base). For a thread the " +
      "conversation in it ends with the option the user chose; for a finding, do what it asks. Either way " +
      "that text is also on stdin. You are in the worktree of the branch; the tree is clean. Make the " +
      "smallest change that answers it, matching the style around it. Add or update a test and run the " +
      "project's test command for it. Run each command as it is, from the worktree, with nothing like cd " +
      "or export in front: the permission rules match a command's start. Then commit exactly once on the " +
      "current branch, with 'fix(review): <path>:<line> — <what>' as the subject and a body that names the " +
      "point and what changed. If the commit is refused, leave the change uncommitted: gitp commits it. " +
      "If the chosen option needs no change to the code (only a test run, or no change), change nothing " +
      "and commit nothing: say what you ran and what came out. Do not push, do not post, do not touch " +
      "other branches. Print a short summary in Markdown: the files changed, the test and whether it ran, " +
      "the commit id.",
    FIX_TOOLS,
  ),
};

// Check N Comments: one run checks every open thread not checked yet, with
// them all as JSON in $GITP_THREADS_FILE. gitp cuts the answer at the
// <!-- gitp-thread: id --> lines and keeps each part as its thread's Check
// (see check_threads in core).
export const DEFAULT_CHECK_ALL_COMMAND = threadCommand(
  "Read the review threads in $GITP_THREADS_FILE on pull request $GITP_PR_URL: JSON whose threads list " +
    "holds each thread's id, path, line, diff_hunk, comments and earlier turns. For each thread, check the " +
    "reviewer's claim against the code, as phase 2 steps 1 and 2 of the answer-pr-comments skill do: then " +
    "explain it simply: one bottom line, an ASCII flow with the place where it goes wrong marked, when it " +
    "really happens with proof as file:line, a worked example with real values, and the options (the " +
    "reviewer's suggestion, an alternative, no change) in a table. Read code that several threads share " +
    "once, but write each thread's answer so it stands alone. Start each thread's answer with a line that " +
    "is exactly <!-- gitp-thread: ID --> with that thread's id, in the order of the file, and print " +
    "nothing before the first one. " +
    THREAD_RULES,
);

const CHECK_ALL_COMMAND_KEY = "gitp-check-all-command";

export function loadCheckAllCommand(): string {
  try {
    return localStorage.getItem(CHECK_ALL_COMMAND_KEY) ?? DEFAULT_CHECK_ALL_COMMAND;
  } catch {
    return DEFAULT_CHECK_ALL_COMMAND;
  }
}

// Blank, or the default itself, forgets the custom command.
export function saveCheckAllCommand(command: string): void {
  try {
    if (command.trim() === DEFAULT_CHECK_ALL_COMMAND || !command.trim()) localStorage.removeItem(CHECK_ALL_COMMAND_KEY);
    else localStorage.setItem(CHECK_ALL_COMMAND_KEY, command.trim());
  } catch {
    // Full or blocked storage: the command just doesn't survive a restart.
  }
}

const threadCommandKey = (kind: TurnKind) => `gitp-thread-command-${kind}`;

export function loadThreadCommand(kind: TurnKind): string {
  try {
    return localStorage.getItem(threadCommandKey(kind)) ?? DEFAULT_THREAD_COMMANDS[kind];
  } catch {
    // Blocked storage: the default, so a turn can still start.
    return DEFAULT_THREAD_COMMANDS[kind];
  }
}

// Blank, or the default itself, forgets the custom command.
export function saveThreadCommand(kind: TurnKind, command: string): void {
  const key = threadCommandKey(kind);
  try {
    if (command.trim() === DEFAULT_THREAD_COMMANDS[kind] || !command.trim()) localStorage.removeItem(key);
    else localStorage.setItem(key, command.trim());
  } catch {
    // Full or blocked storage: the command just doesn't survive a restart.
  }
}

const JIRA_SITE_KEY = "gitp-jira-site";

// The Jira site (https://team.atlassian.net) whose tickets the pull request
// title's Jira icon opens; blank hides the icon.
export function loadJiraSite(): string {
  return localStorage.getItem(JIRA_SITE_KEY) ?? "";
}

export function saveJiraSite(site: string): void {
  if (site.trim()) localStorage.setItem(JIRA_SITE_KEY, site.trim());
  else localStorage.removeItem(JIRA_SITE_KEY);
}

export function loadReviewCommand(): string {
  return localStorage.getItem(REVIEW_COMMAND_KEY) ?? DEFAULT_REVIEW_COMMAND;
}

export function saveReviewCommand(command: string): void {
  if (command.trim() === DEFAULT_REVIEW_COMMAND || !command.trim()) localStorage.removeItem(REVIEW_COMMAND_KEY);
  else localStorage.setItem(REVIEW_COMMAND_KEY, command.trim());
}

// The commands Quick Launch ran most recently, newest first, so they can be
// offered at the top next time. By label: the command list is rebuilt on
// every opening, and a label that no longer exists is simply not shown.
const RECENT_COMMANDS_KEY = "gitp-ql-recent-commands";
export const RECENT_COMMANDS_LIMIT = 6;

export function loadRecentCommands(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_COMMANDS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rememberCommand(label: string): void {
  const next = [label, ...loadRecentCommands().filter((l) => l !== label)].slice(0, RECENT_COMMANDS_LIMIT);
  localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next));
}

// Local history: snapshots of the working tree as files change. On unless
// turned off in Settings → Git.
const LOCAL_HISTORY_KEY = "gitp-local-history";

export function loadLocalHistoryEnabled(): boolean {
  return localStorage.getItem(LOCAL_HISTORY_KEY) !== "0";
}

export function saveLocalHistoryEnabled(on: boolean): void {
  localStorage.setItem(LOCAL_HISTORY_KEY, on ? "1" : "0");
}

// The Code tab's splitter positions.
const CODE_LAYOUT_KEY = "gitp.codeLayout";

export interface CodeLayout {
  explorerW: number;
  panelH: number;
}

export function loadCodeLayout(): CodeLayout {
  try {
    const raw = localStorage.getItem(CODE_LAYOUT_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<CodeLayout>) : {};
    return { explorerW: parsed.explorerW ?? 240, panelH: parsed.panelH ?? 220 };
  } catch {
    return { explorerW: 240, panelH: 220 };
  }
}

export function saveCodeLayout(layout: CodeLayout): void {
  localStorage.setItem(CODE_LAYOUT_KEY, JSON.stringify(layout));
}
