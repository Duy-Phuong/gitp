// A simple error/message popup: a title, a scrollable detail block (git's own
// output, shown verbatim), and a Close button. Dismisses on Close, Escape, or
// clicking the backdrop. Reuses the shared `.modal-overlay` / `.modal` shell.

import { clear, el } from "../dom";

let overlay: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;

export function closeMessageDialog(): void {
  overlay?.remove();
  overlay = null;
  if (onKey) document.removeEventListener("keydown", onKey, true);
  onKey = null;
}

export interface MessageDialogAction {
  label: string;
  run: () => void;
  // Styled like other destructive actions (e.g. Abort) — red, not the default accent.
  danger?: boolean;
}

// Show an error dialog. `detail` is rendered verbatim (e.g. git's stderr), so
// multi-line messages like "cannot rebase: You have unstaged changes" keep
// their formatting. Optional `actions` add buttons beside Close (e.g.
// "Resolve Conflicts", or "Pull" + "Force Push" together) — each runs and
// then dismisses the dialog. A bare `{label, run}` object is also accepted,
// for the common single-action case.
export function showErrorDialog(
  title: string,
  detail: string,
  action?: MessageDialogAction | MessageDialogAction[],
): void {
  closeMessageDialog();

  overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal message-dialog" });
  overlay.append(modal);
  document.body.append(overlay);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeMessageDialog();
  });
  onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeMessageDialog();
  };
  document.addEventListener("keydown", onKey, true);

  clear(modal);
  modal.append(
    el("div", { class: "modal-title message-dialog-title", text: title }),
    el("pre", { class: "message-dialog-detail", text: detail.trim() || "No further detail." }),
  );

  const close = el("button", { class: "btn", text: "Close" });
  close.addEventListener("click", closeMessageDialog);
  const actionsRow = el("div", { class: "modal-actions" }, [close]);
  for (const a of action ? (Array.isArray(action) ? action : [action]) : []) {
    const btn = el("button", { class: `btn${a.danger ? " danger-btn" : " commit-btn"}`, text: a.label });
    btn.addEventListener("click", () => {
      closeMessageDialog();
      a.run();
    });
    actionsRow.append(btn);
  }
  modal.append(actionsRow);
  requestAnimationFrame(() => close.focus());
}
