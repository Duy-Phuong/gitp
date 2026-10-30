// Commit-graph log: an SVG lane graph aligned to a list of commit rows.
//
// Virtualized: only the rows/graph within the scroll viewport (plus a small
// buffer) are in the DOM, so a repo with 100k commits stays responsive. The
// full geometry is computed once (cheap math); only rendering is windowed.

import { authorInitials, avatarUrl } from "../avatar";
import { clear, el, githubIcon, laptopIcon, svg, tagIcon } from "../dom";
import { edgePath, fitLaneWidth, GRAPH_METRICS, type GraphMetrics, layoutGraph, visibleEdges } from "../graph";
import { ghostBranch } from "../commit-refs";
import {
  DEFAULT_LOG_COLUMNS,
  LOG_COLUMN_LABEL,
  LOG_COLUMNS,
  shownColumns,
  withColumnMoved,
  withColumnToggled,
  type LogColumn,
  type LogColumns,
} from "../log-columns";
import {
  loadAuthorInitials,
  loadDateFormat,
  loadLogColumns,
  loadRefColumnWidth,
  REF_COLUMN_DEFAULT,
  saveLogColumns,
  saveRefColumnWidth,
  type DateFormat,
} from "../prefs";
import { formatTime, fullTime } from "../timeago";
import { showContextMenu, type MenuItem } from "./context-menu";
import { refDragHandle } from "./ref-drag";
import type { BisectStatus, CommitRow, StashRef } from "../types";

// A ref pointing at a commit, shown as a colored chip on hover.
// What a log row shows for refs: the nearest few labels to draw, plus how many
// refs contain the commit in total (the "+N" badge). Only MAX_REF_CHIPS labels
// are ever drawn, so the producer bounds the list rather than handing over every
// ref that contains the commit — on a repo with hundreds of branches that list
// is hundreds long per row and costs seconds to build. See rebuildCommitRefs.
export interface RefLabels {
  labels: RefLabel[];
  total: number;
  /// Refs whose tip is this commit, merged GitKraken-style: the badges of the
  /// GitKraken themes' ref column. Absent when nothing points here.
  tips?: TipRef[];
}

// One badge in the GitKraken ref column. A local branch and the remote
// branches of the same name pointing at the same commit share one badge, with
// a laptop icon for the local copy and a remote icon per remote.
export interface TipRef {
  /// The branch name without its remote prefix, or the tag name.
  name: string;
  kind: "branch" | "tag";
  head: boolean;
  /// A local branch of this name points here.
  local: boolean;
  /// Full names of the remote branches that point here, e.g. "origin/dev".
  remotes: string[];
  /// An annotated tag's message, for the badge's tooltip.
  message?: string | null;
}

export interface RefLabel {
  name: string;
  kind: "head" | "branch" | "remote" | "tag";
  /// An annotated tag's message, for the chip's tooltip.
  message?: string | null;
}

// A tag chip's tooltip: its name, then the annotation when it has one.
function tagTitle(name: string, message: string | null | undefined): string {
  return message ? `tag ${name}\n\n${message}` : `tag ${name}`;
}

// How the graph is drawn. Each app theme picks one (see graphThemeFor): the
// gitp themes share the compact classic look, the GitKraken themes move the
// ref badges into a column of their own left of the graph, and differ from each
// other in how a lane change is drawn and what a commit node looks like.
interface GraphTheme {
  metrics: GraphMetrics;
  colors: string[];
  /// Author avatar in a lane-coloured ring, or a plain solid dot.
  node: "avatar" | "dot";
  nodeRadius: number;
  strokeWidth: number;
  /// A lane-coloured band behind each row, from its node to the right edge.
  bands: boolean;
  /// Faint vertical lines down every lane.
  guides: boolean;
}

// Main/production lanes come first, so lane 0 gets cyan and the next blue,
// then the feature/release colours.
const KRAKEN_COLORS = ["#00D2D3", "#54a0ff", "#f368e0", "#9b59b6", "#ff6b81", "#feca57", "#1dd1a1", "#ff9f43"];

const GRAPH_THEMES: Record<"classic" | "gitkraken" | "neon", GraphTheme> = {
  classic: {
    metrics: GRAPH_METRICS,
    colors: ["#5b8cff", "#f0883e", "#7ee787", "#d2a8ff", "#ff9a94", "#79c0ff", "#e3b341", "#ff7b72"],
    node: "avatar",
    nodeRadius: 9,
    strokeWidth: 2,
    bands: false,
    guides: false,
  },
  gitkraken: {
    metrics: { laneWidth: 22, rowHeight: 36, marginX: 16, cornerRadius: 10, originX: REF_COLUMN_DEFAULT, curve: "corner" },
    colors: KRAKEN_COLORS,
    node: "avatar",
    nodeRadius: 12,
    strokeWidth: 2.5,
    bands: true,
    guides: true,
  },
  neon: {
    metrics: { laneWidth: 20, rowHeight: 32, marginX: 16, cornerRadius: 8, originX: REF_COLUMN_DEFAULT, curve: "bezier" },
    colors: ["#00D2D3", "#54a0ff", "#ff6b81", "#9b59b6", "#f368e0", "#48dbfb", "#1dd1a1", "#feca57"],
    node: "dot",
    nodeRadius: 6,
    strokeWidth: 2.5,
    bands: false,
    guides: true,
  },
};

