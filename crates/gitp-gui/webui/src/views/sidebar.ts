// Left sidebar: repo header, the Local Changes / All Commits / Reflog / Activity nav, a filter box,
// and a collapsible ref tree (Branches, Remotes, Pull Requests, Tags, Stashes).
//
// Rendered as a pure function of state + callbacks; main.ts owns the state
// (filter text, which sections/folders are collapsed) and re-renders on change.

import { chevronIcon, clear, el, githubIcon, svg } from "../dom";
import { PR_FILTERS, prMatches, prNumberQuery, reviewDecisionLabel } from "../pull-requests";
import { branchRefName, refShown, remoteRefName, tagRefName, type RefFilter } from "../ref-visibility";
import { refDragHandle, refDropZone } from "./ref-drag";
import type { DragRef } from "../ref-drop";
import type {
  BranchRef,
  GhAccount,
  PrFilter,
  PullRequest,
  Refs,
  RemoteInfo,
  StashRef,
  Submodule,
  Worktree,
  WorktreeSummary,
} from "../types";

export type SidebarView = "history" | "changes" | "reflog" | "activity" | "localhistory";

export interface SidebarState {
  refs: Refs;
  localChanges: number;
  repoName: string;
  // "config" (or anything not matching a nav row) leaves both nav rows unhighlighted.
  activeView: SidebarView | "config" | "pr";
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
  // The repo's worktrees, main first. The section always shows, so a branch
  // can be dragged onto it to add one.
  worktrees: Worktree[];
  // Each worktree's changed-file count and ahead/behind, by path; arrives
  // after the rest of the sidebar (empty until then, and with one worktree).
  worktreeSummaries: WorktreeSummary[];
  // The repo's submodules. The section always shows, for its "+" (Add).
  submodules: Submodule[];
  // The configured remotes, listed in Remotes even before any branch of
  // theirs has been fetched.
  remoteList: RemoteInfo[];
  // The branch pinned to the left of the graph, badged in the list.
  pinned: string | null;
  // The refs hidden from or soloed in the graph: their rows are dimmed.
  visibility: RefFilter;
  prs: PrSectionState;
}

// The Pull Requests section, loaded through the user's `gh` (see
// pr-actions.ts). Shown only for a repository with a GitHub remote.
export interface PrSectionState {
  // The repo it was loaded for; a tab switch loads it again.
  repoPath: string;
  // The repo's GitHub repository ("owner/name"); null hides the section.
  repo: string | null;
  // gh's account; null until known. App-wide: gh has one login per machine.
  account: GhAccount | null;
  filter: PrFilter;
  // null until the first list arrives.
  list: PullRequest[] | null;
  loading: boolean;
  error: string | null;
  // The pull request the PR view shows: its row is highlighted.
  open: number | null;
  // The section's own search: it narrows the pull requests, nothing else.
  query: string;
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
  // The "+" on the Remotes header: add a remote.
  onAddRemote: () => void;
  // Right-click a remote's folder row: edit, rename, remove, fetch it.
  onRemoteFolderMenu: (remote: string, x: number, y: number) => void;
  // Right-click a tag: open its actions menu at the cursor.
  onTagMenu: (name: string, target: string, x: number, y: number) => void;
  // Double-click a worktree: open it as a repo tab.
  onWorktreeOpen: (w: Worktree) => void;
  // Right-click a worktree: open its actions menu at the cursor.
  onWorktreeMenu: (w: Worktree, x: number, y: number) => void;
  // A branch dropped on the Worktrees header: add a worktree for it.
  onWorktreeDrop: (src: DragRef) => void;
  // Double-click a submodule: open it as a repo tab.
  onSubmoduleOpen: (sm: Submodule) => void;
  // Right-click a submodule: open its actions menu at the cursor.
  onSubmoduleMenu: (sm: Submodule, x: number, y: number) => void;
  // The eye on a branch, remote or tag row: hide it from the graph, or show it
  // again (`refname` in full, e.g. refs/heads/dev).
  onToggleHidden: (refname: string) => void;
  // Right-click the Branches, Remotes or Tags header: Hide All / Show All.
  onSectionMenu: (key: string, x: number, y: number) => void;
  // The Submodules header's "+": add one.
  onAddSubmodule: () => void;
  // Click a pull request: open it in the pull request view.
  onPrOpen: (pr: PullRequest) => void;
  // Right-click a pull request: check out, open on GitHub, copy.
  onPrMenu: (pr: PullRequest, x: number, y: number) => void;
  onPrFilter: (filter: PrFilter) => void;
  // Typing in the Pull Requests search box.
  onPrSearch: (text: string) => void;
  // "Open #N" for a number the list doesn't have (closed, merged, or beyond it).
  onPrOpenNumber: (n: number) => void;
  // The Pull Requests header's refresh: the account and the list again.
  onPrRefresh: () => void;
  onGitHubSignIn: () => void;
}

