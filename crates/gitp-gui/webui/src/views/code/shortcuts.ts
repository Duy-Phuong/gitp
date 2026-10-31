// Keys the Code tab answers to while it is showing. Mod is Cmd on a Mac
// and Ctrl elsewhere. The global pack (shortcuts.ts) lists these on the
// cheat sheet; this module only recognises them.

import { IS_MAC } from "../../shortcuts";

export type CodeAction = "quickOpen" | "findInFiles" | "goToDefinition" | "back" | "forward" | "findUsages" | "callHierarchy" | "closeTab";

export function codeActionFor(e: KeyboardEvent, isMac = IS_MAC): CodeAction | null {
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && e.altKey && !e.shiftKey && key === "ArrowLeft") return "back";
  if (mod && e.altKey && !e.shiftKey && key === "ArrowRight") return "forward";
  if (mod && !e.altKey && !e.shiftKey && key === "p") return "quickOpen";
  if (mod && !e.altKey && e.shiftKey && key === "f") return "findInFiles";
  if (mod && !e.altKey && e.shiftKey && key === "w") return "closeTab";
  if (!mod && !e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey && key === "F12") return "goToDefinition";
  if (e.altKey && !e.metaKey && !e.ctrlKey && key === "F7") return "findUsages";
  if (e.ctrlKey && e.altKey && !e.metaKey && key === "h") return "callHierarchy";
  return null;
}

/// Route the Code tab's keys to `run` while `isCodeTab()`; captured, so an
/// editor or input underneath never sees them.
export function setupCodeShortcuts(isCodeTab: () => boolean, run: (action: CodeAction) => void): void {
  document.addEventListener(
    "keydown",
    (e) => {
      if (!isCodeTab()) return;
      const action = codeActionFor(e);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      run(action);
    },
    { capture: true },
  );
}