// The graph for the theme in force. Read from the DOM, like the terminal does,
// rather than from prefs, so the log doesn't depend on how themes are stored.
//
// On the GitKraken themes the ref column is as wide as the user dragged it, so
// the theme comes back with that `originX`. The sized copy is kept until the
// width or theme changes, because the layout cache is keyed on its identity.
function graphThemeFor(): GraphTheme {
  const name = document.documentElement.dataset.theme;
  const base =
    name === "gitkraken" ? GRAPH_THEMES.gitkraken : name === "gitkraken-neon" ? GRAPH_THEMES.neon : GRAPH_THEMES.classic;
  if (base.metrics.originX === 0) return base;
  if (sizedTheme?.base !== base || sizedTheme.width !== refColumnWidth) {
    sizedTheme = {
      base,
      width: refColumnWidth,
      theme: { ...base, metrics: { ...base.metrics, originX: refColumnWidth } },
    };
  }
  return sizedTheme.theme;
}

let refColumnWidth = loadRefColumnWidth();
let sizedTheme: { base: GraphTheme; width: number; theme: GraphTheme } | null = null;

const REF_COLUMN_MIN = 90;
const REF_COLUMN_MAX = 420;

// Height of the column header the GitKraken themes draw above the log.
const HEADER_H = 26;

// Where row `index` of the last rendered log starts, for callers that scroll to
// a row. Not just `index * rowHeight`: the WIP row, when shown, sits above row 0.
export function logRowTop(index: number): number {
  return index * graphThemeFor().metrics.rowHeight + wipLead;
}

// The "// WIP" row GitKraken draws above the graph while the working tree has
// uncommitted changes: a hollow node in HEAD's lane with a dashed line down to
// HEAD. It is drawn by renderLog as a leading row of its own rather than faked
// into the rows, so every row index (selection, keyboard moves, search results,
// jump-to-commit) still means the same commit. Set from the workspace snapshot
// (see setWipRow), like the bisect marks.
let wip: { changes: number; head: string | null } | null = null;
let onOpenWip: (() => void) | null = null;
// Height of the WIP row in the last rendered log: 0, or one row.
let wipLead = 0;

// Adopt the change count and HEAD's commit. Returns whether the WIP row
// changed, so the caller knows the log needs repainting.
export function setWipRow(changes: number, head: string | null): boolean {
  const next = changes > 0 ? { changes, head } : null;
  if (next?.changes === wip?.changes && next?.head === wip?.head) return false;
  wip = next;
  return true;
}

// What clicking the WIP row does: open Local Changes. Set once at startup.
export function setOnOpenWip(handler: () => void): void {
  onOpenWip = handler;
}

// Stashes, drawn on the row of the commit each was taken on: a dashed line from
// that commit's node to a box-marked chip at the start of its message. Only
// stashes whose base commit is loaded show; a map lookup per drawn row keeps
// it free on a long log. Set from the workspace snapshot, like the WIP row.
let stashesByBase = new Map<string, StashRef[]>();
let stashSig = "";
let stashHandlers: { open: (s: StashRef) => void; menu: (s: StashRef, x: number, y: number) => void } | null = null;

// Adopt the stash stack. Returns whether it changed, so the caller knows the log
// needs repainting.
export function setStashNodes(stashes: StashRef[]): boolean {
  const sig = stashes.map((s) => `${s.index}:${s.base}:${s.message}`).join("|");
  if (sig === stashSig) return false;
  stashSig = sig;
  stashesByBase = new Map();
  for (const s of stashes) {
    if (!s.base) continue;
    const list = stashesByBase.get(s.base);
    if (list) list.push(s);
    else stashesByBase.set(s.base, [s]);
  }
  return true;
}

// What a stash chip does: click shows its changes, right-click opens the
// sidebar's stash menu. Set once at startup.
export function setStashHandlers(open: (s: StashRef) => void, menu: (s: StashRef, x: number, y: number) => void): void {
  stashHandlers = { open, menu };
}

function stashChip(s: StashRef): HTMLElement {
  const label = `stash@{${s.index}}: ${s.message}`;
  const chip = el("span", { class: "stash-chip", title: `${label}\nClick: show changes · Right-click: actions` }, [
    el("span", { class: "stash-box" }),
    el("span", { class: "stash-chip-name", text: label }),
  ]);
  // Not a row click or a commit menu: the row's selection stays as it was.
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    stashHandlers?.open(s);
  });
  chip.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    stashHandlers?.menu(s, e.clientX, e.clientY);
  });
  return chip;
}

const BUFFER_ROWS = 8;
const MAX_REF_CHIPS = 3;

// Bisect marks per commit id, drawn as a small chip before the summary; the
// commit under test also gets its row highlighted. Set from the workspace
// snapshot (see setBisectMarks) rather than passed to renderLog, which has
// many callers that have nothing to do with bisecting.
type BisectMarkKind = "good" | "bad" | "skip" | "first-bad";
let bisectMarks = new Map<string, BisectMarkKind>();
let bisectCurrent: string | null = null;
let bisectSig = "";

const BISECT_MARK_LABEL: Record<BisectMarkKind, string> = {
  good: "good",
  bad: "bad",
  skip: "skip",
  "first-bad": "first bad",
};

// Adopt the in-progress bisect (or null). Returns whether the marks changed,
// so the caller knows the log needs repainting.
export function setBisectMarks(st: BisectStatus | null): boolean {
  const sig = st
    ? [st.bad, st.first_bad, st.current, st.good.join(","), st.skipped.join(",")].join("|")
    : "";
  if (sig === bisectSig) return false;
  bisectSig = sig;
  bisectMarks = new Map();
  bisectCurrent = null;
  if (!st) return true;
  for (const id of st.good) bisectMarks.set(id, "good");
  for (const id of st.skipped) bisectMarks.set(id, "skip");
  if (st.bad) bisectMarks.set(st.bad, st.first_bad === st.bad ? "first-bad" : "bad");
  // Once the culprit is found HEAD is just wherever testing stopped.
  if (!st.first_bad) bisectCurrent = st.current;
  return true;
}