export function renderSidebar(host: HTMLElement, s: SidebarState, cb: SidebarCallbacks): void {
  // Re-rendering on each keystroke would drop focus; remember and restore it
  // (the sidebar's filter, or the Pull Requests search).
  const focused = [...host.querySelectorAll<HTMLInputElement>("#sidebar-filter, .sb-pr-search")].find((i) => i === document.activeElement);
  const refocus = focused ? (focused.id ? `#${focused.id}` : ".sb-pr-search") : null;
  // The list is drawn anew, so it would start at the top: a click that only
  // changes a highlight (opening a pull request, selecting a branch) or folds
  // a section would scroll it away from where the user is.
  const scrolled = host.querySelector<HTMLElement>(".sb-tree")?.scrollTop ?? 0;
  clear(host);

  host.append(
    el("div", { class: "sb-header" }, [
      el("span", { class: "sb-repo", text: s.repoName || "No repository", title: s.repoName }),
    ]),
  );

  host.append(
    navRow("Local Changes", s.localChanges, s.activeView === "changes", () => cb.onSelectView("changes")),
    navRow("All Commits", null, s.activeView === "history", () => cb.onSelectView("history")),
    navRow("Reflog", null, s.activeView === "reflog", () => cb.onSelectView("reflog")),
    navRow("Activity", null, s.activeView === "activity", () => cb.onSelectView("activity")),
    navRow("Local History", null, s.activeView === "localhistory", () => cb.onSelectView("localhistory")),
  );

  const filter = el("input", {
    id: "sidebar-filter",
    class: "sb-filter",
    placeholder: "Filter",
    value: s.filter,
    spellcheck: "false",
  });
  filter.addEventListener("input", () => cb.onFilter(filter.value));
  host.append(el("div", { class: "sb-filter-wrap" }, [filter]));

  const q = s.filter.trim().toLowerCase();
  const match = (text: string) => q === "" || text.toLowerCase().includes(q);
  const filtering = q !== "";

  const tree = el("div", { class: "sb-tree" });
  buildRecent(tree, s, cb, match);
  buildBranches(tree, s, cb, match, filtering);
  buildRemotes(tree, s, cb, match, filtering);
  buildPullRequests(tree, s, cb, match);
  buildTags(tree, s, cb, match, filtering);
  buildStashes(tree, s, cb, match);
  buildWorktrees(tree, s, cb, match);
  buildSubmodules(tree, s, cb, match);
  host.append(tree);
  tree.scrollTop = scrolled;

  const input = refocus ? host.querySelector<HTMLInputElement>(refocus) : null;
  if (input) {
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
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
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    cb.onSectionMenu(key, e.clientX, e.clientY);
  });
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
  pinned: boolean,
  cb: SidebarCallbacks,
  selectable?: { order: string[]; s: SidebarState },
): HTMLElement {
  const multiSelected = selectable?.s.branchSelection.has(b.name) ?? false;
  const row = el("div", {
    class: `sb-leaf${b.is_head ? " head" : ""}${indented ? " indent" : ""}${multiSelected ? " multi-selected" : ""}${busy ? " busy" : ""}`,
    title: selectable
      ? `${b.name}\nClick: jump to tip · Cmd/Shift-click: multi-select · Double-click: checkout · Drag onto a branch: actions · Right-click: actions`
      : `${b.name}\nClick: jump to tip · Double-click: checkout · Drag onto a branch: actions · Right-click: actions`,
  });
  row.append(el("span", { class: "sb-leaf-label", text: label }));
  if (pinned) row.append(el("span", { class: "sb-badge", text: "pinned", title: "Pinned to the left of the graph" }));
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
  refDragHandle(row, { kind: "local", name: b.name });
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

// Hide / Solo on a ref row: dimmed when the graph leaves it out, a "solo" badge
// when soloed, and an eye on hover that hides it or shows it again. The
// checked-out branch gets no eye: HEAD is always in the graph.
function withVisibility(row: HTMLElement, refname: string, s: SidebarState, cb: SidebarCallbacks, isHead = false): HTMLElement {
  if (!refShown(s.visibility, refname, isHead)) row.classList.add("sb-hidden");
  if (s.visibility.solo.has(refname)) row.append(el("span", { class: "sb-badge", text: "solo" }));
  if (isHead) return row;
  const hidden = s.visibility.hidden.has(refname);
  const eye = el("span", { class: `sb-eye${hidden ? " off" : ""}`, title: hidden ? "Show in the graph" : "Hide from the graph" });
  eye.append(eyeIcon(hidden));
  eye.addEventListener("click", (e) => {
    e.stopPropagation();
    cb.onToggleHidden(refname);
  });
  // Not the row's own gestures: a jump, a checkout, or the start of a drag.
  for (const type of ["dblclick", "mousedown"]) eye.addEventListener(type, (e) => e.stopPropagation());
  row.append(eye);
  return row;
}

// An eye, struck through when `off`.
function eyeIcon(off: boolean): SVGElement {
  const s = svg("svg", { viewBox: "0 0 16 16", class: "eye-icon" });
  const line = { fill: "none", stroke: "currentColor", "stroke-width": "1.3", "stroke-linecap": "round" };
  s.append(
    svg("path", { d: "M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z", ...line }),
    svg("circle", { cx: 8, cy: 8, r: 2, ...line }),
  );
  if (off) s.append(svg("path", { d: "M2.5 13.5l11-11", ...line }));
  return s;
}

// A tag: click jumps to the commit it points at, right-click opens its menu.
// `label` is what the row shows (shortened inside a folder); `full` is the real
// tag name every action needs — git doesn't know about the folder split.
function tagLeaf(
  label: string,
  target: string,
  cb: SidebarCallbacks,
  full: string = label,
  message: string | null = null,
): HTMLElement {
  // An annotated tag's message goes in its tooltip, between name and hints.
  const note = message ? `\n\n${message}\n\n` : "\n";
  const row = leaf(label, true, `${full}${note}Click: jump to commit · Right-click: actions`);
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
  const row = leaf(label, true, `${full}\nClick: jump to tip · Drag onto a branch: actions · Right-click: actions`, busy);
  if (target) row.addEventListener("click", () => cb.onRefJump(target, full));
  refDragHandle(row, { kind: "remote", name: full });
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
  for (const b of recent) {
    const row = branchLeaf(b, b.name, true, s.busyRefs.has(b.name), s.pinned === b.name, cb);
    tree.append(withVisibility(row, branchRefName(b.name), s, cb, b.is_head));
  }
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
        const row = branchLeaf(b, splitRef(b.name).label, true, s.busyRefs.has(b.name), s.pinned === b.name, cb, selectable);
        tree.append(withVisibility(row, branchRefName(b.name), s, cb, b.is_head));
      }
    }
  }
  for (const b of loose) {
    if (!match(b.name)) continue;
    const row = branchLeaf(b, b.name, false, s.busyRefs.has(b.name), s.pinned === b.name, cb, selectable);
    tree.append(withVisibility(row, branchRefName(b.name), s, cb, b.is_head));
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
  const add = el("button", { class: "sb-section-add", text: "+", title: "Add Remote…" });
  add.addEventListener("click", (e) => {
    e.stopPropagation(); // not a collapse toggle
    cb.onAddRemote();
  });
  row.append(add);
  tree.append(row);
  if (collapsed) return;

  // Configured remotes first, so one never fetched still gets its row (and its
  // menu); then any remote known only from its tracking branches.
  const remotes = new Map<string, { full: string; label: string; target: string }[]>();
  const urls = new Map(s.remoteList.map((r) => [r.name, r.url]));
  for (const r of s.remoteList) remotes.set(r.name, []);
  for (const r of s.refs.remotes) {
    const label = r.name.startsWith(`${r.remote}/`) ? r.name.slice(r.remote.length + 1) : r.name;
    const list = remotes.get(r.remote) ?? [];
    list.push({ full: r.name, label, target: r.target });
    remotes.set(r.remote, list);
  }

  for (const remote of [...remotes.keys()].sort()) {
    const shown = remotes.get(remote)!.filter((r) => match(r.full));
    if (shown.length === 0 && (filtering || !urls.has(remote))) continue;
    const rkey = `rm:${remote}`;
    const rcollapsed = s.collapsed.has(rkey) && !filtering;
    const folder = folderRow(rkey, remote, rcollapsed, cb);
    folder.title = `${remote}${urls.get(remote) ? `\n${urls.get(remote)}` : ""}\nRight-click: actions`;
    folder.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      cb.onRemoteFolderMenu(remote, e.clientX, e.clientY);
    });
    tree.append(folder);
    if (!rcollapsed) {
      for (const r of shown) {
        tree.append(withVisibility(remoteLeaf(r.label, r.full, r.target, s.busyRefs.has(r.full), cb), remoteRefName(r.full), s, cb));
      }
    }
  }
}

