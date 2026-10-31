// Keyboard shortcuts: walking the commit log, Undo / Redo, Quick Launch,
// switching to a favorite repository or the next tab, and zoom.

import { $ } from "./dom";
import { state, ui } from "./app-state";
import { cycleRepoTab, leaveComparison, selectCommit, showView } from "./shell";
import {
  openStashDialogAction,
  pushAction,
  redoAction,
  refreshAllAction,
  runPullDefault,
  stageAllAction,
  undoAction,
  unstageAllAction,
} from "./repo-actions";
import { browseAndOpen, createBranchPrompt, openQuickLaunch, openRecentRepo } from "./quick-launch-commands";
import { cloneRepoAction } from "./new-repo-actions";
import { toggleTerminal } from "./terminal-panel";
import { applyZoom, loadFavoriteRepos, loadZoom, steppedZoom } from "./prefs";
import { setStatus } from "./report";
import { IS_MAC, SHORTCUTS, shortcutFor, shortcutHint, type ShortcutId } from "./shortcuts";
import { openShortcutsDialog } from "./views/shortcuts-dialog";

// --- Keyboard navigation in the commit log --------------------------------
//
// Walking history is the main thing a git client is for, and it was click-only:
// the only global keys were Cmd+Z/Y and Cmd+K. The log view owns the moving
// (see LogHandle — it knows which rows are on screen, which are the search
// results while a search is active); this decides when a key means navigation
// and what to do with the row it lands on.

