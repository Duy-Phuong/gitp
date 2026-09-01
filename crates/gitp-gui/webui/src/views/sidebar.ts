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
  // Cmd/Shift-click multi-selection, Local Branches only (bulk delete is the
  // only action, and it doesn't apply to remotes/tags/stashes).
  branchSelection: Set<string>;
  // The last plain/Cmd-clicked branch — the Shift-click range anchor.
  branchSelectionAnchor: string | null;
  // Refs with an operation in flight (a branch being fetched, fast-forwarded,
  // pushed, renamed…), keyed by the same name the row shows. Those rows get a
  // spinner in place of their ahead/behind counts and stop accepting clicks, so
  // a slow fetch is visibly in progress where the user started it rather than
  // only in the status bar.
  busyRefs: Set<string>;
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
  // Cmd/Shift-click a branch: update the multi-selection (`anchor` is the
  // clicked branch, for the next Shift-click to range from).
  onBranchMultiSelect: (names: Set<string>, anchor: string) => void;
  // Right-click a branch that's part of a multi-selection: open the bulk menu.
  onBranchBulkMenu: (x: number, y: number) => void;
  // Single-click a stash: show its diff in the detail view.
  onStashClick: (s: StashRef) => void;
  // Right-click a stash: open its actions menu at the cursor.
  onStashMenu: (s: StashRef, x: number, y: number) => void;
  // Right-click a remote branch: open its actions menu (checkout, copy name).
  onRemoteMenu: (name: string, target: string, x: number, y: number) => void;
  // Right-click a tag: open its actions menu at the cursor.
  onTagMenu: (name: string, target: string, x: number, y: number) => void;
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
    spellcheck: "false",
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
  buildTags(tree, s, cb, match, filtering);
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

// `selectable` is only passed for Local Branches leaves (not Recent, not
// Remotes/Tags/Stashes) — `order` is that section's rendered branch names, in
// DOM order, the basis for a Shift-click range.
function branchLeaf(
  b: BranchRef,
  label: string,
  indented: boolean,
  busy: boolean,
  cb: SidebarCallbacks,
  selectable?: { order: string[]; s: SidebarState },
): HTMLElement {
  const multiSelected = selectable?.s.branchSelection.has(b.name) ?? false;
  const row = el("div", {
    class: `sb-leaf${b.is_head ? " head" : ""}${indented ? " indent" : ""}${multiSelected ? " multi-selected" : ""}${busy ? " busy" : ""}`,
    title: selectable
      ? `${b.name}\nClick: jump to tip · Cmd/Shift-click: multi-select · Double-click: checkout · Right-click: actions`
      : `${b.name}\nClick: jump to tip · Double-click: checkout · Right-click: actions`,
  });
  row.append(el("span", { class: "sb-leaf-label", text: label }));
  if (busy) {
    // The spinner takes the ahead/behind slot: those counts are exactly what
    // the running operation is about to change, so showing stale ones beside a
    // spinner would be worse than showing none.
    row.append(spinner());
  } else {
    const ab: string[] = [];
    if (b.behind) ab.push(`${b.behind}↓`);
    if (b.ahead) ab.push(`${b.ahead}↑`);
    if (ab.length) row.append(el("span", { class: "sb-ab", text: ab.join(" ") }));
  }

  // Delay the single-click action so a double-click can pre-empt it.
  let clickTimer: number | undefined;
  row.addEventListener("click", (e) => {
    window.clearTimeout(clickTimer);
    if (selectable) {
      const { order, s } = selectable;
      if (e.shiftKey) {
        const anchorIdx = s.branchSelectionAnchor ? order.indexOf(s.branchSelectionAnchor) : -1;
        const idx = order.indexOf(b.name);
        const [from, to] = anchorIdx < 0 ? [idx, idx] : [Math.min(anchorIdx, idx), Math.max(anchorIdx, idx)];
        cb.onBranchMultiSelect(new Set(order.slice(from, to + 1)), b.name);
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        // The first Cmd-click after a plain click starts from just the
        // anchor, not an empty set — otherwise "click A, Cmd-click B" would
        // select only B instead of both.
        const base = s.branchSelection.size ? s.branchSelection : new Set(s.branchSelectionAnchor ? [s.branchSelectionAnchor] : []);
        const next = new Set(base);
        if (next.has(b.name)) next.delete(b.name);
        else next.add(b.name);
        cb.onBranchMultiSelect(next, b.name);
        return;
      }
      // Plain click always becomes the new anchor; only re-render if that or
      // clearing a selection actually changes anything.
      if (s.branchSelection.size || s.branchSelectionAnchor !== b.name) cb.onBranchMultiSelect(new Set(), b.name);
    }
    clickTimer = window.setTimeout(() => cb.onRefJump(b.target, b.name), 220);
  });
  row.addEventListener("dblclick", () => {
    window.clearTimeout(clickTimer);
    cb.onBranchCheckout(b);
  });
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    window.clearTimeout(clickTimer);
    if (selectable?.s.branchSelection.has(b.name) && selectable.s.branchSelection.size > 1) {
      cb.onBranchBulkMenu(e.clientX, e.clientY);
      return;
    }
    if (selectable?.s.branchSelection.size) cb.onBranchMultiSelect(new Set(), b.name);
    cb.onBranchMenu(b, e.clientX, e.clientY);
  });
  return row;
}

