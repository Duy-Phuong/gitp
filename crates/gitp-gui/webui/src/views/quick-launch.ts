// Quick Launch: a keyboard-first command palette over everything gitp can do,
// plus the repositories you've opened before.
//
// Two stages. The first lists recent repositories and commands. A command that
// needs a target — a branch to check out, a file to blame — doesn't run on
// Enter; it pushes a second stage whose own filtered list *is* the target
// picker, with the command's name kept on screen as a chip so it's clear what
// the list is for. Escape (or Backspace on an empty query) pops back rather
// than closing outright, so a wrong turn costs one keystroke.
//
// The host supplies every item and what it does; this module owns only the
// overlay, the filtering, and the keyboard.

import { clear, el } from "../dom";

export type QuickKind = "repo" | "command" | "branch" | "file" | "option";

export interface QuickItem {
  label: string;
  /// Dimmed secondary text: a repo's path, a file's directory.
  detail?: string;
  kind: QuickKind;
  /// Runs and closes the palette. Ignored when `next` is set.
  run?: () => void;
  /// Makes this a two-stage command: returns the stage to push instead of
  /// running. May be async (a branch list can need a fetch first).
  next?: () => QuickStage | Promise<QuickStage>;
}

export interface QuickSection {
  title: string;
  items: QuickItem[];
}

export interface QuickStage {
  /// Shown as a chip before the input once this stage is pushed — the command
  /// that led here. Absent on the first stage.
  chip?: string;
  placeholder: string;
  sections: QuickSection[];
  /// Shown instead of "No matches." when the stage has no items at all, so an
  /// empty picker can explain itself ("this repository has no stashes").
  emptyNote?: string;
}

/// How well `item` matches `query`, or null for no match.
///
/// A subsequence match, so "chb" finds "Checkout Branch", ranked so exact and
/// prefix hits beat scattered ones and a hit on the label beats a hit on the
/// dimmed detail text. Exported for its tests — the ranking is the whole
/// difference between a palette that feels psychic and one that doesn't.
export function scoreItem(item: QuickItem, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const label = item.label.toLowerCase();

  if (label === q) return 1000;
  if (label.startsWith(q)) return 900 - label.length;
  if (label.includes(q)) return 700 - label.indexOf(q);

  // Word-initials: "cb" → "Checkout Branch".
  const initials = label.split(/[^a-z0-9]+/).filter(Boolean).map((w) => w[0]).join("");
  if (initials.startsWith(q)) return 600;

  const sub = subsequenceScore(label, q);
  if (sub !== null) return 400 + sub;

  // Detail text matches last: a path or directory is context, not the name.
  const detail = item.detail?.toLowerCase();
  if (detail?.includes(q)) return 200 - detail.indexOf(q);
  return null;
}

// Characters of `q` appearing in order in `text`; scored by how tightly
// packed the match is, so "loc" prefers "local" over "log commit".
function subsequenceScore(text: string, q: string): number | null {
  let ti = 0;
  let first = -1;
  let last = -1;
  for (const ch of q) {
    const found = text.indexOf(ch, ti);
    if (found === -1) return null;
    if (first === -1) first = found;
    last = found;
    ti = found + 1;
  }
  const span = last - first + 1;
  return Math.max(0, 100 - (span - q.length)) - first;
}

/// The first `limit` items across `sections`, dropping whole sections once the
/// budget runs out. Section order is preserved, so the best matches — which
/// `filterSections` has already sorted to the front — are the ones kept.
export function capSections(sections: QuickSection[], limit: number): QuickSection[] {
  const out: QuickSection[] = [];
  let left = limit;
  for (const section of sections) {
    if (left <= 0) break;
    out.push({ title: section.title, items: section.items.slice(0, left) });
    left -= Math.min(section.items.length, left);
  }
  return out;
}

