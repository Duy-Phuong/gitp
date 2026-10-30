// Keyboard shortcuts: walking the commit log, Undo / Redo, Quick Launch, and
// switching to a favorite repository.

import { $ } from "./dom";
import { state, ui } from "./app-state";
import { leaveComparison, selectCommit } from "./shell";
import { redoAction, undoAction } from "./repo-actions";
import { openQuickLaunch, openRecentRepo } from "./quick-launch-commands";
import { loadFavoriteRepos } from "./prefs";
import { setStatus } from "./report";

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

    let id: string | null = null;
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

// The global shortcuts: Undo / Redo, Quick Launch, and the favorites.
export function setupShortcuts(): void {
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
  // Cmd/Ctrl+K opens Quick Launch. Deliberately live while typing in an input
  // too — the point of a palette is that it's always one keystroke away — but
  // not inside the embedded terminal or the conflict editor, where the key
  // belongs to what's focused.
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
    // `e.target` is only an Element when something focusable has focus; with
    // focus on the document itself there is nothing to defer to.
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (t?.isContentEditable || t?.closest("#terminal-host")) return;
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
}