// The repo's open GitHub pull requests: who gh is signed in as in the header,
// the All / Created by me / Review requested filter, then one row each. In
// place of the list, how to install gh or a Sign In button when it can't be
// had.
function buildPullRequests(
  tree: HTMLElement,
  s: SidebarState,
  cb: SidebarCallbacks,
  match: (t: string) => boolean,
): void {
  const p = s.prs;
  if (!p.repo) return;
  const { row, collapsed } = sectionHeader("sec:prs", "Pull Requests", s, cb);
  const account = p.account;
  if (account?.installed) {
    const who = el("span", {
      class: `sb-pr-account${account.signed_in ? "" : " off"}`,
      title: account.signed_in ? `Signed in to GitHub as ${account.login} (through gh)` : "gh is not signed in to GitHub",
    });
    who.append(githubIcon(), document.createTextNode(account.signed_in ? (account.login ?? "") : "Not signed in"));
    row.append(who);
  }
  const refresh = el("button", { class: "sb-section-add", text: "⟳", title: `Refresh pull requests of ${p.repo}` });
  refresh.addEventListener("click", (e) => {
    e.stopPropagation(); // not a collapse toggle
    cb.onPrRefresh();
  });
  row.append(refresh);
  tree.append(row);
  if (collapsed) return;

  const note = (text: string, cls = "") => tree.append(el("div", { class: `sb-note ${cls}`.trim(), text }));
  if (!account) return note("Checking GitHub…");
  if (!account.installed) return note("Install the GitHub CLI to see pull requests: brew install gh");
  if (!account.signed_in) {
    const signIn = el("button", { class: "btn small", text: "Sign in to GitHub" });
    signIn.addEventListener("click", () => cb.onGitHubSignIn());
    tree.append(el("div", { class: "sb-pr-signin" }, [signIn]));
    if (account.message) note(account.message, "sb-pr-error");
    return;
  }

  const filters = el("div", { class: "seg-toggle sb-pr-filters", role: "group" });
  for (const f of PR_FILTERS) {
    const b = el("button", { class: f.value === p.filter ? "seg active" : "seg", text: f.label });
    b.addEventListener("click", () => cb.onPrFilter(f.value));
    filters.append(b);
  }
  tree.append(filters);
  const search = el("input", {
    class: "sb-filter sb-pr-search",
    type: "search",
    placeholder: "Search: title, #number, author, branch",
    "aria-label": "Search pull requests",
    spellcheck: "false",
  });
  search.value = p.query;
  search.addEventListener("input", () => cb.onPrSearch(search.value));
  tree.append(el("div", { class: "sb-pr-search-wrap" }, [search]));
  if (p.error) note(p.error, "sb-pr-error");
  if (!p.list) return void (p.loading && note("Loading…"));
  const q = p.query.trim().toLowerCase();
  const searched = (text: string) => text.toLowerCase().includes(q);
  const shown = p.list.filter((pr) => prMatches(pr, match) && prMatches(pr, searched));
  // A number the list doesn't hold (closed, merged, or past the open ones
  // loaded): GitHub has it, so offer to open it.
  const number = prNumberQuery(p.query);
  if (number !== null && !p.list.some((pr) => pr.number === number)) {
    const open = el("div", { class: "sb-leaf indent sb-pr-open", title: `Open pull request #${number} from GitHub` });
    open.append(el("span", { class: "sb-leaf-label", text: `Open #${number}` }));
    open.addEventListener("click", () => cb.onPrOpenNumber(number));
    tree.append(open);
  } else if (shown.length === 0) note(p.list.length ? "No matches" : "No open pull requests");
  for (const pr of shown) tree.append(prLeaf(pr, p.open === pr.number && s.activeView === "pr", cb));
}

