// Find on the page (Cmd/Ctrl+F in the Changes and Pull Request tabs): a bar
// over the top right, every match marked, Enter / Shift+Enter stepping
// through them, Escape closing. The `selector` names the blocks searched —
// diff lines, comments — and a match is looked for in a block's whole text,
// so it is found across the syntax spans a line is made of. Staging or a
// reply re-renders the page, which drops the marks: they are put back
// whenever the document changes under the bar.

import { el } from "../dom";

let bar: HTMLElement | null = null;
let input: HTMLInputElement | null = null;
let count: HTMLElement | null = null;
let observer: MutationObserver | null = null;
let scopeOf: () => HTMLElement | null = () => null;
let blocks = ".diff-line";
// One entry per match: its marks, several when the match crosses spans.
let hits: HTMLElement[][] = [];
let current = 0;
let applying = false;

export function openDiffFind(scope: () => HTMLElement | null, selector = ".diff-line"): void {
  scopeOf = scope;
  blocks = selector;
  if (!bar) {
    input = el("input", { class: "diff-find-input", type: "text", placeholder: "Find…", autocomplete: "off", spellcheck: "false" });
    count = el("span", { class: "diff-find-count" });
    const btn = (label: string, title: string, run: () => void) => {
      const b = el("button", { class: "diff-find-btn", type: "button", title, text: label });
      b.addEventListener("click", run);
      return b;
    };
    bar = el("div", { class: "diff-find", role: "search" }, [
      input,
      count,
      btn("▲", "Previous match (Shift+Enter)", () => step(-1)),
      btn("▼", "Next match (Enter)", () => step(1)),
      btn("×", "Close (Esc)", closeDiffFind),
    ]);
    input.addEventListener("input", () => apply(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeDiffFind();
      }
    });
    document.body.append(bar);
    observer = new MutationObserver((records) => {
      // The marks' own comings and goings (and the count's text) are mutations
      // too, and the observer hears them only after `apply` is over: an
      // element that is not a mark is what tells a render apart.
      const rendered = records.some((r) => [...r.addedNodes, ...r.removedNodes].some((n) => n instanceof Element && !n.matches("mark.find-hit")));
      if (!rendered || applying || !bar) return;
      if (!scopeOf()) return closeDiffFind();
      apply(false);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  input!.focus();
  input!.select();
}

export function closeDiffFind(): void {
  observer?.disconnect();
  observer = null;
  unmark();
  bar?.remove();
  bar = input = count = null;
  hits = [];
}

/// Mark every match of the query in the diff's lines; `reset` starts again
/// from the first, else the current one is kept where possible.
function apply(reset: boolean): void {
  applying = true;
  try {
    unmark();
    hits = [];
    const query = input?.value ?? "";
    const root = scopeOf();
    if (query && root) {
      for (const line of root.querySelectorAll<HTMLElement>(blocks)) markLine(line, query.toLowerCase());
    }
    current = reset || !hits.length ? 0 : Math.min(current, hits.length - 1);
    showCurrent(reset);
  } finally {
    applying = false;
  }
}

/// The matches in one line's text, each wrapped in <mark>s over the text
/// nodes it covers. Wrapping splits nodes, so the splits go from the end of
/// each node backwards and earlier offsets stay valid.
function markLine(line: HTMLElement, query: string): void {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  const text = nodes.map((n) => n.data).join("");
  const lower = text.toLowerCase();
  const matches: [number, number][] = [];
  for (let i = lower.indexOf(query); i >= 0; i = lower.indexOf(query, i + query.length)) matches.push([i, i + query.length]);
  if (!matches.length) return;
  // Each node's pieces (offsets inside the node) and which match they belong to.
  const pieces = nodes.map(() => [] as { start: number; end: number; match: number }[]);
  let offset = 0;
  nodes.forEach((n, ni) => {
    const nodeEnd = offset + n.data.length;
    matches.forEach(([s, e], mi) => {
      const start = Math.max(s, offset);
      const end = Math.min(e, nodeEnd);
      if (start < end) pieces[ni].push({ start: start - offset, end: end - offset, match: mi });
    });
    offset = nodeEnd;
  });
  const marks: HTMLElement[][] = matches.map(() => []);
  nodes.forEach((n, ni) => {
    for (const p of [...pieces[ni]].reverse()) {
      const hit = n.splitText(p.start);
      hit.splitText(p.end - p.start);
      const mark = el("mark", { class: "find-hit" });
      hit.replaceWith(mark);
      mark.append(hit);
      marks[p.match].unshift(mark);
    }
  });
  hits.push(...marks);
}

function unmark(): void {
  const parents = new Set<Node>();
  for (const mark of document.querySelectorAll("mark.find-hit")) {
    if (mark.parentNode) parents.add(mark.parentNode);
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
  }
  for (const p of parents) p.normalize();
}

function step(delta: number): void {
  if (!hits.length) return;
  current = (current + delta + hits.length) % hits.length;
  showCurrent(true);
}

function showCurrent(scroll: boolean): void {
  hits.forEach((marks, i) => marks.forEach((m) => m.classList.toggle("current", i === current)));
  if (count) count.textContent = !input?.value ? "" : hits.length ? `${current + 1} of ${hits.length}` : "No matches";
  if (scroll) hits[current]?.[0]?.scrollIntoView?.({ block: "center" });
}
