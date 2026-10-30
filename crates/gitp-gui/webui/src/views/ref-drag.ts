// Drag a branch onto another — a badge in the log or a row in the sidebar — to
// get a menu of what that can do (see ref-drop.ts), or onto a drop zone that
// isn't a branch (the Worktrees section header) for what that zone does.
//
// Driven by mouse events rather than HTML5 drag-and-drop: the desktop webview
// claims native drag-and-drop for dropping files on the window, and a mouse
// drag also lets the drop target be found with elementFromPoint, which keeps
// working when the sidebar re-renders mid-drag.

import { el } from "../dom";
import type { DragRef } from "../ref-drop";

// Pixels the mouse must travel before a press becomes a drag, so an ordinary
// click (or a slightly shaky one) still clicks.
const DRAG_THRESHOLD = 5;

// The ref behind every element that takes part, read back at drop time.
const refOf = new WeakMap<Element, DragRef>();

// What dropping on each drop zone does.
const zoneOf = new WeakMap<Element, (src: DragRef) => void>();

let onDrop: ((src: DragRef, dst: DragRef, x: number, y: number) => void) | null = null;

// What a drop does: open the drop menu. Set once at startup.
export function setOnRefDrop(handler: (src: DragRef, dst: DragRef, x: number, y: number) => void): void {
  onDrop = handler;
}

// Make `elem` a branch that can be dragged and dropped on.
export function refDragHandle(elem: HTMLElement, ref: DragRef): void {
  refOf.set(elem, ref);
  elem.dataset.dropRef = "";
  elem.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    startPress(elem, ref, e);
  });
}

// Make `elem` a place a branch can be dropped (but not dragged from).
export function refDropZone(elem: HTMLElement, onDropHere: (src: DragRef) => void): void {
  zoneOf.set(elem, onDropHere);
  elem.dataset.dropRef = "";
}

// The branch an event happened on (a badge or sidebar row made a handle
// above, or anything inside one), for the branch hover fade.
export function refUnder(target: EventTarget | null): DragRef | null {
  const hit = target instanceof Element ? target.closest("[data-drop-ref]") : null;
  return (hit && refOf.get(hit)) ?? null;
}

const same = (a: DragRef, b: DragRef) => a.kind === b.kind && a.name === b.name;

// The droppable ref under the pointer, if any.
function dropTargetAt(x: number, y: number): HTMLElement | null {
  const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-ref]");
  return hit && (refOf.has(hit) || zoneOf.has(hit)) ? hit : null;
}

function startPress(source: HTMLElement, ref: DragRef, down: MouseEvent): void {
  let ghost: HTMLElement | null = null;
  let over: HTMLElement | null = null;
  // Esc ends the drag but not the press: the mouseup still has to be caught,
  // or its click would select whatever is under the pointer.
  let cancelled = false;

  const setOver = (next: HTMLElement | null) => {
    if (next === over) return;
    over?.classList.remove("ref-drop-target");
    over = next;
    over?.classList.add("ref-drop-target");
  };

  const onMove = (e: MouseEvent) => {
    if (cancelled) return;
    if (!ghost) {
      if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < DRAG_THRESHOLD) return;
      ghost = el("div", { class: "ref-drag-ghost", text: ref.name });
      document.body.append(ghost);
      document.body.classList.add("ref-dragging");
      source.classList.add("ref-drag-source");
      window.getSelection()?.removeAllRanges();
    }
    e.preventDefault(); // no text selection while dragging
    ghost.style.left = `${e.clientX + 12}px`;
    ghost.style.top = `${e.clientY + 8}px`;
    const target = dropTargetAt(e.clientX, e.clientY);
    const onItself = target !== null && refOf.has(target) && same(refOf.get(target)!, ref);
    setOver(onItself ? null : target);
  };

  // Take the drag off screen.
  const endDrag = () => {
    setOver(null);
    ghost?.remove();
    document.body.classList.remove("ref-dragging");
    source.classList.remove("ref-drag-source");
  };

  const onUp = (e: MouseEvent) => {
    const dragged = ghost !== null;
    const target = cancelled ? null : over;
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    window.removeEventListener("keydown", onKey, true);
    endDrag();
    if (!dragged) return; // a plain click: let it through
    // The click that follows this mouseup would select a row or jump to a
    // branch; the drag already was the gesture.
    const swallow = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    if (!target) return;
    const zone = zoneOf.get(target);
    if (zone) zone(ref);
    else onDrop?.(ref, refOf.get(target)!, e.clientX, e.clientY);
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