/// The sections of `stage`, filtered to what matches `query` and ordered
/// best-first within each section. Sections that end up empty are dropped.
export function filterSections(sections: QuickSection[], query: string): QuickSection[] {
  const out: QuickSection[] = [];
  for (const section of sections) {
    const scored = section.items
      .map((item) => ({ item, score: scoreItem(item, query) }))
      .filter((s): s is { item: QuickItem; score: number } => s.score !== null);
    // A blank query keeps the author's order; a real one sorts by score.
    if (query.trim()) scored.sort((a, b) => b.score - a.score);
    if (scored.length) out.push({ title: section.title, items: scored.map((s) => s.item) });
  }
  return out;
}

// Most rows rendered at once.
//
// A real repository's file tree is thousands of entries — `commit_tree` on a
// 20k-commit repo here returns 8878 — and renderList runs on every keystroke.
// Building all of them measured at ~420ms per render, which makes the picker
// feel frozen. Nobody reads past the first screen of a palette anyway; the cap
// is announced rather than silent so it's clear more exist.
const MAX_ROWS = 200;

let open: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;

export function closeQuickLaunch(): void {
  if (!open) return;
  open.remove();
  open = null;
  if (onKey) document.removeEventListener("keydown", onKey, true);
  onKey = null;
}

export function isQuickLaunchOpen(): boolean {
  return open !== null;
}

export function showQuickLaunch(first: QuickStage): void {
  closeQuickLaunch();

  const stack: QuickStage[] = [first];
  let selected = 0;
  // Flattened rows of the current filtered view, so arrow keys move through
  // items while skipping section headers.
  let visible: QuickItem[] = [];

  const overlay = el("div", { class: "ql-overlay" });
  const panel = el("div", { class: "ql-panel", role: "dialog", "aria-label": "Quick Launch" });
  const bar = el("div", { class: "ql-bar" });
  const input = el("input", {
    class: "ql-input",
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": "Quick Launch search",
  }) as HTMLInputElement;
  const list = el("div", { class: "ql-list", role: "listbox" });
  const hint = el("div", { class: "ql-hint", text: "↑↓ to move · ↵ to run · esc to close" });

  bar.append(searchIcon());
  panel.append(bar, list, hint);
  overlay.append(panel);
  document.body.append(overlay);
  open = overlay;

  function stage(): QuickStage {
    return stack[stack.length - 1];
  }

  function renderBar(): void {
    clear(bar);
    bar.append(searchIcon());
    // Each pushed stage keeps its command's name visible as a chip, so a list
    // of bare branch names still says what picking one will do.
    for (const s of stack) if (s.chip) bar.append(el("span", { class: "ql-chip", text: s.chip }));
    input.placeholder = stage().placeholder;
    bar.append(input);
  }

  function renderList(): void {
    const all = filterSections(stage().sections, input.value);
    const total = all.reduce((n, s) => n + s.items.length, 0);
    const sections = capSections(all, MAX_ROWS);
    visible = sections.flatMap((s) => s.items);
    if (selected >= visible.length) selected = Math.max(0, visible.length - 1);

    clear(list);
    if (!visible.length) {
      const nothingToShow = stage().sections.every((s) => s.items.length === 0);
      list.append(
        el("div", {
          class: "ql-empty",
          // "No matches" is misleading when the list was empty to begin with —
          // the user would keep deleting characters looking for the match.
          text: nothingToShow ? (stage().emptyNote ?? "Nothing to show.") : "No matches.",
        }),
      );
      return;
    }
    let index = 0;
    for (const section of sections) {
      list.append(el("div", { class: "ql-section", text: section.title }));
      for (const item of section.items) {
        const i = index++;
        const row = el("div", {
          class: `ql-row${i === selected ? " selected" : ""}`,
          role: "option",
          "aria-selected": i === selected ? "true" : "false",
        });
        row.append(icon(item.kind), el("span", { class: "ql-label", text: item.label }));
        if (item.detail) row.append(el("span", { class: "ql-detail", text: item.detail }));
        // mousedown, not click: the input keeps focus and the row can't be
        // "clicked" out from under a re-render triggered by hovering.
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          void choose(item);
        });
        row.addEventListener("mousemove", () => {
          if (selected === i) return;
          selected = i;
          renderList();
        });
        list.append(row);
      }
    }
    if (total > visible.length) {
      list.append(
        el("div", {
          class: "ql-more",
          text: `${total - visible.length} more — keep typing to narrow the list`,
        }),
      );
    }
    list.querySelector(".ql-row.selected")?.scrollIntoView({ block: "nearest" });
  }

  async function choose(item: QuickItem): Promise<void> {
    if (item.next) {
      // Building a stage can mean a round trip (the file picker reads the whole
      // tree). Say so: without this the palette sits there looking as though
      // Enter did nothing.
      note("Loading…");
      let pushed: QuickStage;
      try {
        pushed = await item.next();
      } catch (err) {
        // Never fail silently — an empty-looking palette is indistinguishable
        // from a dead keystroke.
        note(`Couldn't open ${item.label}: ${String(err)}`);
        return;
      }
      if (!open) return; // closed while the stage was being built
      stack.push(pushed);
      selected = 0;
      input.value = "";
      renderBar();
      renderList();
      input.focus();
      return;
    }
    closeQuickLaunch();
    item.run?.();
  }

  // Replace the list with a single message (loading, or why a stage failed).
  function note(text: string): void {
    clear(list);
    list.append(el("div", { class: "ql-empty", text }));
    visible = [];
  }

  function back(): boolean {
    if (stack.length === 1) return false;
    stack.pop();
    selected = 0;
    input.value = "";
    renderBar();
    renderList();
    return true;
  }

  input.addEventListener("input", () => {
    selected = 0;
    renderList();
  });

  onKey = (e: KeyboardEvent) => {
    if (!open) return;
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      if (visible.length) selected = (selected + 1) % visible.length;
      renderList();
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      if (visible.length) selected = (selected - 1 + visible.length) % visible.length;
      renderList();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = visible[selected];
      if (item) void choose(item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Step back out of a target picker before giving up on the palette.
      if (!back()) closeQuickLaunch();
    } else if (e.key === "Backspace" && input.value === "") {
      // Backspacing past the start of an empty query deletes the chip, the
      // same way it deletes a token in a search field.
      if (back()) e.preventDefault();
    }
  };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (e) => {
    if (!panel.contains(e.target as Node)) closeQuickLaunch();
  });

  renderBar();
  renderList();
  requestAnimationFrame(() => input.focus());
}

