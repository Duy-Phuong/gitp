// Left sidebar: repo header, the Local Changes / All Commits nav, a filter box,
// and a collapsible ref tree (Branches, Remotes, Tags, Stashes).
//
// Rendered as a pure function of state + callbacks; main.ts owns the state
// (filter text, which sections/folders are collapsed) and re-renders on change.

import { chevronIcon, clear, el } from "../dom";
import type { BranchRef, Refs, StashRef } from "../types";

export type SidebarView = "history" | "changes";

export interface SidebarState {
  refs: Refs;
  localChanges: number;
  repoName: string;
  // "config" (or anything not matching a nav row) leaves both nav rows unhighlighted.
  activeView: SidebarView | "config";
  filter: string;
  collapsed: Set<string>;
}

export interface SidebarCallbacks {
  onSelectView: (v: SidebarView) => void;
  onFilter: (text: string) => void;
  onToggle: (key: string) => void;
  // Single-click a branch/remote/tag: jump to its tip commit.
  onRefJump: (target: string, label: string) => void;
  // Double-click a branch: check it out.
  onBranchCheckout: (b: BranchRef) => void;
  // Right-click a branch: open its actions menu at the cursor.
  onBranchMenu: (b: BranchRef, x: number, y: number) => void;
  // Single-click a stash: show its diff in the detail view.
  onStashClick: (s: StashRef) => void;
  // Right-click a stash: open its actions menu at the cursor.
  onStashMenu: (s: StashRef, x: number, y: number) => void;
  // Right-click a remote branch: open its actions menu (checkout, copy name).
  onRemoteMenu: (name: string, target: string, x: number, y: number) => void;
}

export function renderSidebar(host: HTMLElement, s: SidebarState, cb: SidebarCallbacks): void {
  // Re-rendering on each keystroke would drop focus; remember and restore it.
  const filterWasFocused = host.querySelector("#sidebar-filter") === document.activeElement;
  clear(host);

  host.append(
    el("div", { class: "sb-header" }, [
      el("span", { class: "sb-repo", text: s.repoName || "No repository", title: s.repoName }),
    ]),
  );

  host.append(
    navRow("Local Changes", s.localChanges, s.activeView === "changes", () => cb.onSelectView("changes")),
    navRow("All Commits", null, s.activeView === "history", () => cb.onSelectView("history")),
  );

  const filter = el("input", {
    id: "sidebar-filter",
    class: "sb-filter",
    placeholder: "Filter",
    value: s.filter,
    spellcheck: false,
  }) as HTMLInputElement;
  filter.addEventListener("input", () => cb.onFilter(filter.value));
  host.append(el("div", { class: "sb-filter-wrap" }, [filter]));

  const q = s.filter.trim().toLowerCase();
  const match = (text: string) => q === "" || text.toLowerCase().includes(q);
  const filtering = q !== "";

  const tree = el("div", { class: "sb-tree" });
  buildRecent(tree, s, cb, match);
  buildBranches(tree, s, cb, match, filtering);
  buildRemotes(tree, s, cb, match, filtering);
  buildTags(tree, s, cb, match);
  buildStashes(tree, s, cb, match);
  host.append(tree);

  if (filterWasFocused) {
    filter.focus({ preventScroll: true });
    const end = filter.value.length;
    filter.setSelectionRange(end, end);
  }
}

// --- rows -------------------------------------------------------------------

function navRow(
  label: string,
  count: number | null,
  active: boolean,
  onClick: () => void,
): HTMLElement {
  const row = el("div", { class: `sb-nav${active ? " active" : ""}` });
  row.append(el("span", { class: "sb-nav-label", text: label }));
  if (count != null) row.append(el("span", { class: "sb-count", text: `(${count})` }));
  row.addEventListener("click", onClick);
  return row;
}

function sectionHeader(
  key: string,
  title: string,
  s: SidebarState,
  cb: SidebarCallbacks,
): { row: HTMLElement; collapsed: boolean } {
  const collapsed = s.collapsed.has(key);
  const row = el("div", { class: "sb-section" }, [
    chevron(collapsed),
    el("span", { class: "sb-section-title", text: title }),
  ]);
  row.addEventListener("click", () => cb.onToggle(key));
  return { row, collapsed };
}

