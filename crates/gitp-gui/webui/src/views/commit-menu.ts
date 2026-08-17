// Right-click context menu for a commit row in the log graph.
//
// A single floating menu is reused: opening it again (or clicking away, pressing
// Escape, or scrolling) tears down the previous one. The menu itself only
// collects intent — a branch/tag name, a reset mode — and hands it to the
// caller's handlers, which own the git call, confirmation, and refresh.

import { clear, el } from "../dom";
import type { CommitRow, ResetMode } from "../types";

export interface CommitMenuHandlers {
  copySha: () => void;
  checkoutCommit: () => void;
  newBranch: (name: string) => void;
  newTag: (name: string) => void;
  cherryPick: () => void;
  revert: () => void;
  reset: (mode: ResetMode) => void;
  rebaseOnto: () => void;
}

// The one open menu, if any, plus the listeners that dismiss it.
let openMenu: HTMLElement | null = null;
let onDocMouseDown: ((e: MouseEvent) => void) | null = null;
let onKeyDown: ((e: KeyboardEvent) => void) | null = null;
let onScroll: (() => void) | null = null;

export function closeCommitMenu(): void {
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

export function showCommitMenu(
  x: number,
  y: number,
  row: CommitRow,
  handlers: CommitMenuHandlers,
): void {
  closeCommitMenu();

  const menu = el("div", { class: "menu commit-menu" });
  buildRoot(menu, row, handlers);
  document.body.append(menu);
  openMenu = menu;

  // Position, then nudge back inside the viewport if it would overflow.
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
    if (!menu.contains(e.target as Node)) closeCommitMenu();
  };
  onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeCommitMenu();
  };
  // Any scroll (e.g. the log pane) moves the row out from under the menu.
  onScroll = () => closeCommitMenu();
  document.addEventListener("mousedown", onDocMouseDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("scroll", onScroll, true);
}

// A clickable row that fires its handler and dismisses the menu.
function item(label: string, run: () => void, danger = false): HTMLElement {
  const btn = el("button", { class: `menu-item${danger ? " danger" : ""}`, text: label });
  btn.addEventListener("click", () => {
    closeCommitMenu();
    run();
  });
  return btn;
}

// A clickable row that transforms the menu in place (e.g. into a name input)
// rather than dismissing it, so the menu element stays attached to the DOM.
function submenuItem(label: string, run: () => void): HTMLElement {
  const btn = el("button", { class: "menu-item", text: label });
  btn.addEventListener("click", run);
  return btn;
}

function sep(): HTMLElement {
  return el("div", { class: "menu-sep" });
}

function buildRoot(menu: HTMLElement, row: CommitRow, h: CommitMenuHandlers): void {
  clear(menu);
  menu.append(
    el("div", { class: "menu-label", text: `Commit ${row.short_id}` }),
    item("Checkout Commit", h.checkoutCommit),
    sep(),
    submenuItem("New Branch here…", () => promptName(menu, row, h, "New branch name", h.newBranch)),
    submenuItem("New Tag here…", () => promptName(menu, row, h, "New tag name", h.newTag)),
    sep(),
    item("Cherry-pick Commit", h.cherryPick),
    item("Revert Commit", h.revert),
    item("Rebase current branch onto here", h.rebaseOnto),
    sep(),
    // Reset is destructive, so the three modes stay spelled out inline rather
    // than hidden behind a submenu, and hard-reset is flagged.
    el("div", { class: "menu-label", text: "Reset current branch to here" }),
    item("Soft (keep changes staged)", () => h.reset("Soft")),
    item("Mixed (keep changes unstaged)", () => h.reset("Mixed")),
    item("Hard (discard changes)", () => h.reset("Hard"), true),
    sep(),
    item("Copy Commit SHA", h.copySha),
  );
}

// Swap the whole menu for a single name input with a Create button; Enter
// submits, Escape returns to the root menu.
function promptName(
  menu: HTMLElement,
  row: CommitRow,
  handlers: CommitMenuHandlers,
  placeholder: string,
  onSubmit: (name: string) => void,
): void {
  clear(menu);
  const input = el("input", { placeholder, spellcheck: false }) as HTMLInputElement;
  const create = el("button", { class: "btn small", text: "Create" });
  const submit = () => {
    const name = input.value.trim();
    if (!name) return;
    closeCommitMenu();
    onSubmit(name);
  };
  create.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") submit();
    else if (e.key === "Escape") buildRoot(menu, row, handlers);
  });
  menu.append(el("div", { class: "menu-newbranch" }, [input, create]));
  requestAnimationFrame(() => input.focus());
}