// A pull request: its checks as a dot, number and title, draft and review
// badges, and its author. Click opens it, right-click its menu.
function prLeaf(pr: PullRequest, open: boolean, cb: SidebarCallbacks): HTMLElement {
  const review = reviewDecisionLabel(pr.review_decision);
  const row = el("div", {
    class: `sb-leaf indent sb-pr${open ? " head" : ""}`,
    title: [
      `#${pr.number} ${pr.title}`,
      `${pr.author} · ${pr.base} ← ${pr.head}`,
      [pr.is_draft ? "draft" : null, review, pr.checks ? `checks: ${pr.checks}` : null].filter(Boolean).join(" · "),
      "Click: open · Right-click: actions",
    ]
      .filter(Boolean)
      .join("\n"),
  });
  row.append(
    el("span", { class: `sb-pr-checks ${pr.checks ?? "none"}` }),
    el("span", { class: "sb-leaf-label", text: `#${pr.number} ${pr.title}` }),
  );
  if (pr.is_draft) row.append(el("span", { class: "sb-badge", text: "draft" }));
  if (review && pr.review_decision !== "REVIEW_REQUIRED") {
    row.append(el("span", { class: `sb-badge review-${pr.review_decision!.toLowerCase()}`, text: review }));
  }
  row.append(el("span", { class: "sb-ab", text: pr.author }));
  row.addEventListener("click", () => cb.onPrOpen(pr));
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    cb.onPrMenu(pr, e.clientX, e.clientY);
  });
  return row;
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

  type TagEntry = { full: string; label: string; target: string; message: string | null };
  const folders = new Map<string, TagEntry[]>();
  const loose: TagEntry[] = [];
  for (const tag of s.refs.tags) {
    if (!match(tag.name)) continue;
    const { folder, label } = splitRef(tag.name);
    const entry = { full: tag.name, label, target: tag.target, message: tag.message };
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
      for (const t of folders.get(folder)!) tree.append(withVisibility(tagLeaf(t.label, t.target, cb, t.full, t.message), tagRefName(t.full), s, cb));
    }
  }
  // Unfoldered tags after the groups, matching how branches are laid out.
  for (const t of loose) tree.append(withVisibility(tagLeaf(t.label, t.target, cb, t.full, t.message), tagRefName(t.full), s, cb));
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

