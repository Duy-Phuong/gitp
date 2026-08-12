// Commit-graph log: an SVG lane graph aligned to a list of commit rows.
//
// Virtualized: only the rows/graph within the scroll viewport (plus a small
// buffer) are in the DOM, so a repo with 100k commits stays responsive. The
// full geometry is computed once (cheap math); only rendering is windowed.

import { clear, el, svg } from "../dom";
import { fitLaneWidth, GRAPH_METRICS, layoutGraph } from "../graph";
import type { CommitRow } from "../types";

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

function laneColor(color: number): string {
  return LANE_COLORS[color % LANE_COLORS.length];
}

function relativeTime(unixSeconds: number): string {
  const secondsAgo = Math.floor(Date.now() / 1000) - unixSeconds;
  const units: [number, string][] = [
    [31536000, "y"],
    [2592000, "mo"],
    [604800, "w"],
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
  ];
  for (const [size, label] of units) {
    if (secondsAgo >= size) return `${Math.floor(secondsAgo / size)}${label} ago`;
  }
  return "just now";
}

// One ResizeObserver at a time; disconnected when the log is re-rendered.
let resizeObserver: ResizeObserver | null = null;

export function renderLog(
  host: HTMLElement,
  rows: CommitRow[],
  selectedId: string | null,
  onSelect: (id: string) => void,
): void {
  resizeObserver?.disconnect();
  host.onscroll = null;
  clear(host);

  if (rows.length === 0) {
    host.append(el("div", { class: "detail-empty", text: "No commits to show." }));
    return;
  }

  // Compress lanes so a repo with many parallel branches doesn't push commit
  // text off-screen. Based on the pane width available for the graph gutter.
  const maxLane = rows.reduce((m, r) => Math.max(m, r.lane), 0);
  const laneWidth = fitLaneWidth(maxLane, host.clientWidth || 360);
  const nodeRadius = Math.max(2.5, Math.min(4.5, laneWidth * 0.42));

  const layout = layoutGraph(rows, laneWidth);
  const rowH = GRAPH_METRICS.rowHeight;
  let currentSelected = selectedId;

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

    clear(rowsLayer);
    for (let i = start; i < end; i++) {
      const row = rows[i];
      const rowEl = el("div", {
        class: `commit-row${row.id === currentSelected ? " selected" : ""}`,
      });
      rowEl.style.position = "absolute";
      rowEl.style.top = `${i * rowH}px`;
      rowEl.style.left = `${layout.width}px`;
      rowEl.style.right = "0";
      rowEl.style.height = `${rowH}px`;
      rowEl.append(
        el("span", { class: "commit-summary", text: row.summary }),
        el("span", { class: "commit-meta", text: row.author_name }),
        el("span", { class: "commit-meta", text: relativeTime(row.time) }),
        el("span", { class: "commit-sha", text: row.short_id }),
      );
      rowEl.addEventListener("click", () => {
        currentSelected = row.id;
        renderWindow();
        onSelect(row.id);
      });
      rowsLayer.append(rowEl);
    }

    clear(graph);
    for (const edge of layout.edges) {
      if (Math.max(edge.fromY, edge.toY) < top || Math.min(edge.fromY, edge.toY) > bottom) {
        continue;
      }
      const midY = (edge.fromY + edge.toY) / 2;
      graph.append(
        svg("path", {
          d: `M ${edge.fromX} ${edge.fromY} C ${edge.fromX} ${midY}, ${edge.toX} ${midY}, ${edge.toX} ${edge.toY}`,
          fill: "none",
          stroke: laneColor(edge.color),
          "stroke-width": 2,
        }),
      );
    }
    for (const node of layout.nodes) {
      if (node.y < top || node.y > bottom) continue;
      graph.append(
        svg("circle", {
          cx: node.x,
          cy: node.y,
          r: nodeRadius,
          fill: laneColor(node.color),
          stroke: "var(--bg)",
          "stroke-width": 2,
        }),
      );
    }
  }

  host.onscroll = renderWindow;
  resizeObserver = new ResizeObserver(() => renderWindow());
  resizeObserver.observe(host);
  renderWindow();
}
