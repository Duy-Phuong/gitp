// A small generic floating context menu (right-click). One menu is open at a
// time; it dismisses on outside-click, Escape, or scroll. Styling reuses the
// `.commit-menu` classes (fixed position, accent hover).
//
// Items are plain actions (`run`), separators, or name prompts: clicking a
// prompt item swaps the menu in place for a text input + Create button, so
// "New Branch…", "New Tag…", and "Rename…" collect a value without a dialog.

import { autoGrowInput, el } from "../dom";

export interface MenuItem {
  label?: string;
  danger?: boolean;
  separator?: boolean;
  run?: () => void;
  prompt?: { placeholder: string; value?: string; onSubmit: (value: string) => void };
}

let openMenu: HTMLElement | null = null;
let onDocMouseDown: ((e: MouseEvent) => void) | null = null;
let onKeyDown: ((e: KeyboardEvent) => void) | null = null;
let onScroll: ((e: Event) => void) | null = null;

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
  renderItems(menu, items);
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
  // Close when the page scrolls the anchor away, but NOT when the scroll comes
  // from inside the menu itself (e.g. a long value scrolling within an input).
  onScroll = (e: Event) => {
    if (!menu.contains(e.target as Node)) closeContextMenu();
  };
  document.addEventListener("mousedown", onDocMouseDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("scroll", onScroll, true);
}

function renderItems(menu: HTMLElement, items: MenuItem[]): void {
  menu.replaceChildren();
  for (const it of items) {
    if (it.separator) {
      menu.append(el("div", { class: "menu-sep" }));
      continue;
    }
    const btn = el("button", {
      class: `menu-item${it.danger ? " danger" : ""}`,
      text: it.label ?? "",
    });
    btn.addEventListener("click", () => {
      if (it.prompt) {
        renderPrompt(menu, items, it.prompt);
      } else {
        closeContextMenu();
        it.run?.();
      }
    });
    menu.append(btn);
  }
}

// Swap the menu for a single labelled input; Enter/Create submits, Escape
// returns to the item list.
function renderPrompt(
  menu: HTMLElement,
  items: MenuItem[],
  prompt: NonNullable<MenuItem["prompt"]>,
): void {
  menu.replaceChildren();
  const input = el("input", {
    placeholder: prompt.placeholder,
    value: prompt.value ?? "",
    spellcheck: "false",
  }) as HTMLInputElement;
  const create = el("button", { class: "btn small", text: "OK" });
  const submit = () => {
    const value = input.value.trim();
    if (!value) return;
    closeContextMenu();
    prompt.onSubmit(value);
  };
  create.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") submit();
    else if (e.key === "Escape") renderItems(menu, items);
  });
  menu.append(el("div", { class: "menu-newbranch" }, [input, create]));
  autoGrowInput(input);
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}
