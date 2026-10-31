// The keyboard shortcut pack: which keys mean which action, how a binding is
// matched against a key event, and how it is spelled for a tooltip or the
// cheat sheet (⌘⇧P on a Mac, Ctrl+Shift+P elsewhere). Pure data and
// functions — what each action *does* is wired in keyboard.ts, so this can be
// imported by the toolbar and Quick Launch for their hints without dragging
// the whole app along.

export type ShortcutId =
  | "push"
  | "pull"
  | "fetch"
  | "branchMenu"
  | "newBranch"
  | "stash"
  | "stageAll"
  | "unstageAll"
  | "openRepo"
  | "cloneRepo"
  | "history"
  | "changes"
  | "code"
  | "searchCommits"
  | "terminal"
  | "settings"
  | "cheatSheet";

export type ShortcutGroup = "Sync" | "Branches and changes" | "Repositories" | "Views" | "App";

export interface Keys {
  /// `KeyboardEvent.key`, lowercased: a letter, "/", ",", "`".
  key: string;
  /// Cmd on a Mac, Ctrl elsewhere (the default), or Ctrl everywhere: for keys
  /// whose Cmd form the OS or the webview already means something by.
  modifier?: "mod" | "ctrl";
  shift?: boolean;
}

export interface ShortcutDef {
  label: string;
  group: ShortcutGroup;
  keys: Keys;
  /// Left alone when no repository is open (the sheet still lists it).
  needsRepo?: boolean;
}

// Cmd+letter combinations WebKit or macOS already own are avoided: C/V/X/A
// (clipboard, select all), Z/Y (Undo / Redo, bound in keyboard.ts), W/Q/H/M
// (window), K (Quick Launch), 1–9 (favorites) and = / − / 0 (zoom).
export const SHORTCUTS: Record<ShortcutId, ShortcutDef> = {
  push: { label: "Push", group: "Sync", keys: { key: "p", shift: true }, needsRepo: true },
  pull: { label: "Pull (default method)", group: "Sync", keys: { key: "l", shift: true }, needsRepo: true },
  fetch: { label: "Fetch all remotes", group: "Sync", keys: { key: "f", shift: true }, needsRepo: true },
  branchMenu: { label: "Switch branch", group: "Branches and changes", keys: { key: "b" }, needsRepo: true },
  newBranch: { label: "Create branch…", group: "Branches and changes", keys: { key: "n", shift: true }, needsRepo: true },
  stash: { label: "Save stash…", group: "Branches and changes", keys: { key: "s", shift: true }, needsRepo: true },
  stageAll: { label: "Stage all changes", group: "Branches and changes", keys: { key: "a", shift: true }, needsRepo: true },
  unstageAll: { label: "Unstage all changes", group: "Branches and changes", keys: { key: "u", shift: true }, needsRepo: true },
  openRepo: { label: "Open repository…", group: "Repositories", keys: { key: "o" } },
  cloneRepo: { label: "Clone repository…", group: "Repositories", keys: { key: "o", shift: true } },
  history: { label: "History", group: "Views", keys: { key: "h", shift: true }, needsRepo: true },
  changes: { label: "Local changes", group: "Views", keys: { key: "c", shift: true }, needsRepo: true },
  code: { label: "Code", group: "Views", keys: { key: "e", shift: true }, needsRepo: true },
  searchCommits: { label: "Search commits", group: "Views", keys: { key: "f" }, needsRepo: true },
  terminal: { label: "Terminal", group: "Views", keys: { key: "`", modifier: "ctrl" }, needsRepo: true },
  settings: { label: "Settings", group: "App", keys: { key: "," } },
  cheatSheet: { label: "Keyboard shortcuts", group: "App", keys: { key: "/" } },
};

/// Shortcuts bound elsewhere (keyboard.ts, the commit box, the log), listed on
/// the sheet so it is the one place to look. `keys` is already spelled out,
/// per platform.
export interface BuiltIn {
  label: string;
  group: ShortcutGroup | "Commit log" | "Code";
  mac: string;
  other: string;
}

