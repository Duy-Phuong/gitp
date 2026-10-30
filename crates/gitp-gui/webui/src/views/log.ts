// Commit-graph log: an SVG lane graph aligned to a list of commit rows.
//
// Virtualized: only the rows/graph within the scroll viewport (plus a small
// buffer) are in the DOM, so a repo with 100k commits stays responsive. The
// full geometry is computed once (cheap math); only rendering is windowed.

import { avatarUrl } from "../avatar";
import { clear, el, githubIcon, laptopIcon, svg, tagIcon } from "../dom";
import { edgePath, fitLaneWidth, GRAPH_METRICS, type GraphMetrics, layoutGraph } from "../graph";
import { loadRefColumnWidth, REF_COLUMN_DEFAULT, saveRefColumnWidth } from "../prefs";
import { relativeTime } from "../timeago";
import type { BisectStatus, CommitRow } from "../types";

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
}

export interface RefLabel {
  name: string;
  kind: "head" | "branch" | "remote" | "tag";
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

// Row height of the graph in force, for callers that scroll to a row.
export function logRowHeight(): number {
  return graphThemeFor().metrics.rowHeight;
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
    title: t.kind === "tag" ? `tag ${t.name}` : `${t.name} (${where})`,
  });
  if (t.kind === "tag") chip.append(tagIcon());
  chip.append(el("span", { class: "commit-ref-name", text: t.head ? `✓ ${t.name}` : t.name }));
  if (t.local) chip.append(laptopIcon());
  for (let k = 0; k < t.remotes.length; k++) chip.append(githubIcon());
  return chip;
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
): LogHandle {
  resizeObserver?.disconnect();
  host.onscroll = null;
  clear(host);

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
  // A local mutable copy, same pattern as `currentSelected` — updated
  // immediately so `renderWindow` reflects a click without waiting for the
  // caller to re-invoke renderLog with a fresh `multiSelected`.
  let currentMultiSelected = multiSelected;

  // A full-height spacer establishes the scrollbar; children are absolutely
  // positioned within it.
  const content = el("div", { class: "log" });
  content.style.position = "relative";
  content.style.height = `${layout.height}px`;

  const graph = svg("svg", { class: "graph", width: layout.width, height: layout.height });
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
  const headCols = el("div", { class: "log-header-cols" }, [
    el("span", { class: "commit-summary", text: "Commit message" }),
    el("span", { class: "commit-meta commit-author", text: "Author" }),
    el("span", { class: "commit-meta commit-time", text: "Date" }),
    el("span", { class: "commit-sha", text: "SHA" }),
  ]);
  const grip = el("span", { class: "log-header-grip", title: "Drag to resize the branch column" });
  header.append(headRefs, headGraph, headCols, grip);
  if (refsColumn) host.append(header);
  host.append(content);

  function relayout(): void {
    theme = graphThemeFor();
    metrics = theme.metrics;
    ({ layout, emailById, laneWidth, maxLane } = getLayout(rows, host.clientWidth, theme));
    content.style.height = `${layout.height}px`;
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

  function renderWindow(): void {
    const viewH = host.clientHeight || 600;
    const scrollTop = host.scrollTop;
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

    clear(rowsLayer);
    for (let i = start; i < end; i++) {
      const row = rows[i];
      const rowEl = el("div", {
        class: `commit-row${row.id === currentSelected ? " selected" : ""}${currentMultiSelected.has(row.id) ? " multi-selected" : ""}${row.id === bisectCurrent ? " bisect-current" : ""}`,
      });
      rowEl.style.position = "absolute";
      rowEl.style.top = `${i * rowH}px`;
      rowEl.style.right = "0";
      rowEl.style.height = `${rowH}px`;
      // The lane colour is published as `--lane` so the stylesheet can tint the
      // selected row (and the GitKraken bands and badges) with its own strand
      // colour (see styles.css) rather than one flat colour for every branch.
      rowEl.style.setProperty("--lane", laneColor(row.color));
      if (refsColumn) {
        // Full width, so the ref badges on the left are part of the row.
        rowEl.style.left = "0";
        rowEl.style.paddingLeft = `${textLeft + 12}px`;
        rowEl.classList.add("kraken");
        if (theme.bands) {
          const band = el("span", { class: "lane-band" });
          band.style.left = `${layout.nodes[i].x}px`;
          rowEl.append(band);
        }
      } else {
        rowEl.style.left = `${textLeft}px`;
        // Lane-colored bar tying the message to its commit's graph strand/avatar.
        rowEl.style.borderLeft = `3px solid ${laneColor(row.color)}`;
      }
      const mark = bisectMarks.get(row.id);
      if (mark) rowEl.append(el("span", { class: `bisect-mark ${mark}`, text: BISECT_MARK_LABEL[mark] }));
      else if (row.id === bisectCurrent) rowEl.append(el("span", { class: "bisect-mark testing", text: "testing" }));
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
      } else if (!refsColumn && refs && refs.labels.length) {
        const box = el("span", { class: "commit-refs" });
        for (const r of refs.labels.slice(0, MAX_REF_CHIPS)) {
          const chip = el("span", { class: `commit-ref ${r.kind}`, title: r.name });
          if (r.kind === "tag") chip.append(tagIcon());
          else if (r.kind === "remote") chip.append(githubIcon());
          chip.append(el("span", { class: "commit-ref-name", text: r.kind === "head" ? `✓ ${r.name}` : r.name }));
          box.append(chip);
        }
        if (refs.total > MAX_REF_CHIPS) box.append(moreBadge(row.id, refs.total - MAX_REF_CHIPS));
        rowEl.append(box);
      }

      rowEl.append(
        el("span", { class: "commit-meta commit-author", text: row.author_name }),
        el("span", { class: "commit-meta commit-time", text: relativeTime(row.time) }),
        el("span", { class: "commit-sha", text: row.short_id }),
      );
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
    if (theme.guides) {
      for (let lane = 0; lane <= maxLane; lane++) {
        const x = metrics.originX + metrics.marginX + lane * laneWidth;
        graph.append(svg("line", { class: "lane-guide", x1: x, y1: top, x2: x, y2: bottom }));
      }
    }
    // One reusable circular clip (object-bounding-box units) for all avatars.
    const defs = svg("defs");
    const clip = svg("clipPath", { id: "avatarClip", clipPathUnits: "objectBoundingBox" });
    clip.appendChild(svg("circle", { cx: 0.5, cy: 0.5, r: 0.5 }));
    defs.appendChild(clip);
    graph.appendChild(defs);
    for (const edge of layout.edges) {
      if (Math.max(edge.fromY, edge.toY) < top || Math.min(edge.fromY, edge.toY) > bottom) {
        continue;
      }
      graph.append(
        svg("path", {
          d: edgePath(edge, metrics),
          fill: "none",
          stroke: laneColor(edge.color),
          "stroke-width": theme.strokeWidth,
          "stroke-linecap": "round",
        }),
      );
    }
    for (const node of layout.nodes) {
      if (node.y < top || node.y > bottom) continue;
      const color = laneColor(node.color);
      const isSelected = node.id === currentSelected;
      const r = theme.nodeRadius;

      // GitKraken themes: a line from the commit's ref badges across to its node.
      if (refsColumn && refsAt?.(node.id).tips?.length) {
        graph.append(
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
        graph.append(
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
      graph.append(svg("circle", { cx: node.x, cy: node.y, r, fill: color }));

      const url = theme.node === "avatar" ? avatarUrl(emailById.get(node.id) ?? "") : undefined;
      if (theme.node === "dot") {
        // An inner ring in the background colour, so the dot reads as a bead
        // on the line rather than a blob.
        graph.append(svg("circle", { class: "node-inner", cx: node.x, cy: node.y, r: r - 2.5, fill: "none", "stroke-width": 1.5 }));
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
        graph.append(img);
      }

      // Lane-colored ring around the avatar, thickened on the selected commit.
      if (theme.node === "avatar") {
        graph.append(
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
        graph.append(
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
    const top = index * rowH;
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
  resizeObserver = new ResizeObserver(() => renderWindow());
  resizeObserver.observe(host);
  renderWindow();
  return handle;
}