function leaf(label: string, indented: boolean, title = label, busy = false): HTMLElement {
  const row = el("div", { class: `sb-leaf${indented ? " indent" : ""}${busy ? " busy" : ""}`, title }, [
    el("span", { class: "sb-leaf-label", text: label }),
  ]);
  if (busy) row.append(spinner());
  return row;
}

// The in-progress marker for a ref row. Same look as the status bar's spinner.
function spinner(): HTMLElement {
  return el("span", { class: "sb-spinner", "aria-label": "in progress" });
}

// A tag: click jumps to the commit it points at, right-click opens its menu.
// `label` is what the row shows (shortened inside a folder); `full` is the real
// tag name every action needs — git doesn't know about the folder split.
function tagLeaf(
  label: string,
  target: string,
  cb: SidebarCallbacks,
  full: string = label,
): HTMLElement {
  const row = leaf(label, true, `${full}\nClick: jump to commit · Right-click: actions`);
  if (target) row.addEventListener("click", () => cb.onRefJump(target, full));
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    cb.onTagMenu(full, target, e.clientX, e.clientY);
  });
  return row;
}

// A remote branch: click jumps to its tip, right-click opens its actions menu.
function remoteLeaf(
  label: string,
  full: string,
  target: string,
  busy: boolean,
  cb: SidebarCallbacks,
): HTMLElement {
  const row = leaf(label, true, `${full}\nClick: jump to tip · Right-click: actions`, busy);
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
  for (const b of recent) tree.append(branchLeaf(b, b.name, true, s.busyRefs.has(b.name), cb));
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

  // The flat rendered order of visible leaves (folders open, matching the
  // filter) — computed once up front so a Shift-click range matches exactly
  // what's on screen, including collapsed folders and the active filter.
  const order: string[] = [];
  for (const folder of [...folders.keys()].sort()) {
    const shown = folders.get(folder)!.filter((b) => match(b.name));
    if (shown.length === 0) continue;
    const fcollapsed = s.collapsed.has(`br:${folder}`) && !filtering;
    if (!fcollapsed) for (const b of shown) order.push(b.name);
  }
  for (const b of loose) if (match(b.name)) order.push(b.name);
  const selectable = { order, s };

  for (const folder of [...folders.keys()].sort()) {
    const shown = folders.get(folder)!.filter((b) => match(b.name));
    if (shown.length === 0) continue;
    const fkey = `br:${folder}`;
    // While filtering, force folders open so matches are visible.
    const fcollapsed = s.collapsed.has(fkey) && !filtering;
    tree.append(folderRow(fkey, folder, fcollapsed, cb));
    if (!fcollapsed) {
      for (const b of shown) {
        tree.append(branchLeaf(b, splitRef(b.name).label, true, s.busyRefs.has(b.name), cb, selectable));
      }
    }
  }
  for (const b of loose) {
    if (match(b.name)) tree.append(branchLeaf(b, b.name, false, s.busyRefs.has(b.name), cb, selectable));
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
      for (const r of shown) {
        tree.append(remoteLeaf(r.label, r.full, r.target, s.busyRefs.has(r.full), cb));
      }
    }
  }
}

// Tags fold on `/` the same way branches and remotes do, so a repo that names
// them `release/3.33.0` gets one collapsible group instead of hundreds of rows.
// Flat names (`3.33.0`) have no folder and list directly, so nothing changes for
// repos that tag that way. Order comes from the backend — newest release first,
// compared numerically (see natural_cmp in refs.rs) — so it's preserved here
// rather than re-sorted.
function buildTags(
  tree: HTMLElement,
  s: SidebarState,
  cb: SidebarCallbacks,
  match: (t: string) => boolean,
  filtering: boolean,
): void {
  const { row, collapsed } = sectionHeader("sec:tags", "Tags", s, cb);
  tree.append(row);
  if (collapsed) return;

  const folders = new Map<string, { full: string; label: string; target: string }[]>();
  const loose: { full: string; label: string; target: string }[] = [];
  for (const tag of s.refs.tags) {
    if (!match(tag.name)) continue;
    const { folder, label } = splitRef(tag.name);
    const entry = { full: tag.name, label, target: tag.target };
    if (folder) {
      const list = folders.get(folder) ?? [];
      list.push(entry);
      folders.set(folder, list);
    } else {
      loose.push(entry);
    }
  }

  for (const folder of [...folders.keys()].sort()) {
    const fkey = `tg:${folder}`;
    // While filtering, force folders open so matches are visible.
    const fcollapsed = s.collapsed.has(fkey) && !filtering;
    tree.append(folderRow(fkey, folder, fcollapsed, cb));
    if (!fcollapsed) {
      for (const t of folders.get(folder)!) tree.append(tagLeaf(t.label, t.target, cb, t.full));
    }
  }
  // Unfoldered tags after the groups, matching how branches are laid out.
  for (const t of loose) tree.append(tagLeaf(t.label, t.target, cb, t.full));
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