export const BUILT_IN: BuiltIn[] = [
  { label: "Quick Launch", group: "App", mac: "⌘K", other: "Ctrl+K" },
  { label: "Undo", group: "App", mac: "⌘Z", other: "Ctrl+Z" },
  { label: "Redo", group: "App", mac: "⌘⇧Z", other: "Ctrl+Shift+Z" },
  { label: "Zoom in / out / reset", group: "App", mac: "⌘= / ⌘− / ⌘0", other: "Ctrl+= / Ctrl+− / Ctrl+0" },
  { label: "Favorite repository 1–9", group: "Repositories", mac: "⌘1 … ⌘9", other: "Ctrl+1 … Ctrl+9" },
  { label: "Next / previous repository tab", group: "Repositories", mac: "⌃Tab / ⌘⇧] / ⌘⇧[", other: "Ctrl+Tab / Ctrl+Shift+Tab" },
  { label: "Commit", group: "Branches and changes", mac: "⌘↩ in the message", other: "Ctrl+Enter in the message" },
  { label: "Move the selection", group: "Commit log", mac: "↑ ↓ or J K", other: "↑ ↓ or J K" },
  { label: "Page up / down", group: "Commit log", mac: "PgUp PgDn", other: "PgUp PgDn" },
  { label: "First / last loaded commit", group: "Commit log", mac: "Home End", other: "Home End" },
  { label: "Focus the diff", group: "Commit log", mac: "↩", other: "Enter" },
  { label: "Leave a comparison", group: "Commit log", mac: "Esc", other: "Esc" },
  { label: "Quick open file", group: "Code", mac: "⌘P", other: "Ctrl+P" },
  { label: "Find in files (instead of Fetch, in this tab)", group: "Code", mac: "⌘⇧F in the Code tab", other: "Ctrl+Shift+F in the Code tab" },
  { label: "Save", group: "Code", mac: "⌘S", other: "Ctrl+S" },
  { label: "Go to definition", group: "Code", mac: "F12 or ⌘-click", other: "F12 or Ctrl-click" },
  { label: "Back / forward", group: "Code", mac: "⌘⌥← / ⌘⌥→", other: "Ctrl+Alt+← / Ctrl+Alt+→" },
  { label: "Find usages", group: "Code", mac: "⌥F7", other: "Alt+F7" },
  { label: "Call hierarchy", group: "Code", mac: "⌃⌥H", other: "Ctrl+Alt+H" },
  { label: "Close file", group: "Code", mac: "⌘⇧W", other: "Ctrl+Shift+W" },
];

export const IS_MAC = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/// Whether `e` is exactly this binding: the key, the platform's modifier and
/// Shift as asked, nothing else held.
export function matches(keys: Keys, e: KeyboardEvent, isMac = IS_MAC): boolean {
  if (e.altKey) return false;
  if (keys.modifier === "ctrl") {
    if (!e.ctrlKey || e.metaKey) return false;
  } else if (isMac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) {
    return false;
  }
  if (Boolean(keys.shift) !== e.shiftKey) return false;
  // `e.key` is the shifted character for punctuation (Shift+/ is "?"), so a
  // letter is compared by its case-free name and anything else by its code.
  if (/^[a-z]$/.test(keys.key)) return e.key.toLowerCase() === keys.key;
  return e.key === keys.key || e.code === CODES[keys.key];
}

const CODES: Record<string, string> = { "/": "Slash", ",": "Comma", "`": "Backquote" };

const MAC_KEYS: Record<string, string> = { "`": "`", "/": "/", ",": "," };

/// The binding as the OS spells it: "⌘⇧P" / "⌃`" on a Mac, "Ctrl+Shift+P" elsewhere.
export function formatKeys(keys: Keys, isMac = IS_MAC): string {
  const key = /^[a-z]$/.test(keys.key) ? keys.key.toUpperCase() : (MAC_KEYS[keys.key] ?? keys.key);
  if (isMac) {
    const mod = keys.modifier === "ctrl" ? "⌃" : "⌘";
    return `${mod}${keys.shift ? "⇧" : ""}${key}`;
  }
  return `Ctrl+${keys.shift ? "Shift+" : ""}${key}`;
}

/// The spelled-out binding of a shortcut, for a tooltip or a Quick Launch detail.
export function shortcutHint(id: ShortcutId): string {
  return formatKeys(SHORTCUTS[id].keys);
}

/// The shortcut `e` is for, if any.
export function shortcutFor(e: KeyboardEvent, isMac = IS_MAC): ShortcutId | null {
  for (const id of Object.keys(SHORTCUTS) as ShortcutId[]) {
    if (matches(SHORTCUTS[id].keys, e, isMac)) return id;
  }
  return null;
}
