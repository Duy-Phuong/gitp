// Commit-graph log: an SVG lane graph aligned to a list of commit rows.

import { clear, el, svg } from "../dom";
import { GRAPH_METRICS, layoutGraph } from "../graph";
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

export function renderLog(
  host: HTMLElement,
  rows: CommitRow[],
  selectedId: string | null,
  onSelect: (id: string) => void,
): void {
  clear(host);
  if (rows.length === 0) {
    host.append(el("div", { class: "detail-empty", text: "No commits to show." }));
    return;
  }

  const layout = layoutGraph(rows);
  const wrap = el("div", { class: "log" });

  const graph = svg("svg", {
    class: "graph",
    width: layout.width,
    height: layout.height,
  });
  for (const edge of layout.edges) {
    // A vertical drop then a curve into the parent lane reads cleanly.
    const midY = (edge.fromY + edge.toY) / 2;
    const path = svg("path", {
      d: `M ${edge.fromX} ${edge.fromY} C ${edge.fromX} ${midY}, ${edge.toX} ${midY}, ${edge.toX} ${edge.toY}`,
      fill: "none",
      stroke: laneColor(edge.color),
      "stroke-width": 2,
    });
    graph.append(path);
  }
  for (const node of layout.nodes) {
    const dot = svg("circle", {
      cx: node.x,
      cy: node.y,
      r: 4.5,
      fill: laneColor(node.color),
      stroke: "var(--bg)",
      "stroke-width": 2,
    });
    graph.append(dot);
  }
  wrap.append(graph);

  const list = el("div", { class: "rows" });
  list.style.marginLeft = `${layout.width}px`;
  for (const row of rows) {
    const rowEl = el("div", {
      class: `commit-row${row.id === selectedId ? " selected" : ""}`,
    });
    rowEl.style.height = `${GRAPH_METRICS.rowHeight}px`;
    rowEl.append(
      el("span", { class: "commit-summary", text: row.summary }),
      el("span", { class: "commit-meta", text: row.author_name }),
      el("span", { class: "commit-meta", text: relativeTime(row.time) }),
      el("span", { class: "commit-sha", text: row.short_id }),
    );
    rowEl.addEventListener("click", () => onSelect(row.id));
    list.append(rowEl);
  }
  wrap.append(list);
  host.append(wrap);
}
