// Commit-graph log: an SVG lane graph aligned to a list of commit rows.
//
// Virtualized: only the rows/graph within the scroll viewport (plus a small
// buffer) are in the DOM, so a repo with 100k commits stays responsive. The
// full geometry is computed once (cheap math); only rendering is windowed.

import { avatarUrl } from "../avatar";
import { clear, el, githubIcon, svg, tagIcon } from "../dom";
import { edgePath, fitLaneWidth, GRAPH_METRICS, layoutGraph } from "../graph";
import { relativeTime } from "../timeago";
import type { CommitRow } from "../types";

const AVATAR_R = 9;

// A ref pointing at a commit, shown as a colored chip on hover.
export interface RefLabel {
  name: string;
  kind: "head" | "branch" | "remote" | "tag";
}

const LANE_COLORS = [
  "#5b8cff",
  "#f0883e",
  "#7ee787",
  "#d2a8ff",
  "#ff9a94",
  "#79c0ff",
  "#e3b341",
  "#ff7b72",
];

const BUFFER_ROWS = 8;
const MAX_REF_CHIPS = 3;

function laneColor(color: number): string {
  return LANE_COLORS[color % LANE_COLORS.length];
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
  laneWidth: number;
  layout: ReturnType<typeof layoutGraph>;
  emailById: Map<string, string>;
}
let layoutCache: LayoutCache | null = null;

function getLayout(rows: CommitRow[], hostWidth: number): LayoutCache {
  const w = hostWidth || 360;
  if (layoutCache && layoutCache.rows === rows && layoutCache.hostWidth === w) return layoutCache;
  // Compress lanes so a repo with many parallel branches doesn't push commit
  // text off-screen. Based on the pane width available for the graph gutter.
  const maxLane = rows.reduce((m, r) => Math.max(m, r.lane), 0);
  const laneWidth = fitLaneWidth(maxLane, w);
  layoutCache = {
    rows,
    hostWidth: w,
    laneWidth,
    layout: layoutGraph(rows, laneWidth),
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
  refsAt?: (id: string) => RefLabel[],
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

  const { layout, emailById } = getLayout(rows, host.clientWidth);
  const rowH = GRAPH_METRICS.rowHeight;
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
  content.append(graph, rowsLayer);
  host.append(content);

  function renderWindow(): void {
    const viewH = host.clientHeight || 600;
    const scrollTop = host.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / rowH) - BUFFER_ROWS);
    const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / rowH) + BUFFER_ROWS);
    const top = start * rowH;
    const bottom = end * rowH;

    // Ask for more rows once the viewport nears the end of what's loaded.
    if (onNeedMore && scrollTop + viewH >= layout.height - rowH * 20) {
      onNeedMore();
    }

    clear(rowsLayer);
    for (let i = start; i < end; i++) {
      const row = rows[i];
      const rowEl = el("div", {
        class: `commit-row${row.id === currentSelected ? " selected" : ""}${currentMultiSelected.has(row.id) ? " multi-selected" : ""}`,
      });
      rowEl.style.position = "absolute";
      rowEl.style.top = `${i * rowH}px`;
      rowEl.style.left = `${layout.width}px`;
      rowEl.style.right = "0";
      rowEl.style.height = `${rowH}px`;
      // Lane-colored bar tying the message to its commit's graph strand/avatar.
      // The same colour is published as `--lane` so the stylesheet can tint the
      // selected row's background with its own strand colour (see styles.css)
      // rather than one flat selection colour for every branch.
      rowEl.style.setProperty("--lane", laneColor(row.color));
      rowEl.style.borderLeft = `3px solid ${laneColor(row.color)}`;
      rowEl.append(el("span", { class: "commit-summary", text: row.summary }));

      // Ref chips (branch/tag/remote pointing at this commit) — placed after the
      // summary, always shown, colored per kind. Tags carry a tag glyph. Capped
      // so a heavily-tagged commit can't crowd out the row.
      const refs = refsAt?.(row.id) ?? [];
      if (refs.length) {
        const box = el("span", { class: "commit-refs" });
        for (const r of refs.slice(0, MAX_REF_CHIPS)) {
          const chip = el("span", { class: `commit-ref ${r.kind}`, title: r.name });
          if (r.kind === "tag") chip.append(tagIcon());
          else if (r.kind === "remote") chip.append(githubIcon());
          chip.append(el("span", { class: "commit-ref-name", text: r.kind === "head" ? `✓ ${r.name}` : r.name }));
          box.append(chip);
        }
        if (refs.length > MAX_REF_CHIPS) {
          box.append(el("span", { class: "commit-ref more", text: `+${refs.length - MAX_REF_CHIPS}` }));
        }
        rowEl.append(box);
      }

      rowEl.append(
        el("span", { class: "commit-meta", text: row.author_name }),
        el("span", { class: "commit-meta", text: relativeTime(row.time) }),
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
          d: edgePath(edge),
          fill: "none",
          stroke: laneColor(edge.color),
          "stroke-width": 2,
          "stroke-linecap": "round",
        }),
      );
    }
    for (const node of layout.nodes) {
      if (node.y < top || node.y > bottom) continue;
      const color = laneColor(node.color);
      const isSelected = node.id === currentSelected;

      // Selected commit: a leader line from its node across the rest of the
      // graph gutter to where its message row begins, so the eye can follow a
      // node on a deeply-nested lane to the text that belongs to it. Drawn
      // first so the avatar sits on top of it.
      if (isSelected) {
        graph.append(
          svg("line", {
            x1: node.x,
            y1: node.y,
            x2: layout.width,
            y2: node.y,
            stroke: color,
            "stroke-width": 2,
          }),
        );
      }

      // Base dot: the fallback if the avatar image is missing/fails to load.
      graph.append(svg("circle", { cx: node.x, cy: node.y, r: AVATAR_R, fill: color }));

      const url = avatarUrl(emailById.get(node.id) ?? "");
      if (url) {
        const img = svg("image", {
          x: node.x - AVATAR_R,
          y: node.y - AVATAR_R,
          width: AVATAR_R * 2,
          height: AVATAR_R * 2,
          href: url,
          preserveAspectRatio: "xMidYMid slice",
          "clip-path": "url(#avatarClip)",
        });
        img.addEventListener("error", () => img.remove());
        graph.append(img);
      }

      // Lane-colored ring around the avatar, thickened on the selected commit.
      graph.append(
        svg("circle", {
          cx: node.x,
          cy: node.y,
          r: AVATAR_R,
          fill: "none",
          stroke: color,
          "stroke-width": isSelected ? 3 : 2,
        }),
      );
      // …plus a soft outer halo, so the active commit is findable at a glance
      // on a graph where every lane already has its own colour.
      if (isSelected) {
        graph.append(
          svg("circle", {
            cx: node.x,
            cy: node.y,
            r: AVATAR_R + 3.5,
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
    const viewH = host.clientHeight || 600;
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
    pageRows: () => Math.max(1, Math.floor((host.clientHeight || 600) / rowH) - 1),
  };

  host.onscroll = renderWindow;
  resizeObserver = new ResizeObserver(() => renderWindow());
  resizeObserver.observe(host);
  renderWindow();
  return handle;
}