// What clicking a "+N" ref badge does: open a list of every ref on the commit.
// Set once at startup (see main.ts) rather than passed to renderLog, which has
// many callers that would all pass the same thing.
let onMoreRefs: ((id: string, x: number, y: number) => void) | null = null;

export function setOnMoreRefs(handler: (id: string, x: number, y: number) => void): void {
  onMoreRefs = handler;
}

// A "+N" badge; clicking it lists the refs it stands for.
function moreBadge(id: string, n: number): HTMLElement {
  const chip = el("span", { class: "commit-ref more", text: `+${n}`, title: "Show all refs on this commit" });
  chip.addEventListener("click", (e) => {
    if (!onMoreRefs) return;
    // Not a row click: the row stays as selected as it was.
    e.stopPropagation();
    onMoreRefs(id, e.clientX, e.clientY);
  });
  return chip;
}

// A badge in the GitKraken ref column: name, then a laptop for the local copy
// and a remote icon per remote copy (see TipRef).
function tipBadge(t: TipRef): HTMLElement {
  const where = [t.local ? "local" : "", ...t.remotes].filter(Boolean).join(" · ");
  const chip = el("span", {
    class: `commit-ref tip ${t.head ? "head" : t.kind}`,
    title: t.kind === "tag" ? tagTitle(t.name, t.message) : `${t.name} (${where})`,
  });
  if (t.kind === "tag") chip.append(tagIcon());
  chip.append(el("span", { class: "commit-ref-name", text: t.head ? `✓ ${t.name}` : t.name }));
  if (t.local) chip.append(laptopIcon());
  for (let k = 0; k < t.remotes.length; k++) chip.append(githubIcon());
  // A merged badge drags as its local branch, or else its (first) remote one.
  if (t.local) refDragHandle(chip, { kind: "local", name: t.name });
  else if (t.remotes.length) refDragHandle(chip, { kind: "remote", name: t.remotes[0] });
  return chip;
}

// The ghost badge (see ghostBadge) on a commit no ref points at: its nearest
// containing branch, faded, shown while the row is hovered or selected (CSS).
// Double-click checks the branch out.
let onGhostCheckout: ((branch: string) => void) | null = null;

// What double-clicking a ghost badge does. Set once at startup.
export function setOnGhostCheckout(handler: (branch: string) => void): void {
  onGhostCheckout = handler;
}

function ghostBadge(name: string): HTMLElement {
  const chip = el("span", { class: "commit-ref tip ghost", title: `On ${name}\nDouble-click: checkout` });
  chip.append(el("span", { class: "commit-ref-name", text: name }));
  chip.addEventListener("click", (e) => {
    // The click count rather than a dblclick listener: the first click selects
    // the row, which redraws it, so the second lands on a new badge.
    if (e.detail !== 2) return;
    e.stopPropagation();
    onGhostCheckout?.(name);
  });
  // A branch like any other badge: it drags, and hovering it fades the rest.
  refDragHandle(chip, { kind: "local", name });
  return chip;
}

// The open repo's optional columns (GitKraken themes; see log-columns.ts), and
// the repo they are saved for. Set when the active repo changes.
let columns: LogColumns = DEFAULT_LOG_COLUMNS;
let columnsRepo = "";

export function setLogColumnsRepo(repo: string): void {
  columnsRepo = repo;
  columns = loadLogColumns(repo);
}

// The Author column's funnel: whether an author filter is in force, and the
// menu that picks one. Set once at startup (see main.ts), which owns the search
// box the filter lives in.
let authorFilter: { active: () => boolean; open: (x: number, y: number) => void } | null = null;

export function setAuthorFilter(filter: { active: () => boolean; open: (x: number, y: number) => void }): void {
  authorFilter = filter;
}

// A row's cell for each optional column. Rows and header append them in the
// same order, so the two line up.
const COLUMN_CLASS: Record<LogColumn, string> = {
  author: "commit-meta commit-author",
  date: "commit-meta commit-time",
  sha: "commit-sha",
};

const COLUMN_TEXT: Record<LogColumn, (row: CommitRow, dates: DateFormat) => string> = {
  author: (row) => row.author_name,
  date: (row, dates) => formatTime(row.time, dates),
  sha: (row) => row.short_id,
};

function funnelIcon(): SVGElement {
  const s = svg("svg", { viewBox: "0 0 16 16", class: "funnel-icon" });
  s.appendChild(
    svg("path", { d: "M2 3h12l-4.5 5.5V13l-3 1.5v-6z", fill: "none", stroke: "currentColor", "stroke-width": "1.4", "stroke-linejoin": "round" }),
  );
  return s;
}

// While a branch is hovered (see branch-hover.ts): which commits are on it.
// The rest are drawn faded.
let highlight: ((id: string) => boolean) | null = null;
// Redraws the rows on screen of the log last rendered, and its header cells
// too when the columns changed; null while no log is shown.
let repaint: ((columnsChanged: boolean) => void) | null = null;

export function setLogHighlight(test: ((id: string) => boolean) | null): void {
  if (test === highlight) return;
  highlight = test;
  repaint?.(false);
}

// Adopt and save new columns, and redraw the log with them.
function applyColumns(next: LogColumns): void {
  columns = next;
  saveLogColumns(columnsRepo, next);
  repaint?.(true);
}

// The header's right-click menu: a checkmark per shown column.
function columnsMenu(): MenuItem[] {
  return [
    { heading: "Columns" },
    // Always shown: nothing to toggle.
    { label: "✓ Commit message" },
    ...LOG_COLUMNS.map((c) => ({
      label: `${columns.hidden.includes(c) ? "" : "✓ "}${LOG_COLUMN_LABEL[c]}`,
      run: () => applyColumns(withColumnToggled(columns, c)),
    })),
  ];
}

