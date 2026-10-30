// A small generic floating context menu (right-click). One menu is open at a
// time; it dismisses on outside-click, Escape, or scroll. Styling reuses the
// `.commit-menu` classes (fixed position, accent hover).
//
// Items are plain actions (`run`), separators, or name prompts: clicking a
// prompt item swaps the menu in place for a text input + Create button, so
// "New Branch…", "New Tag…", and "Rename…" collect a value without a dialog.
// A `submenu` item swaps the menu in place for its own items plus "‹ Back",
// the way the commit menu's "Interactive Rebase ▸" does.

import { autoGrowInput, el } from "../dom";

export interface MenuItem {
  label?: string;
  danger?: boolean;
  separator?: boolean;
  /// A small non-clickable section title.
  heading?: string;
  run?: () => void;
  prompt?: { placeholder: string; value?: string; onSubmit: (value: string) => void };
  submenu?: MenuItem[];
}

let openMenu: HTMLElement | null = null;
// Where the open menu was asked to appear — each re-render (a submenu, a
// prompt, Back) is placed from here again, so it fits the window as it is now.
let anchor = { x: 0, y: 0 };
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
  anchor = { x, y };
  document.body.append(menu);
  openMenu = menu;
  renderItems(menu, items);

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

// Open straight into a name prompt, for a button whose only job is to ask for
// one (the detached-HEAD banner's "Create Branch Here…").
export function showPrompt(x: number, y: number, prompt: NonNullable<MenuItem["prompt"]>): void {
  const items: MenuItem[] = [{ label: prompt.placeholder, prompt }];
  showContextMenu(x, y, items);
  if (openMenu) renderPrompt(openMenu, items, prompt);
}

// Where a `width` × `height` menu asked for at (x, y) goes: there, or pulled
// back from the right / bottom edge of a `vw` × `vh` window, never past its
// top-left margin.
export function clampMenu(
  x: number,
  y: number,
  width: number,
  height: number,
  vw: number,
  vh: number,
): { left: number; top: number } {
  return {
    left: x + width > vw ? Math.max(4, vw - width - 4) : x,
    top: y + height > vh ? Math.max(4, vh - height - 4) : y,
  };
}

// Place the menu at its anchor, kept inside the window. Run after every
// re-render: a submenu or prompt can be taller or wider than what it replaced.
function fitMenu(menu: HTMLElement): void {
  // Measured at the anchor, so it's sized for the room it has there.
  menu.style.left = `${anchor.x}px`;
  menu.style.top = `${anchor.y}px`;
  const { width, height } = menu.getBoundingClientRect();
  const { left, top } = clampMenu(anchor.x, anchor.y, width, height, window.innerWidth, window.innerHeight);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

// `parent`: the items to go back to, when these are a submenu's.
function renderItems(menu: HTMLElement, items: MenuItem[], parent?: MenuItem[]): void {
  menu.replaceChildren();
  for (const it of items) {
    if (it.separator) {
      menu.append(el("div", { class: "menu-sep" }));
      continue;
    }
    if (it.heading) {
      menu.append(el("div", { class: "menu-label", text: it.heading }));
      continue;
    }
    const btn = el("button", {
      class: `menu-item${it.danger ? " danger" : ""}`,
      text: it.submenu ? `${it.label ?? ""} ▸` : (it.label ?? ""),
    });
    btn.addEventListener("click", () => {
      if (it.submenu) {
        renderItems(menu, it.submenu, items);
      } else if (it.prompt) {
        renderPrompt(menu, items, it.prompt, parent);
      } else {
        closeContextMenu();
        it.run?.();
      }
    });
    menu.append(btn);
  }
  if (parent) {
    const back = el("button", { class: "menu-item", text: "‹ Back" });
    back.addEventListener("click", () => renderItems(menu, parent));
    menu.append(el("div", { class: "menu-sep" }), back);
  }
  fitMenu(menu);
}

// Swap the menu for a single labelled input; Enter/Create submits, Escape
// returns to the item list (and its `parent`, when it's a submenu's).
function renderPrompt(
  menu: HTMLElement,
  items: MenuItem[],
  prompt: NonNullable<MenuItem["prompt"]>,
  parent?: MenuItem[],
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
    else if (e.key === "Escape") renderItems(menu, items, parent);
  });
  menu.append(el("div", { class: "menu-newbranch" }, [input, create]));
  autoGrowInput(input);
  fitMenu(menu);
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}
