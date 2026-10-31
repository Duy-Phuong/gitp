// Preferences persisted in localStorage, and the theme.

import { isTauri } from "./api";
import { $ } from "./dom";
import type { DetailTab } from "./views/detail";
import type { PullMode } from "./types";
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

// Author initials in the graph's commit nodes instead of Gravatar images —
// which also stops sending email hashes to gravatar.com.
const AUTHOR_INITIALS_KEY = "gitp-author-initials";

export function loadAuthorInitials(): boolean {
  return localStorage.getItem(AUTHOR_INITIALS_KEY) === "1";
}

export function saveAuthorInitials(on: boolean): void {
  localStorage.setItem(AUTHOR_INITIALS_KEY, on ? "1" : "0");
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

// The shell line that writes a review of a pull request's diff (on its
// stdin), for "Generate Drafts". The default asks the Claude Code CLI — Opus
// at medium effort — for findings in the shape the Drafts tab reads.
const REVIEW_COMMAND_KEY = "gitp-review-command";

export const DEFAULT_REVIEW_COMMAND =
  "claude -p --model opus --effort medium 'Review the pull request diff on stdin as a careful senior engineer. " +
  "Report only real problems: bugs, missing error handling, security issues, broken tests. " +
  "For each one write a block: a \"### path/to/file:line\" heading where line is in the new file, " +
  "a \"**Severity:** blocking|minor|nit\" line, then \"**Comment to paste:**\" and the comment for the author " +
  "between <!-- copy:start --> and <!-- copy:end --> markers, short and concrete, with a ```suggestion block when the fix is a few lines. " +
  "If nothing is wrong print exactly: No findings.'";

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