// Drag a column's header cell sideways to move the column. Mouse events rather
// than HTML5 drag-and-drop, for the reason given in ref-drag.ts. The slot is
// shown as an accent edge on the cell the column would go before (or after the
// last one).
function columnDragHandle(cell: HTMLElement, col: LogColumn, cols: HTMLElement): void {
  cell.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    let dragging = false;
    let before: LogColumn | null = null;
    const cells = () => [...cols.querySelectorAll<HTMLElement>("[data-column]")];
    const onMove = (ev: MouseEvent) => {
      if (!dragging && Math.abs(ev.clientX - startX) < 5) return;
      dragging = true;
      cell.classList.add("dragging");
      const next = cells().find((c) => {
        const r = c.getBoundingClientRect();
        return ev.clientX < r.left + r.width / 2;
      });
      before = next ? (next.dataset.column as LogColumn) : null;
      for (const c of cells()) c.classList.toggle("drop-before", c === next);
      cols.classList.toggle("drop-end", !next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      cell.classList.remove("dragging");
      for (const c of cells()) c.classList.remove("drop-before");
      cols.classList.remove("drop-end");
      if (dragging) applyColumns(withColumnMoved(columns, col, before));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

// One ResizeObserver at a time; disconnected when the log is re-rendered.
let resizeObserver: ResizeObserver | null = null;

// renderLog is called after most actions (checkout, commit, sidebar refresh,
// even the periodic background remote fetch) — often with the exact same
// `rows` array as last time, just to reflect an unrelated change elsewhere
// (ref chips, local-change count). Recomputing the full node/edge geometry and
// the email lookup for every loaded commit on each of those calls is wasted
// work once the log is long, so the last result is cached by `rows` identity
// (rows are always replaced wholesale, never mutated in place — see
// `state.rows = ...` in main.ts — so reference equality is a valid check) and
// pane width.
interface LayoutCache {
  rows: CommitRow[];
  hostWidth: number;
  theme: GraphTheme;
  maxLane: number;
  laneWidth: number;
  layout: ReturnType<typeof layoutGraph>;
  emailById: Map<string, string>;
}
let layoutCache: LayoutCache | null = null;

function getLayout(rows: CommitRow[], hostWidth: number, theme: GraphTheme): LayoutCache {
  const w = hostWidth || 360;
  if (layoutCache && layoutCache.rows === rows && layoutCache.hostWidth === w && layoutCache.theme === theme) {
    return layoutCache;
  }
  // Compress lanes so a repo with many parallel branches doesn't push commit
  // text off-screen. Based on the pane width available for the graph gutter,
  // which is less the ref column on the GitKraken themes.
  const maxLane = rows.reduce((m, r) => Math.max(m, r.lane), 0);
  const laneWidth = fitLaneWidth(maxLane, w - theme.metrics.originX, theme.metrics);
  layoutCache = {
    rows,
    hostWidth: w,
    theme,
    maxLane,
    laneWidth,
    layout: layoutGraph(rows, laneWidth, theme.metrics),
    emailById: new Map(rows.map((r) => [r.id, r.author_email])),
  };
  return layoutCache;
}

// Keyboard control over the rendered log. Navigation lives here rather than in
// main.ts because both things it needs are here: the rows actually on screen
// (which are the *search results* while a search is active, not state.rows) and
// the scroll container. The caller only decides what to do with the newly
// selected commit.
export interface LogHandle {
  // Move the selection `delta` rows and reveal it. Returns the newly selected
  // commit id, or null when there's nowhere to go (empty log, already at the
  // end). Repaints only the visible window — renderLog itself tears the whole
  // pane down, which is far too much for one keypress.
  moveSelection: (delta: number) => string | null;
  // Jump to the first (newest) or last (oldest loaded) row.
  selectEdge: (edge: "first" | "last") => string | null;
  // How many rows a PageUp/PageDown should move: one screen less a row of
  // overlap, so you keep your place.
  pageRows: () => number;
}

// A no-op handle, so callers don't have to null-check a log that failed to
// render (no repo open, or an empty result set).
const NO_LOG: LogHandle = {
  moveSelection: () => null,
  selectEdge: () => null,
  pageRows: () => 1,
};

export function renderLog(
  host: HTMLElement,
  rows: CommitRow[],
  selectedId: string | null,
  onSelect: (id: string) => void,
  onNeedMore?: () => void,
  refsAt?: (id: string) => RefLabels,
  onContextMenu?: (row: CommitRow, x: number, y: number) => void,
  // The multi-selection (Cmd/Shift-click), for bulk actions — separate from
  // `selectedId`, which is the one row whose diff the detail pane follows.
  // `selectedId` doubles as the shift-click range anchor: it's always the
  // last row a plain or Cmd click focused, which is exactly what a range
  // should extend from.
  multiSelected: Set<string> = new Set(),
  onMultiSelect?: (ids: Set<string>) => void,
  // The WIP row and the stash nodes belong to the history, not to a list of
  // search results.
  historyExtras = true,
): LogHandle {
  resizeObserver?.disconnect();
  host.onscroll = null;
  clear(host);
  wipLead = 0;
  repaint = null;

  if (rows.length === 0) {
    host.append(el("div", { class: "detail-empty", text: "No commits to show." }));
    return NO_LOG;
  }

  // `let`: dragging the ref column's edge in the header lays the graph out again
  // in place (see relayout), without tearing the log down.
  let theme = graphThemeFor();
  let metrics = theme.metrics;
  const laneColor = (color: number) => theme.colors[color % theme.colors.length];
  // The GitKraken themes put ref badges in their own column left of the graph,
  // with a column header above the log.
  const refsColumn = metrics.originX > 0;
  const headerH = refsColumn ? HEADER_H : 0;
  let { layout, emailById, laneWidth, maxLane } = getLayout(rows, host.clientWidth, theme);
  const rowH = metrics.rowHeight;
  let currentSelected = selectedId;
  // Read once per render: Settings redraws the log when either changes. A
  // full date needs a wider Date column than "3h ago".
  const dateFormat = loadDateFormat();
  const timeClass = `commit-meta commit-time${dateFormat === "relative" ? "" : " wide"}`;
  const columnClass = (c: LogColumn) => (c === "date" ? timeClass : COLUMN_CLASS[c]);
  const nameById = loadAuthorInitials() ? new Map(rows.map((r) => [r.id, r.author_name])) : null;
  // A local mutable copy, same pattern as `currentSelected` — updated
  // immediately so `renderWindow` reflects a click without waiting for the
  // caller to re-invoke renderLog with a fresh `multiSelected`.
  let currentMultiSelected = multiSelected;

  // The WIP row, when there is one, takes the first row slot and pushes the
  // commits down by `lead`; HEAD's row is where its dashed line ends. HEAD not
  // loaded (a detached checkout far down the log) still gets the row, in lane 0
  // with no line.
  const wipRow = historyExtras ? wip : null;
  const stashesAt = historyExtras ? stashesByBase : new Map<string, StashRef[]>();
  const headIdx = wipRow?.head ? rows.findIndex((r) => r.id === wipRow.head) : -1;
  const lead = wipRow ? rowH : 0;
  wipLead = lead;

  // A full-height spacer establishes the scrollbar; children are absolutely
  // positioned within it.
  const content = el("div", { class: "log" });
  content.style.position = "relative";
  content.style.height = `${layout.height + lead}px`;

  const graph = svg("svg", { class: "graph", width: layout.width, height: layout.height + lead });
  // Everything in the graph is laid out from row 0, so it is drawn in a group
  // shifted down past the WIP row rather than by offsetting every coordinate.
  const graphBody = svg("g", { transform: `translate(0 ${lead})` });
  const rowsLayer = el("div", { class: "rows" });
  rowsLayer.style.position = "absolute";
  rowsLayer.style.inset = "0";
  // The graph goes over the rows: on the GitKraken themes a row spans the full
  // width, under the graph, so its hover and selection colour would hide it.
  // The graph ignores the pointer, so clicks still reach the rows.
  content.append(rowsLayer, graph);

  // Column header (GitKraken themes): sticky at the top of the scrolling pane,
  // so the rows scroll under it. The cells are placed by renderWindow, because
  // where the commit message starts moves with the lanes on screen.
  const header = el("div", { class: "log-header" });
  const headRefs = el("span", { class: "log-header-cell", text: "Branch / Tag" });
  const headGraph = el("span", { class: "log-header-cell", text: "Graph" });
  const headCols = el("div", { class: "log-header-cols" });
  const grip = el("span", { class: "log-header-grip", title: "Drag to resize the branch column" });
  header.append(headRefs, headGraph, headCols, grip);
  header.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, columnsMenu());
  });
  if (refsColumn) host.append(header);

  // The optional columns in force: the repo's choice on the GitKraken themes,
  // which have the header to make it with; all of them otherwise.
  const shown = () => (refsColumn ? shownColumns(columns) : LOG_COLUMNS);

  function fillHeaderCols(): void {
    headCols.replaceChildren(el("span", { class: "commit-summary", text: "Commit message" }));
    for (const c of shown()) {
      const cell = el("span", {
        class: columnClass(c),
        "data-column": c,
        title: "Drag to move · Right-click: choose columns",
      });
      cell.append(el("span", { class: "log-header-label", text: LOG_COLUMN_LABEL[c] }));
      if (c === "author" && authorFilter) {
        const funnel = el("button", {
          class: `log-header-filter${authorFilter.active() ? " active" : ""}`,
          title: "Filter by author",
        });
        funnel.append(funnelIcon());
        // Not the start of a column drag.
        funnel.addEventListener("mousedown", (e) => e.stopPropagation());
        funnel.addEventListener("click", (e) => {
          e.stopPropagation();
          authorFilter?.open(e.clientX, e.clientY);
        });
        cell.append(funnel);
      }
      columnDragHandle(cell, c, headCols);
      headCols.append(cell);
    }
  }
  fillHeaderCols();
  host.append(content);

  function relayout(): void {
    theme = graphThemeFor();
    metrics = theme.metrics;
    ({ layout, emailById, laneWidth, maxLane } = getLayout(rows, host.clientWidth, theme));
    content.style.height = `${layout.height + lead}px`;
    graph.setAttribute("width", String(layout.width));
  }

  // Drag the ref column's right edge to resize it. The width is kept for the
  // session as the drag goes and saved when it ends.
  grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = refColumnWidth;
    const max = Math.max(REF_COLUMN_MIN, Math.min(REF_COLUMN_MAX, host.clientWidth * 0.5));
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const onMove = (ev: MouseEvent) => {
      refColumnWidth = Math.max(REF_COLUMN_MIN, Math.min(max, startW + ev.clientX - startX));
      relayout();
      renderWindow();
    };
    const stop = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stop);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      saveRefColumnWidth(refColumnWidth);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
  });

  // Where commit text starts. Sized to the lanes actually in use in the rows on
  // screen, not to `layout.width`, which is the widest point of the entire
  // loaded log: one busy stretch of history would otherwise indent every row by
  // it — measured at 220px reserved (34% of the pane) on rows needing 60px.
  // Quantised to whole lanes, so it only moves when the lane count on screen
  // genuinely changes rather than drifting with every pixel of scroll.
  function textLeftFor(start: number, end: number): number {
    let widest = 0;
    for (let i = start; i < end; i++) {
      const lane = layout.occupiedLane[i];
      if (lane > widest) widest = lane;
    }
    return metrics.originX + metrics.marginX + widest * laneWidth + metrics.marginX;
  }

  // Position a row and give it its lane colour. Shared by the commit rows and
  // the WIP row, so the two line up on every theme.
  function placeRow(rowEl: HTMLElement, y: number, nodeX: number, color: string, textLeft: number): void {
    rowEl.style.position = "absolute";
    rowEl.style.top = `${y}px`;
    rowEl.style.right = "0";
    rowEl.style.height = `${rowH}px`;
    // The lane colour is published as `--lane` so the stylesheet can tint the
    // selected row (and the GitKraken bands and badges) with its own strand
    // colour (see styles.css) rather than one flat colour for every branch.
    rowEl.style.setProperty("--lane", color);
    if (refsColumn) {
      // Full width, so the ref badges on the left are part of the row.
      rowEl.style.left = "0";
      rowEl.style.paddingLeft = `${textLeft + 12}px`;
      rowEl.classList.add("kraken");
      if (theme.bands) {
        const band = el("span", { class: "lane-band" });
        band.style.left = `${nodeX}px`;
        rowEl.append(band);
      }
    } else {
      rowEl.style.left = `${textLeft}px`;
      // Lane-colored bar tying the message to its commit's graph strand/avatar.
      rowEl.style.borderLeft = `3px solid ${color}`;
    }
  }

  // The WIP row and its node: a dashed hollow circle in HEAD's lane, joined to
  // HEAD's node by a dashed line. Drawn in graph coordinates, one row above row 0.
  function renderWip(textLeft: number, changes: number): void {
    const head = headIdx >= 0 ? layout.nodes[headIdx] : null;
    const x = head?.x ?? metrics.originX + metrics.marginX;
    const y = -rowH / 2;
    const color = laneColor(head?.color ?? 0);

    const rowEl = el("div", { class: "commit-row wip-row", title: "Uncommitted changes · Click: open Local Changes" });
    placeRow(rowEl, 0, x, color, textLeft);
    rowEl.append(
      el("span", { class: "commit-summary", text: "// WIP" }),
      el("span", { class: "commit-meta wip-count", text: `${changes} changed file${changes === 1 ? "" : "s"}` }),
    );
    rowEl.addEventListener("click", () => onOpenWip?.());
    rowsLayer.append(rowEl);

    if (head) {
      graphBody.append(
        svg("line", { class: "wip-edge", x1: x, y1: y, x2: x, y2: head.y, stroke: color, "stroke-width": theme.strokeWidth }),
      );
    }
    graphBody.append(
      svg("circle", { class: "wip-node", cx: x, cy: y, r: theme.nodeRadius - 1, stroke: color, "stroke-width": 2 }),
    );
  }

  function renderWindow(): void {
    const viewH = host.clientHeight || 600;
    // In graph coordinates, i.e. measured from row 0 below the WIP row.
    const scrollTop = host.scrollTop - lead;
    const start = Math.max(0, Math.floor(scrollTop / rowH) - BUFFER_ROWS);
    const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / rowH) + BUFFER_ROWS);
    const textLeft = textLeftFor(start, end);
    const top = start * rowH;
    const bottom = end * rowH;

    // Ask for more rows once the viewport nears the end of what's loaded.
    if (onNeedMore && scrollTop + viewH >= layout.height - rowH * 20) {
      onNeedMore();
    }

    if (refsColumn) {
      headRefs.style.width = `${metrics.originX - 16}px`;
      headGraph.style.left = `${metrics.originX + 8}px`;
      headGraph.style.width = `${Math.max(0, textLeft - metrics.originX - 8)}px`;
      grip.style.left = `${metrics.originX - 3}px`;
      headCols.style.left = `${textLeft}px`;
    }

    const cols = shown();
    clear(rowsLayer);
    for (let i = start; i < end; i++) {
      const row = rows[i];
      const rowEl = el("div", {
        class: `commit-row${row.id === currentSelected ? " selected" : ""}${currentMultiSelected.has(row.id) ? " multi-selected" : ""}${row.id === bisectCurrent ? " bisect-current" : ""}${highlight && !highlight(row.id) ? " faded" : ""}`,
      });
      placeRow(rowEl, i * rowH + lead, layout.nodes[i].x, laneColor(row.color), textLeft);
      const mark = bisectMarks.get(row.id);
      if (mark) rowEl.append(el("span", { class: `bisect-mark ${mark}`, text: BISECT_MARK_LABEL[mark] }));
      else if (row.id === bisectCurrent) rowEl.append(el("span", { class: "bisect-mark testing", text: "testing" }));
      const stashes = stashesAt.get(row.id);
      if (stashes) for (const st of stashes.slice(0, MAX_REF_CHIPS)) rowEl.append(stashChip(st));
      rowEl.append(el("span", { class: "commit-summary", text: row.summary }));

      // Ref chips (branch/tag/remote pointing at this commit) — placed after the
      // summary, always shown, colored per kind. Tags carry a tag glyph. Capped
      // so a heavily-tagged commit can't crowd out the row.
      const refs = refsAt?.(row.id);
      if (refsColumn && refs?.tips?.length) {
        // The ref column only labels the commits refs point at, as GitKraken
        // does, and has room for one badge; the rest go into "+N".
        const box = el("span", { class: "commit-refs refs-col" });
        box.style.width = `${metrics.originX - 16}px`;
        box.append(tipBadge(refs.tips[0]));
        if (refs.tips.length > 1) box.append(moreBadge(row.id, refs.tips.length - 1));
        rowEl.append(box);
      } else if (refsColumn) {
        const ghost = ghostBranch(refs);
        if (ghost) {
          const box = el("span", { class: "commit-refs refs-col" });
          box.style.width = `${metrics.originX - 16}px`;
          box.append(ghostBadge(ghost));
          rowEl.append(box);
        }
      } else if (refs && refs.labels.length) {
        const box = el("span", { class: "commit-refs" });
        for (const r of refs.labels.slice(0, MAX_REF_CHIPS)) {
          const chip = el("span", {
            class: `commit-ref ${r.kind}`,
            title: r.kind === "tag" ? tagTitle(r.name, r.message) : r.name,
          });
          if (r.kind === "tag") chip.append(tagIcon());
          else if (r.kind === "remote") chip.append(githubIcon());
          chip.append(el("span", { class: "commit-ref-name", text: r.kind === "head" ? `✓ ${r.name}` : r.name }));
          if (r.kind !== "tag") refDragHandle(chip, { kind: r.kind === "remote" ? "remote" : "local", name: r.name });
          box.append(chip);
        }
        if (refs.total > MAX_REF_CHIPS) box.append(moreBadge(row.id, refs.total - MAX_REF_CHIPS));
        rowEl.append(box);
      }

      for (const c of cols) {
        const cell = el("span", { class: columnClass(c), text: COLUMN_TEXT[c](row, dateFormat) });
        if (c === "date") cell.title = fullTime(row.time);
        rowEl.append(cell);
      }
      rowEl.addEventListener("click", (e) => {
        if (onMultiSelect && e.shiftKey) {
          // Range from the anchor (the last plain/Cmd-clicked row) to here,
          // replacing any prior selection — standard Shift-click semantics.
          const anchorIdx = rows.findIndex((r) => r.id === currentSelected);
          const [from, to] = anchorIdx < 0 ? [i, i] : [Math.min(anchorIdx, i), Math.max(anchorIdx, i)];
          currentMultiSelected = new Set(rows.slice(from, to + 1).map((r) => r.id));
          onMultiSelect(currentMultiSelected);
        } else if (onMultiSelect && (e.metaKey || e.ctrlKey)) {
          // The first Cmd-click after a plain click starts from just the
          // anchor, not an empty set — otherwise "click A, Cmd-click B" would
          // select only B instead of both.
          const base = currentMultiSelected.size ? currentMultiSelected : new Set(currentSelected ? [currentSelected] : []);
          currentMultiSelected = new Set(base);
          if (currentMultiSelected.has(row.id)) currentMultiSelected.delete(row.id);
          else currentMultiSelected.add(row.id);
          onMultiSelect(currentMultiSelected);
        } else if (onMultiSelect && currentMultiSelected.size) {
          currentMultiSelected = new Set(); // plain click elsewhere clears a multi-selection
          onMultiSelect(currentMultiSelected);
        }
        currentSelected = row.id;
        renderWindow();
        onSelect(row.id);
      });
      if (onContextMenu) {
        rowEl.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          // Right-click inside the current multi-selection opens a bulk menu on
          // it as-is; right-click elsewhere collapses to just this row first —
          // same rule Local Changes uses for its file checkboxes.
          if (!currentMultiSelected.has(row.id)) {
            if (onMultiSelect && currentMultiSelected.size) {
              currentMultiSelected = new Set();
              onMultiSelect(currentMultiSelected);
            }
            currentSelected = row.id;
            renderWindow();
            onSelect(row.id);
          }
          onContextMenu(row, e.clientX, e.clientY);
        });
      }
      rowsLayer.append(rowEl);
    }

    clear(graph);
    clear(graphBody);
    // One reusable circular clip (object-bounding-box units) for all avatars.
    const defs = svg("defs");
    const clip = svg("clipPath", { id: "avatarClip", clipPathUnits: "objectBoundingBox" });
    clip.appendChild(svg("circle", { cx: 0.5, cy: 0.5, r: 0.5 }));
    defs.appendChild(clip);
    graph.append(defs, graphBody);
    // While a branch is hovered, what isn't on it is drawn into this group,
    // which the stylesheet fades. Under everything else, so the branch's own
    // lines run over the faded ones.
    const faded = svg("g", { class: "graph-faded" });
    // The WIP row is on screen whenever the first rows are.
    const wipShown = wipRow !== null && start === 0;
    if (theme.guides) {
      for (let lane = 0; lane <= maxLane; lane++) {
        const x = metrics.originX + metrics.marginX + lane * laneWidth;
        graphBody.append(svg("line", { class: "lane-guide", x1: x, y1: wipShown ? -lead : top, x2: x, y2: bottom }));
      }
    }
    if (wipShown) renderWip(textLeft, wipRow.changes);
    graphBody.append(faded);
    for (const edge of visibleEdges(layout, top, bottom)) {
      // An edge belongs to the commit it leaves, the row its fromY is in.
      const from = rows[Math.floor(edge.fromY / rowH)];
      (highlight && !highlight(from.id) ? faded : graphBody).append(
        svg("path", {
          d: edgePath(edge, metrics),
          fill: "none",
          stroke: laneColor(edge.color),
          "stroke-width": theme.strokeWidth,
          "stroke-linecap": "round",
        }),
      );
    }
    // Node i is row i, so the window's nodes are rows start..end.
    for (const node of layout.nodes.slice(start, end)) {
      const color = laneColor(node.color);
      const isSelected = node.id === currentSelected;
      const r = theme.nodeRadius;
      const layer = highlight && !highlight(node.id) ? faded : graphBody;

      // GitKraken themes: a line from the commit's ref badges across to its node.
      if (refsColumn && refsAt?.(node.id).tips?.length) {
        layer.append(
          svg("line", {
            x1: metrics.originX - 6,
            y1: node.y,
            x2: node.x,
            y2: node.y,
            stroke: color,
            "stroke-width": 1.5,
            opacity: 0.6,
          }),
        );
      }

      // Stashes taken on this commit: a dashed line from its node to their
      // chips at the start of the message.
      if (stashesAt.has(node.id)) {
        layer.append(
          svg("line", { class: "stash-edge", x1: node.x, y1: node.y, x2: textLeft, y2: node.y, stroke: color, "stroke-width": 1.5 }),
        );
      }

      // Selected commit: a leader line from its node across the rest of the
      // graph gutter to where its message row begins, so the eye can follow a
      // node on a deeply-nested lane to the text that belongs to it. Drawn
      // first so the avatar sits on top of it.
      //
      // It has to stop at `textLeft`, not at `layout.width`: those were the same
      // thing while every row was indented to the widest point of the whole log,
      // but the text now starts at the lanes actually on screen, and a line
      // drawn to the old width runs straight through the message like a
      // strikethrough.
      if (isSelected) {
        layer.append(
          svg("line", {
            x1: node.x,
            y1: node.y,
            x2: textLeft,
            y2: node.y,
            stroke: color,
            "stroke-width": 2,
          }),
        );
      }

      // Base dot: the whole node on Neon, otherwise the fallback if the avatar
      // image is missing/fails to load.
      layer.append(svg("circle", { cx: node.x, cy: node.y, r, fill: color }));

      const url = theme.node === "avatar" && !nameById ? avatarUrl(emailById.get(node.id) ?? "") : undefined;
      if (theme.node === "dot") {
        // An inner ring in the background colour, so the dot reads as a bead
        // on the line rather than a blob.
        layer.append(svg("circle", { class: "node-inner", cx: node.x, cy: node.y, r: r - 2.5, fill: "none", "stroke-width": 1.5 }));
      } else if (nameById) {
        // Settings → Appearance: the author's initials on the lane colour.
        const text = svg("text", { class: "node-initials", x: node.x, y: node.y, "font-size": Math.round(r * 0.85) });
        text.textContent = authorInitials(nameById.get(node.id) ?? "");
        layer.append(text);
      } else if (url) {
        const img = svg("image", {
          x: node.x - r,
          y: node.y - r,
          width: r * 2,
          height: r * 2,
          href: url,
          preserveAspectRatio: "xMidYMid slice",
          "clip-path": "url(#avatarClip)",
        });
        img.addEventListener("error", () => img.remove());
        layer.append(img);
      }

      // Lane-colored ring around the avatar, thickened on the selected commit.
      if (theme.node === "avatar") {
        layer.append(
          svg("circle", {
            cx: node.x,
            cy: node.y,
            r,
            fill: "none",
            stroke: color,
            "stroke-width": isSelected ? 3 : 2,
          }),
        );
      }
      // …plus a soft outer halo, so the active commit is findable at a glance
      // on a graph where every lane already has its own colour.
      if (isSelected) {
        layer.append(
          svg("circle", {
            cx: node.x,
            cy: node.y,
            r: r + 3.5,
            fill: "none",
            stroke: color,
            "stroke-width": 2,
            opacity: 0.45,
          }),
        );
      }
    }
  }

  // Scroll `index` just into view, keeping a couple of rows of context on the
  // leading side. Deliberately minimal: centring the row on every keypress (as
  // the jump-to-commit path does, where it's a one-off) would make the graph
  // lurch under a held arrow key.
  function reveal(index: number): void {
    const top = index * rowH + lead;
    const margin = rowH * 2;
    // The sticky header covers the top of the pane, so less of it shows rows.
    const viewH = (host.clientHeight || 600) - headerH;
    if (top - margin < host.scrollTop) {
      host.scrollTop = Math.max(0, top - margin);
    } else if (top + rowH + margin > host.scrollTop + viewH) {
      host.scrollTop = top + rowH + margin - viewH;
    }
  }

  // Select the row at `index` (clamped), repaint, reveal it, and report the id.
  function selectIndex(index: number): string | null {
    const clamped = Math.max(0, Math.min(rows.length - 1, index));
    const row = rows[clamped];
    if (!row) return null;
    currentSelected = row.id;
    // A keyboard move is a plain selection, so it collapses any multi-selection
    // the same way a plain click does.
    if (onMultiSelect && currentMultiSelected.size) {
      currentMultiSelected = new Set();
      onMultiSelect(currentMultiSelected);
    }
    reveal(clamped);
    renderWindow(); // after reveal, so the scroll's own renderWindow can't win
    return row.id;
  }

  const handle: LogHandle = {
    moveSelection: (delta) => {
      const idx = rows.findIndex((r) => r.id === currentSelected);
      // Nothing selected yet: the first key press lands on the newest commit
      // rather than jumping a screen away from it.
      if (idx < 0) return selectIndex(0);
      // Clamp rather than refuse: a PageDown near the bottom should land on the
      // last row, the way it does in any list, not do nothing because a whole
      // screen doesn't fit. A single step already at the end still moves
      // nowhere, since the clamp leaves the index alone.
      const next = Math.max(0, Math.min(rows.length - 1, idx + delta));
      if (next === idx) {
        // Nowhere to go. Still reveal, so a held key doesn't look stuck when
        // the selected row is scrolled out of sight.
        reveal(idx);
        return null;
      }
      return selectIndex(next);
    },
    selectEdge: (edge) => selectIndex(edge === "first" ? 0 : rows.length - 1),
    pageRows: () => Math.max(1, Math.floor(((host.clientHeight || 600) - headerH) / rowH) - 1),
  };

  host.onscroll = renderWindow;
  repaint = (columnsChanged) => {
    if (columnsChanged) fillHeaderCols();
    renderWindow();
  };
  resizeObserver = new ResizeObserver(() => renderWindow());
  resizeObserver.observe(host);
  renderWindow();
  return handle;
}
