// Drag a file row (Local Changes) onto the terminal to type its path there.
//
// Driven by mouse events rather than HTML5 drag-and-drop: the desktop webview
// claims native drag-and-drop for dropping files on the window, so HTML5 drop
// events never fire in it.

import { el } from "../dom";

// Pixels the mouse must travel before a press becomes a drag, so an ordinary
// click (or a slightly shaky one) still clicks.
const DRAG_THRESHOLD = 5;

// Elements that take a dropped path carry this attribute.
const DROP_ATTR = "data-path-drop";

let onDrop: ((path: string) => void) | null = null;

// What a drop does: type the path into the terminal. Set once at startup.
export function setOnPathDrop(handler: (path: string) => void): void {
  onDrop = handler;
}

// Mark `elem` as a place paths can be dropped on.
export function pathDropTarget(elem: HTMLElement): void {
  elem.setAttribute(DROP_ATTR, "");
}

// Let `row` be dragged as `path` (repo-relative).
export function pathDragHandle(row: HTMLElement, path: string): void {
  row.addEventListener("mousedown", (e) => {
    if (e.button === 0) startPress(row, path, e);
  });
}

function dropTargetAt(x: number, y: number): HTMLElement | null {
  return document.elementFromPoint(x, y)?.closest<HTMLElement>(`[${DROP_ATTR}]`) ?? null;
}

// Somewhere on screen to drop on — otherwise a drag would only float a label
// around.
function anyDropTarget(): boolean {
  return [...document.querySelectorAll<HTMLElement>(`[${DROP_ATTR}]`)].some((t) => t.offsetParent !== null);
}

function startPress(source: HTMLElement, path: string, down: MouseEvent): void {
  if (!anyDropTarget()) return;
  let ghost: HTMLElement | null = null;
  let over: HTMLElement | null = null;
  // Esc ends the drag but not the press: the mouseup still has to be caught,
  // or its click would select whatever is under the pointer.
  let cancelled = false;

  const setOver = (next: HTMLElement | null) => {
    if (next === over) return;
    over?.classList.remove("path-drop-over");
    over = next;
    over?.classList.add("path-drop-over");
  };

  const onMove = (e: MouseEvent) => {
    if (cancelled) return;
    if (!ghost) {
      if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < DRAG_THRESHOLD) return;
      ghost = el("div", { class: "path-drag-ghost", text: path });
      document.body.append(ghost);
      document.body.classList.add("path-dragging");
      source.classList.add("path-drag-source");
      window.getSelection()?.removeAllRanges();
    }
    e.preventDefault(); // no text selection while dragging
    ghost.style.left = `${e.clientX + 12}px`;
    ghost.style.top = `${e.clientY + 8}px`;
    setOver(dropTargetAt(e.clientX, e.clientY));
  };

  // Take the drag off screen.
  const endDrag = () => {
    setOver(null);
    ghost?.remove();
    document.body.classList.remove("path-dragging");
    source.classList.remove("path-drag-source");
  };

  const onUp = () => {
    const dragged = ghost !== null;
    const target = cancelled ? null : over;
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    window.removeEventListener("keydown", onKey, true);
    endDrag();
    if (!dragged) return; // a plain click: let it through
    // The click that follows this mouseup would select the row under the
    // pointer; the drag already was the gesture.
    const swallow = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    if (target) onDrop?.(path);
  };

  // Esc drops nothing.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !ghost || cancelled) return;
    e.stopPropagation();
    cancelled = true;
    endDrag();
  };

  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mouseup", onUp, true);
  window.addEventListener("keydown", onKey, true);
}