function folderRow(key: string, label: string, collapsed: boolean, cb: SidebarCallbacks): HTMLElement {
  const row = el("div", { class: "sb-folder" }, [
    chevron(collapsed),
    el("span", { class: "sb-folder-label", text: label }),
  ]);
  row.addEventListener("click", () => cb.onToggle(key));
  return row;
}

function chevron(collapsed: boolean): HTMLElement {
  const span = el("span", { class: `sb-chevron${collapsed ? "" : " open"}` });
  span.append(chevronIcon());
  return span;
}

function branchLeaf(
  b: BranchRef,
  label: string,
  indented: boolean,
  cb: SidebarCallbacks,
): HTMLElement {
  const row = el("div", {
    class: `sb-leaf${b.is_head ? " head" : ""}${indented ? " indent" : ""}`,
    title: `${b.name}\nClick: jump to tip · Double-click: checkout · Right-click: actions`,
  });
  row.append(el("span", { class: "sb-leaf-label", text: label }));
  const ab: string[] = [];
  if (b.behind) ab.push(`${b.behind}↓`);
  if (b.ahead) ab.push(`${b.ahead}↑`);
  if (ab.length) row.append(el("span", { class: "sb-ab", text: ab.join(" ") }));

  // Delay the single-click action so a double-click can pre-empt it.
  let clickTimer: number | undefined;
  row.addEventListener("click", () => {
    window.clearTimeout(clickTimer);
    clickTimer = window.setTimeout(() => cb.onRefJump(b.target, b.name), 220);
  });
  row.addEventListener("dblclick", () => {
    window.clearTimeout(clickTimer);
    cb.onBranchCheckout(b);
  });
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    window.clearTimeout(clickTimer);
    cb.onBranchMenu(b, e.clientX, e.clientY);
  });
  return row;
}

function leaf(label: string, indented: boolean, title = label): HTMLElement {
  return el("div", { class: `sb-leaf${indented ? " indent" : ""}`, title }, [
    el("span", { class: "sb-leaf-label", text: label }),
  ]);
}

// A leaf that jumps to a commit on click (used for remotes and tags).
function jumpLeaf(
  label: string,
  title: string,
  target: string,
  cb: SidebarCallbacks,
): HTMLElement {
  const row = leaf(label, true, title);
  if (target) row.addEventListener("click", () => cb.onRefJump(target, title));
  return row;
}

// A remote branch: click jumps to its tip, right-click opens its actions menu.
function remoteLeaf(
  label: string,
  full: string,
  target: string,
  cb: SidebarCallbacks,
): HTMLElement {
  const row = leaf(label, true, `${full}\nClick: jump to tip · Right-click: actions`);
  if (target) row.addEventListener("click", () => cb.onRefJump(target, full));
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    cb.onRemoteMenu(full, target, e.clientX, e.clientY);
  });
  return row;
}

// --- sections ---------------------------------------------------------------

function splitRef(name: string): { folder: string | null; label: string } {
  const i = name.indexOf("/");
  return i === -1 ? { folder: null, label: name } : { folder: name.slice(0, i), label: name.slice(i + 1) };
}

// Recently switched-to branches (from the backend's HEAD-reflog order), shown
// above Branches for quick switching. Each is a normal branch leaf, so click /
// double-click / right-click behave exactly like in Branches. Hidden when empty
// or while filtering (the filter targets the full ref tree, not this shortcut).
function buildRecent(
  tree: HTMLElement,
  s: SidebarState,
  cb: SidebarCallbacks,
  match: (t: string) => boolean,
): void {
  const byName = new Map(s.refs.branches.map((b) => [b.name, b]));
  const recent = s.refs.recent
    .map((name) => byName.get(name))
    .filter((b): b is BranchRef => b != null && match(b.name));
  if (recent.length === 0) return;

  const { row, collapsed } = sectionHeader("sec:recent", "Recent", s, cb);
  tree.append(row);
  if (collapsed) return;
  for (const b of recent) tree.append(branchLeaf(b, b.name, true, cb));
}

