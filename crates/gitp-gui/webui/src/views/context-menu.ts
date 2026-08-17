// A small generic floating context menu (right-click). One menu is open at a
// time; it dismisses on outside-click, Escape, or scroll. Styling reuses the
// `.commit-menu` classes (fixed position, accent hover).

import { el } from "../dom";

export interface MenuItem {
  label: string;
  danger?: boolean;
  run: () => void;
}

let openMenu: HTMLElement | null = null;
let onDocMouseDown: ((e: MouseEvent) => void) | null = null;
let onKeyDown: ((e: KeyboardEvent) => void) | null = null;
let onScroll: (() => void) | null = null;

export function closeContextMenu(): void {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  if (onDocMouseDown) document.removeEventListener("mousedown", onDocMouseDown, true);
  if (onKeyDown) document.removeEventListener("keydown", onKeyDown, true);
  if (onScroll) document.removeEventListener("scroll", onScroll, true);
  onDocMouseDown = null;
  onKeyDown = null;
  onScroll = null;
}

export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  closeContextMenu();

  const menu = el("div", { class: "menu commit-menu" });
  for (const it of items) {
    const btn = el("button", { class: `menu-item${it.danger ? " danger" : ""}`, text: it.label });
    btn.addEventListener("click", () => {
      closeContextMenu();
      it.run();
    });
    menu.append(btn);
  }
  document.body.append(menu);
  openMenu = menu;

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 4)}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`;
  }

  onDocMouseDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) closeContextMenu();
  };
  onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeContextMenu();
  };
  onScroll = () => closeContextMenu();
  document.addEventListener("mousedown", onDocMouseDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("scroll", onScroll, true);
}