// Whether a bare navigation key belongs to the log right now.
function logNavAllowed(e: KeyboardEvent): boolean {
  if (state.view !== "history") return false;
  // Modifiers belong to other shortcuts (Cmd+Z, Cmd+K); Shift is left alone for
  // a future range-extend.
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  // Anything layered over the log owns its own arrows: modals (including the
  // rebase editor), the Quick Launch palette, and open menus.
  if (document.querySelector(".modal-overlay, .ql-overlay, .commit-menu")) return false;
  if (document.querySelector(".menu:not(.hidden)")) return false;
  // `e.target` is only an Element when something focusable has focus; with focus
  // on the document itself there is nothing to defer to (and no .closest()).
  const t = e.target instanceof HTMLElement ? e.target : null;
  if (!t) return true;
  // Typing wins: the log search box, the commit message, the conflict editor,
  // the embedded terminal.
  if (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA") return false;
  if (t.closest("#terminal-host")) return false;
  return true;
}

export function setupLogKeyboardNav(): void {
  document.addEventListener("keydown", (e) => {
    if (!logNavAllowed(e)) return;
    const log = ui.logView;
    if (!log) return;

    let id: string | null;
    switch (e.key) {
      case "ArrowDown":
      case "j":
        id = log.moveSelection(1);
        break;
      case "ArrowUp":
      case "k":
        id = log.moveSelection(-1);
        break;
      case "PageDown":
        id = log.moveSelection(log.pageRows());
        break;
      case "PageUp":
        id = log.moveSelection(-log.pageRows());
        break;
      case "Home":
        id = log.selectEdge("first");
        break;
      case "End":
        // The oldest row *loaded* — the log is paged, so this is the end of what
        // we have, and landing there pulls in the next page like scrolling does.
        id = log.selectEdge("last");
        break;
      case "Escape":
        // Leave a comparison for the selected commit; otherwise not ours.
        if (!ui.detailView?.comparison()) return;
        e.preventDefault();
        void leaveComparison();
        return;
      case "Enter":
        // Hand focus to the diff so it can be scrolled from the keyboard too.
        focusDetailPane();
        e.preventDefault();
        return;
      default:
        return;
    }
    // The key was ours even at the ends of the list, so the page never scrolls
    // underneath the log.
    e.preventDefault();
    if (id) void selectCommit(id);
  });
}

// Move focus into the detail pane so its scroll container answers the keyboard.
// The pane isn't natively focusable, hence the tabindex.
function focusDetailPane(): void {
  const scroller = document.querySelector<HTMLElement>(
    "#detail-pane .file-view, #detail-pane .tab-scroll, #detail-pane .tree-view",
  );
  const target = scroller ?? $("#detail-pane");
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus();
}

// Cmd/Ctrl+K opens Quick Launch. Deliberately live while typing in an input
// too — the point of a palette is that it's always one keystroke away — but
// not inside the embedded terminal or the conflict editor, where the key
// belongs to what's focused, and not over a dialog: the Stash and Init / Clone
// dialogs take any Enter as theirs, so the palette's Enter would run both.
export function opensQuickLaunch(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return false;
  // `e.target` is only an Element when something focusable has focus; with
  // focus on the document itself there is nothing to defer to.
  const t = e.target instanceof HTMLElement ? e.target : null;
  if (t?.isContentEditable || t?.closest("#terminal-host")) return false;
  return !document.querySelector(".modal-overlay");
}

// Cmd+Shift+] / [ only mean "next / previous tab" on a Mac. (IS_MAC comes
// from shortcuts.ts, which reads it only where a `navigator` exists: the
// tests run on Node, which had none before Node 21.)

// --- The shortcut pack -------------------------------------------------------
//
// The bindings live in shortcuts.ts; this is what each one does. Most press
// the toolbar button or run the Quick Launch command of the same name, so a
// key and a click always do exactly the same thing.
const ACTIONS: Record<ShortcutId, () => void> = {
  push: () => void pushAction(),
  pull: () => void runPullDefault(),
  fetch: () => void refreshAllAction(),
  branchMenu: () => $("#branch-btn").click(),
  newBranch: () => createBranchPrompt(),
  stash: () => openStashDialogAction(),
  stageAll: () => void stageAllAction(),
  unstageAll: () => void unstageAllAction(),
  openRepo: () => void browseAndOpen(),
  cloneRepo: () => cloneRepoAction(),
  history: () => showView("history"),
  changes: () => showView("changes"),
  searchCommits: () => {
    showView("history");
    const input = document.querySelector<HTMLInputElement>("#log-search");
    input?.focus();
    input?.select();
  },
  terminal: () => toggleTerminal(),
  settings: () => $("#settings-btn").click(),
  cheatSheet: () => openShortcutsDialog(),
};

// Whether a pack shortcut may fire now: not while typing (a letter with Cmd
// held is a text-editing key in a field), not in the terminal, not under a
// dialog or the palette. The cheat sheet itself is the exception to the
// dialog rule, so Cmd+/ toggles it closed again.
export function packShortcutAllowed(e: KeyboardEvent, id: ShortcutId): boolean {
  const t = e.target instanceof HTMLElement ? e.target : null;
  if (t?.isContentEditable || t?.tagName === "INPUT" || t?.tagName === "TEXTAREA") return false;
  if (t?.closest("#terminal-host")) return false;
  if (document.querySelector(".ql-overlay")) return false;
  if (document.querySelector(".modal-overlay")) return id === "cheatSheet" && !!document.querySelector(".shortcuts-dialog");
  return true;
}

function setupPackShortcuts(): void {
  document.addEventListener("keydown", (e) => {
    const id = shortcutFor(e);
    if (!id || !packShortcutAllowed(e, id)) return;
    e.preventDefault();
    if (SHORTCUTS[id].needsRepo && !state.repoPath) {
      setStatus(`${SHORTCUTS[id].label}: open a repository first.`);
      return;
    }
    // The toolbar is disabled while an operation runs; the keys respect that
    // too, instead of queueing a second push behind the first.
    if (ui.actionsBusy && (id === "push" || id === "pull" || id === "fetch")) return;
    ACTIONS[id]();
  });
}

// The toolbar buttons' tooltips end with their shortcut, so the keys are
// discoverable where the mouse already is.
const BUTTON_HINTS: [string, ShortcutId][] = [
  ["#pull-btn", "pull"],
  ["#push-btn", "push"],
  ["#branch-btn", "branchMenu"],
  ["#stash-btn", "stash"],
  ["#refresh-btn", "fetch"],
  ["#terminal-toggle", "terminal"],
  ["#settings-btn", "settings"],
];

function applyButtonHints(): void {
  for (const [sel, id] of BUTTON_HINTS) {
    const btn = document.querySelector<HTMLElement>(sel);
    if (btn) btn.title = `${btn.title} (${shortcutHint(id)})`;
  }
}

// The global shortcuts: Undo / Redo, Quick Launch, the favorites, tab cycling
// and zoom.
export function setupShortcuts(): void {
  setupPackShortcuts();
  applyButtonHints();
  // Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y = redo. Ignored while
  // typing so the native text-editing undo (commit message, conflict editor)
  // still works.
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    // A dialog or the palette owns the keyboard while it's open.
    if (document.querySelector(".modal-overlay, .ql-overlay")) return;
    e.preventDefault();
    if (key === "y" || e.shiftKey) void redoAction();
    else void undoAction();
  });
  document.addEventListener("keydown", (e) => {
    if (!opensQuickLaunch(e)) return;
    e.preventDefault();
    openQuickLaunch();
  });
  // Cmd/Ctrl+1…9 switch to favorite #1–9 (the order Quick Launch lists them),
  // opening it as a tab if it isn't one. Live while typing, like Cmd+K — a
  // digit with Cmd or Ctrl held types nothing — but not in the terminal, and
  // not while a dialog owns the keyboard.
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || !/^[1-9]$/.test(e.key)) return;
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (t?.isContentEditable || t?.closest("#terminal-host")) return;
    if (document.querySelector(".modal-overlay, .ql-overlay")) return;
    e.preventDefault();
    const n = Number(e.key);
    const path = loadFavoriteRepos()[n - 1];
    if (path) void openRecentRepo(path);
    else setStatus(`No favorite #${n} — star a repository from its tab's menu or Quick Launch.`);
  });
  // Ctrl+Tab / Ctrl+Shift+Tab cycle the repo tabs in tab-bar order — Ctrl on
  // every platform, since the OS keeps Cmd+Tab — plus Cmd+Shift+] / [ on
  // macOS, as in browsers. Not in the terminal (Tab belongs to the shell) or
  // under a dialog.
  document.addEventListener("keydown", (e) => {
    const ctrlTab = e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab";
    const bracket =
      IS_MAC && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && (e.code === "BracketRight" || e.code === "BracketLeft");
    if (!ctrlTab && !bracket) return;
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (t?.closest("#terminal-host")) return;
    if (document.querySelector(".modal-overlay, .ql-overlay")) return;
    e.preventDefault();
    cycleRepoTab((ctrlTab ? !e.shiftKey : e.code === "BracketRight") ? 1 : -1);
  });
  // Cmd/Ctrl + = / − / 0 zoom the whole window in, out, or back to 100%,
  // through the preset levels. Live while typing, like Cmd+K, but not in the
  // terminal, where Ctrl+- is the shell's.
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    // "+" is Shift+= on most layouts; "_" its Shift+−.
    const step = e.key === "=" || e.key === "+" ? 1 : e.key === "-" || e.key === "_" ? -1 : e.key === "0" ? 0 : null;
    if (step === null) return;
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (t?.closest("#terminal-host")) return;
    e.preventDefault();
    const zoom = step === 0 ? 1 : steppedZoom(loadZoom(), step);
    void applyZoom(zoom);
    setStatus(`Zoom ${Math.round(zoom * 100)}%`);
  });
}
