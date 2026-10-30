// Drag a repo tab sideways to reorder the tab bar.
//
// Driven by mouse events rather than HTML5 drag-and-drop, like ref-drag.ts and
// for the same reason: the desktop webview claims native drag-and-drop for
// dropping files on the window.

import { droppedTabIndex } from "../tab-order";

// Pixels the mouse must travel before a press becomes a drag, so an ordinary
// click still switches tabs.
const DRAG_THRESHOLD = 5;

// Make `tab`, one of the tab bar's children, draggable. `onMove` gets the index
// it was dropped at (see droppedTabIndex), only when that is a new place.
export function tabDragHandle(tab: HTMLElement, onMove: (to: number) => void): void {
  tab.addEventListener("mousedown", (down) => {
    if (down.button !== 0 || (down.target as Element).closest(".repo-tab-close")) return;
    startPress(tab, down, onMove);
  });
}

function startPress(tab: HTMLElement, down: MouseEvent, onMove: (to: number) => void): void {
  const tabs = [...(tab.parentElement?.children ?? [])] as HTMLElement[];
  const from = tabs.indexOf(tab);
  let dragging = false;
  let cancelled = false;
  // The tab the pointer is over, and on which side of it the drop goes.
  let drop: { target: HTMLElement; after: boolean } | null = null;

  const setDrop = (next: typeof drop) => {
    drop?.target.classList.remove("drop-before", "drop-after");
    drop = next;
    next?.target.classList.add(next.after ? "drop-after" : "drop-before");
  };

  const onMouseMove = (e: MouseEvent) => {
    if (cancelled) return;
    if (!dragging) {
      if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < DRAG_THRESHOLD) return;
      dragging = true;
      tab.classList.add("repo-tab-dragging");
      document.body.classList.add("tab-dragging");
    }
    e.preventDefault(); // no text selection while dragging
    // Only the x matters: the tabs are one row, and a drag that wanders off
    // it vertically should still land where it points.
    const target = tabs.find((t) => e.clientX < t.getBoundingClientRect().right) ?? tabs[tabs.length - 1];
    const r = target.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    setDrop(target === tab ? null : { target, after });
  };

  const endDrag = () => {
    setDrop(null);
    tab.classList.remove("repo-tab-dragging");
    document.body.classList.remove("tab-dragging");
  };

  const onUp = () => {
    const target = cancelled ? null : drop;
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", onUp, true);
    window.removeEventListener("keydown", onKey, true);
    endDrag();
    if (!dragging) return; // a plain click: let it through
    // The click that follows this mouseup would switch to the tab; the drag
    // already was the gesture.
    const swallow = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    if (!target) return;
    const to = droppedTabIndex(from, tabs.indexOf(target.target), target.after);
    if (to !== from) onMove(to);
  };

  // Esc puts the tab back.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !dragging || cancelled) return;
    e.stopPropagation();
    cancelled = true;
    endDrag();
  };

  window.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("mouseup", onUp, true);
  window.addEventListener("keydown", onKey, true);
}