// The folder name a worktree is known by in the sidebar.
export function worktreeName(w: Worktree): string {
  return w.path.split("/").filter(Boolean).pop() ?? w.path;
}

// Where a new worktree for `branch` goes by default: beside the main
// worktree's folder, `../<repo>-<branch>` — relative to the repo, as git
// resolves it — with the branch's slashes flattened so `feature/x` doesn't
// become a nested folder.
export function siblingWorktreePath(mainPath: string, branch: string): string {
  const repo = mainPath.split("/").filter(Boolean).pop() ?? "repo";
  return `../${repo}-${branch.replace(/\//g, "-")}`;
}

// The worktrees, each by folder name with what it has checked out. The header
// takes a dropped branch, to add a worktree for it.
function buildWorktrees(
  tree: HTMLElement,
  s: SidebarState,
  cb: SidebarCallbacks,
  match: (t: string) => boolean,
): void {
  const { row, collapsed } = sectionHeader("sec:worktrees", "Worktrees", s, cb);
  row.title = "Drop a branch here: add a worktree for it";
  refDropZone(row, cb.onWorktreeDrop);
  tree.append(row);
  if (collapsed) return;
  const summaries = new Map(s.worktreeSummaries.map((x) => [x.path, x]));
  for (const w of s.worktrees) {
    if (match(worktreeName(w)) || match(w.branch ?? "")) tree.append(worktreeLeaf(w, summaries.get(w.path), cb));
  }
}

