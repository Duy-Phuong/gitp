// The keyboard shortcut cheat sheet (Cmd/Ctrl+/): every binding, grouped, in
// the platform's own spelling. Read-only — the bindings aren't editable.
// Reuses the shared `.modal-overlay` / `.modal` shell.

import { el } from "../dom";
import { BUILT_IN, formatKeys, IS_MAC, SHORTCUTS, type ShortcutGroup } from "../shortcuts";

let overlay: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;

export function closeShortcutsDialog(): void {
  overlay?.remove();
  overlay = null;
  if (onKey) document.removeEventListener("keydown", onKey, true);
  onKey = null;
}

export function isShortcutsDialogOpen(): boolean {
  return overlay !== null;
}

const GROUPS: (ShortcutGroup | "Commit log")[] = [
  "Sync",
  "Branches and changes",
  "Repositories",
  "Views",
  "Commit log",
  "App",
];

/// The rows of each group: the pack's bindings first, then the built-in ones.
/// Exported for its test.
export function sheetRows(isMac = IS_MAC): { group: string; rows: { label: string; keys: string }[] }[] {
  return GROUPS.map((group) => ({
    group,
    rows: [
      ...Object.values(SHORTCUTS)
        .filter((s) => s.group === group)
        .map((s) => ({ label: s.label, keys: formatKeys(s.keys, isMac) })),
      ...BUILT_IN.filter((b) => b.group === group).map((b) => ({ label: b.label, keys: isMac ? b.mac : b.other })),
    ],
  })).filter((g) => g.rows.length > 0);
}

export function openShortcutsDialog(): void {
  if (overlay) return closeShortcutsDialog();

  overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal shortcuts-dialog", role: "dialog", "aria-label": "Keyboard shortcuts" });
  overlay.append(modal);
  document.body.append(overlay);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeShortcutsDialog();
  });
  onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeShortcutsDialog();
  };
  document.addEventListener("keydown", onKey, true);

  const columns = el("div", { class: "shortcuts-columns" });
  for (const { group, rows } of sheetRows()) {
    const section = el("section", { class: "shortcuts-group" }, [el("h3", { text: group })]);
    for (const row of rows) {
      section.append(
        el("div", { class: "shortcuts-row" }, [
          el("span", { class: "shortcuts-label", text: row.label }),
          el("kbd", { text: row.keys }),
        ]),
      );
    }
    columns.append(section);
  }

  const close = el("button", { class: "btn", text: "Close" });
  close.addEventListener("click", closeShortcutsDialog);
  modal.append(
    el("div", { class: "modal-title", text: "Keyboard shortcuts" }),
    el("div", {
      class: "modal-sub",
      text: "Shortcuts with a letter are ignored while typing, in the terminal and under a dialog.",
    }),
    columns,
    el("div", { class: "modal-actions" }, [close]),
  );
  requestAnimationFrame(() => close.focus());
}