// --- icons ------------------------------------------------------------------

function svgEl(paths: string[], extra: (el: SVGElement) => void = () => {}): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("class", "ql-icon");
  node.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d);
    node.append(p);
  }
  extra(node);
  return node;
}

function searchIcon(): SVGElement {
  const node = svgEl(["M21 21l-4.3-4.3"]);
  node.setAttribute("class", "ql-search-icon");
  const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  c.setAttribute("cx", "11");
  c.setAttribute("cy", "11");
  c.setAttribute("r", "7");
  node.prepend(c);
  return node;
}

function icon(kind: QuickKind): SVGElement {
  if (kind === "branch") {
    const node = svgEl(["M6 8.4v7.2M6 12h6a6 6 0 006-6v-.6"]);
    for (const [cx, cy] of [[6, 6], [6, 18], [18, 7]]) {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", String(cx));
      c.setAttribute("cy", String(cy));
      c.setAttribute("r", "2.4");
      node.append(c);
    }
    return node;
  }
  if (kind === "file") return svgEl(["M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z", "M14 3v5h5"]);
  if (kind === "repo") return svgEl(["M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"]);
  if (kind === "option") return svgEl(["M5 12h14", "M12 5v14"]);
  return svgEl(["M4 6h10", "M4 12h16", "M4 18h7"]);
}