// A worktree: click jumps to its commit, double-click opens it as a tab,
// right-click opens its menu. The current one is accented like HEAD's branch.
// `sum`: its changed-file count and ahead/behind, once known.
function worktreeLeaf(w: Worktree, sum: WorktreeSummary | undefined, cb: SidebarCallbacks): HTMLElement {
  const checkedOut = w.branch ?? (w.head ? `detached ${w.head.slice(0, 7)}` : "");
  const notes = [
    w.is_main ? "main worktree" : null,
    w.locked ? `locked${w.lock_reason ? `: ${w.lock_reason}` : ""}` : null,
    w.prunable ? "folder is missing" : null,
  ].filter(Boolean);
  const row = el("div", {
    class: `sb-leaf${w.is_current ? " head" : ""}${w.prunable ? " sb-missing" : ""}`,
    title: [w.path, ...notes, "Click: jump to commit · Double-click: open · Right-click: actions"].join("\n"),
  });
  row.append(el("span", { class: "sb-leaf-label", text: worktreeName(w) }));
  if (w.locked) row.append(el("span", { class: "sb-badge", text: "locked" }));
  if (w.prunable) row.append(el("span", { class: "sb-badge", text: "missing" }));
  if (sum?.changed) {
    const title = `${sum.changed} uncommitted change${sum.changed === 1 ? "" : "s"}`;
    row.append(el("span", { class: "sb-badge wt-changes", text: `✎ ${sum.changed}`, title }));
  }
  if (checkedOut) row.append(el("span", { class: "sb-ab", text: checkedOut }));
  const ab: string[] = [];
  if (sum?.behind) ab.push(`${sum.behind}↓`);
  if (sum?.ahead) ab.push(`${sum.ahead}↑`);
  if (ab.length) row.append(el("span", { class: "sb-ab", text: ab.join(" "), title: "Behind / ahead of its upstream" }));

  let clickTimer: number | undefined;
  row.addEventListener("click", () => {
    window.clearTimeout(clickTimer);
    if (w.head) clickTimer = window.setTimeout(() => cb.onRefJump(w.head!, worktreeName(w)), 220);
  });
  row.addEventListener("dblclick", () => {
    window.clearTimeout(clickTimer);
    if (!w.is_current && !w.prunable) cb.onWorktreeOpen(w);
  });
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    window.clearTimeout(clickTimer);
    cb.onWorktreeMenu(w, e.clientX, e.clientY);
  });
  return row;
}

// What a submodule's badge says when it isn't simply up to date.
const SUBMODULE_BADGE: Record<Submodule["state"], string | null> = {
  uninitialized: "not initialized",
  modified: "different commit",
  dirty: "local changes",
  up_to_date: null,
};

function buildSubmodules(
  tree: HTMLElement,
  s: SidebarState,
  cb: SidebarCallbacks,
  match: (t: string) => boolean,
): void {
  const { row, collapsed } = sectionHeader("sec:submodules", "Submodules", s, cb);
  const add = el("button", { class: "sb-section-add", text: "+", title: "Add Submodule…" });
  add.addEventListener("click", (e) => {
    e.stopPropagation(); // not a collapse toggle
    cb.onAddSubmodule();
  });
  row.append(add);
  tree.append(row);
  if (collapsed) return;
  for (const sm of s.submodules) if (match(sm.path)) tree.append(submoduleLeaf(sm, cb));
}

// A submodule: its path, a badge unless it's up to date, and the commit the
// repo records for it. Double-click opens it, right-click offers update/sync.
function submoduleLeaf(sm: Submodule, cb: SidebarCallbacks): HTMLElement {
  const short = (id: string | null) => id?.slice(0, 7) ?? "none";
  const badge = SUBMODULE_BADGE[sm.state];
  const row = el("div", {
    class: "sb-leaf",
    title: [
      sm.path,
      sm.url ?? "",
      `Recorded: ${short(sm.recorded)} · Checked out: ${short(sm.checked_out)}`,
      "Double-click: open · Right-click: update, sync, edit URL, remove",
    ]
      .filter(Boolean)
      .join("\n"),
  });
  row.append(el("span", { class: "sb-leaf-label", text: sm.path }));
  if (badge) row.append(el("span", { class: `sb-badge sm-${sm.state}`, text: badge }));
  if (sm.recorded) row.append(el("span", { class: "sb-ab", text: short(sm.recorded) }));
  row.addEventListener("dblclick", () => {
    if (sm.state !== "uninitialized") cb.onSubmoduleOpen(sm);
  });
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    cb.onSubmoduleMenu(sm, e.clientX, e.clientY);
  });
  return row;
}
