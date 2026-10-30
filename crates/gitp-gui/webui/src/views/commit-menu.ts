// Right-click context menu for a commit row in the log graph.
//
// A single floating menu is reused: opening it again (or clicking away, pressing
// Escape, or scrolling) tears down the previous one. The menu itself only
// collects intent — a branch/tag name, a reset mode — and hands it to the
// caller's handlers, which own the git call, confirmation, and refresh.

import { autoGrowInput, clear, el } from "../dom";
import type { CommitRow, ResetMode } from "../types";

export interface CommitMenuHandlers {
  // Name of the current branch, for the "Rebase '<branch>' to Here" label.
  currentBranch: string;
  copySha: () => void;
  checkoutCommit: () => void;
  newBranch: (name: string) => void;
  newTag: () => void;
  cherryPick: () => void;
  revert: () => void;
  reset: (mode: ResetMode) => void;
  // Open the interactive-rebase editor with this commit and everything after it.
  rebaseToHere: () => void;
  // One-commit quick actions applied to this commit alone.
  rewordCommit: (message: string) => void;
  editCommit: () => void;
  squashIntoParent: () => void;
  fixupIntoParent: () => void;
  dropCommit: () => void;
  // Whether a bisect is running. If so the bisect items mark this commit;
  // if not they start one, asking for the opposite end first.
  bisecting: boolean;
  bisectMark: (mark: "good" | "bad") => void;
  bisectStart: (mark: "good" | "bad", otherEnd: string) => void;
}

// The one open menu, if any, plus the listeners that dismiss it.
let openMenu: HTMLElement | null = null;
let onDocMouseDown: ((e: MouseEvent) => void) | null = null;
let onKeyDown: ((e: KeyboardEvent) => void) | null = null;
let onScroll: ((e: Event) => void) | null = null;

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
  // A page scroll (e.g. the log pane) moves the row out from under the menu, so
  // close — but ignore scrolls from inside the menu (a long value scrolling
  // within the rename/new-branch input must not dismiss it).
  onScroll = (e: Event) => {
    if (!menu.contains(e.target as Node)) closeCommitMenu();
  };
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
    item("New Tag here…", h.newTag),
    sep(),
    item("Cherry-pick Commit", h.cherryPick),
    item("Revert Commit", h.revert),
    submenuItem("Interactive Rebase ▸", () => buildRebaseSubmenu(menu, row, h)),
    sep(),
    bisectItem(menu, row, h, "bad"),
    bisectItem(menu, row, h, "good"),
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

// "Bisect: Mark as Bad/Good". With no bisect running, the first mark starts
// one, so the menu turns into a prompt for the other end: the bad end defaults
// to HEAD, the good end has to be named.
function bisectItem(menu: HTMLElement, row: CommitRow, h: CommitMenuHandlers, mark: "good" | "bad"): HTMLElement {
  const label = `Bisect: Mark as ${mark === "bad" ? "Bad" : "Good"}`;
  if (h.bisecting) return item(label, () => h.bisectMark(mark));
  return submenuItem(`${label}…`, () =>
    promptName(
      menu,
      row,
      h,
      mark === "bad" ? "Known good commit (SHA, tag or branch)" : "Known bad commit",
      (other) => h.bisectStart(mark, other),
      mark === "bad" ? "" : "HEAD",
      mark === "bad" ? `Bisect from bad ${row.short_id} — good commit:` : `Bisect from good ${row.short_id} — bad commit:`,
    ),
  );
}

// Swap the menu for the interactive-rebase actions: open the full editor "to
// here", or apply a one-commit quick action. "‹ Back" returns to the root.
function buildRebaseSubmenu(menu: HTMLElement, row: CommitRow, h: CommitMenuHandlers): void {
  clear(menu);
  menu.append(
    item(`Interactively Rebase '${h.currentBranch}' to Here…`, h.rebaseToHere),
    el("div", { class: "menu-label", text: "Quick Actions" }),
    submenuItem("Reword Message…", () =>
      promptName(menu, row, h, "New commit message", h.rewordCommit, row.summary),
    ),
    item("Edit (stop for amending)", h.editCommit),
    item("Squash into Parent", h.squashIntoParent),
    item("Fixup into Parent", h.fixupIntoParent),
    item("Drop", h.dropCommit, true),
    sep(),
    submenuItem("‹ Back", () => buildRoot(menu, row, h)),
  );
}

// Swap the whole menu for a single name input with a Create button; Enter
// submits, Escape returns to the root menu. `label`, when given, heads the
// input — for a prefilled value, which hides the placeholder.
function promptName(
  menu: HTMLElement,
  row: CommitRow,
  handlers: CommitMenuHandlers,
  placeholder: string,
  onSubmit: (name: string) => void,
  value = "",
  label?: string,
): void {
  clear(menu);
  if (label) menu.append(el("div", { class: "menu-label", text: label }));
  const input = el("input", { placeholder, value, spellcheck: "false" }) as HTMLInputElement;
  const create = el("button", { class: "btn small", text: "OK" });
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
  autoGrowInput(input);
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}