function buildBranches(
  tree: HTMLElement,
  s: SidebarState,
  cb: SidebarCallbacks,
  match: (t: string) => boolean,
  filtering: boolean,
): void {
  const { row, collapsed } = sectionHeader("sec:branches", "Branches", s, cb);
  tree.append(row);
  if (collapsed) return;

  const folders = new Map<string, BranchRef[]>();
  const loose: BranchRef[] = [];
  for (const b of s.refs.branches) {
    const { folder } = splitRef(b.name);
    if (folder) {
      const list = folders.get(folder) ?? [];
      list.push(b);
      folders.set(folder, list);
    } else {
      loose.push(b);
    }
  }

  for (const folder of [...folders.keys()].sort()) {
    const shown = folders.get(folder)!.filter((b) => match(b.name));
    if (shown.length === 0) continue;
    const fkey = `br:${folder}`;
    // While filtering, force folders open so matches are visible.
    const fcollapsed = s.collapsed.has(fkey) && !filtering;
    tree.append(folderRow(fkey, folder, fcollapsed, cb));
    if (!fcollapsed) {
      for (const b of shown) tree.append(branchLeaf(b, splitRef(b.name).label, true, cb));
    }
  }
  for (const b of loose) {
    if (match(b.name)) tree.append(branchLeaf(b, b.name, false, cb));
  }
}

function buildRemotes(
  tree: HTMLElement,
  s: SidebarState,
  cb: SidebarCallbacks,
  match: (t: string) => boolean,
  filtering: boolean,
): void {
  const { row, collapsed } = sectionHeader("sec:remotes", "Remotes", s, cb);
  tree.append(row);
  if (collapsed) return;

  const remotes = new Map<string, { full: string; label: string; target: string }[]>();
  for (const r of s.refs.remotes) {
    const label = r.name.startsWith(`${r.remote}/`) ? r.name.slice(r.remote.length + 1) : r.name;
    const list = remotes.get(r.remote) ?? [];
    list.push({ full: r.name, label, target: r.target });
    remotes.set(r.remote, list);
  }

  for (const remote of [...remotes.keys()].sort()) {
    const shown = remotes.get(remote)!.filter((r) => match(r.full));
    if (shown.length === 0) continue;
    const rkey = `rm:${remote}`;
    const rcollapsed = s.collapsed.has(rkey) && !filtering;
    tree.append(folderRow(rkey, remote, rcollapsed, cb));
    if (!rcollapsed) {
      for (const r of shown) tree.append(remoteLeaf(r.label, r.full, r.target, cb));
    }
  }
}

function buildTags(
  tree: HTMLElement,
  s: SidebarState,
  cb: SidebarCallbacks,
  match: (t: string) => boolean,
): void {
  const { row, collapsed } = sectionHeader("sec:tags", "Tags", s, cb);
  tree.append(row);
  if (collapsed) return;
  for (const tag of s.refs.tags) {
    if (match(tag.name)) tree.append(jumpLeaf(tag.name, tag.name, tag.target, cb));
  }
}

function buildStashes(
  tree: HTMLElement,
  s: SidebarState,
  cb: SidebarCallbacks,
  match: (t: string) => boolean,
): void {
  const { row, collapsed } = sectionHeader("sec:stashes", "Stashes", s, cb);
  tree.append(row);
  if (collapsed) return;
  for (const stash of s.refs.stashes) {
    if (match(stash.message)) tree.append(stashLeaf(stash, cb));
  }
}

// A stash entry: click shows its diff, right-click opens the actions menu.
function stashLeaf(stash: StashRef, cb: SidebarCallbacks): HTMLElement {
  const row = leaf(stash.message, true, `stash@{${stash.index}}\nClick: show changes · Right-click: actions`);
  row.addEventListener("click", () => cb.onStashClick(stash));
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    cb.onStashMenu(stash, e.clientX, e.clientY);
  });
  return row;
}
