// The action bar's buttons: which are enabled, which one is spinning, and the
// ahead/behind badges on Push and Pull.

import { $ } from "./dom";
import { state, ui } from "./app-state";

// --- Action bar (Pull / Push / Branch) -------------------------------------

// Selector of the toolbar button whose action is in flight, so it can spin.
let busyActionBtn: string | null = null;

// Enable/disable the toolbar buttons based on the in-flight state and what the
// active repo supports: nothing to stash → Stash off; empty stack → Pop off.
export function refreshActionButtons(): void {
  const blocked = ui.actionsBusy || !state.repoPath;
  // Undo/Redo: enabled only when the backend has a matching action, and labelled
  // with it ("Undo Commit"), GitKraken-style.
  const undoBtn = $<HTMLButtonElement>("#undo-btn");
  const redoBtn = $<HTMLButtonElement>("#redo-btn");
  undoBtn.disabled = blocked || !ui.undoLabels.undo;
  redoBtn.disabled = blocked || !ui.undoLabels.redo;
  undoBtn.title = ui.undoLabels.undo ? `Undo ${ui.undoLabels.undo}` : "Nothing to undo";
  redoBtn.title = ui.undoLabels.redo ? `Redo ${ui.undoLabels.redo}` : "Nothing to redo";
  $<HTMLButtonElement>("#pull-btn").disabled = blocked;
  $<HTMLButtonElement>("#pull-caret-btn").disabled = blocked;
  $<HTMLButtonElement>("#push-btn").disabled = blocked;
  $<HTMLButtonElement>("#branch-btn").disabled = blocked;
  $<HTMLButtonElement>("#stash-btn").disabled = blocked || state.localChanges === 0;
  $<HTMLButtonElement>("#pop-btn").disabled = blocked || state.refs.stashes.length === 0;
  $<HTMLButtonElement>("#refresh-btn").disabled = blocked;

  // Spin the button whose action is running.
  for (const sel of ["#undo-btn", "#redo-btn", "#pull-btn", "#push-btn", "#stash-btn", "#pop-btn", "#refresh-btn"]) {
    $(sel).classList.toggle("busy", busyActionBtn === sel);
  }

  // Badge the current branch's sync state vs its upstream. A branch with no
  // upstream (never pushed) shows a dot on Push instead of a count; otherwise
  // Push shows commits ahead (unpushed) and Pull shows commits behind.
  const head = state.refs.branches.find((b) => b.is_head);
  if (head && !head.has_upstream) {
    setActionDot("#push-badge", "Branch has no upstream — not pushed yet");
  } else {
    setActionBadge("#push-badge", head?.ahead ?? 0, "commit(s) to push");
  }
  setActionBadge("#pull-badge", head?.behind ?? 0, "commit(s) to pull");
}

// Show `count` on a toolbar badge (hidden when zero), with a descriptive title.
function setActionBadge(sel: string, count: number, noun: string): void {
  const badge = $(sel);
  badge.classList.remove("dot");
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.title = `${count} ${noun}`;
  badge.classList.toggle("hidden", count === 0);
}

// Show a small dot (no number) on a toolbar badge — "there's something here,
// but no count to give", e.g. an un-pushed branch with no upstream.
function setActionDot(sel: string, title: string): void {
  const badge = $(sel);
  badge.textContent = "";
  badge.title = title;
  badge.classList.add("dot");
  badge.classList.remove("hidden");
}

// Disable every toolbar button while a git operation is in flight. `activeSel`
// is the button that launched it — it shows a spinner over its icon so the
// feedback is right where the user clicked.
export function setActionsBusy(busy: boolean, activeSel?: string): void {
  ui.actionsBusy = busy;
  busyActionBtn = busy ? (activeSel ?? null) : null;
  refreshActionButtons();
}
