// Pure geometry: turn lane-assigned CommitRows into node/edge coordinates for
// SVG rendering. No DOM, no side effects — unit-tested in graph.test.ts.

import type { CommitRow } from "./types";

export interface GraphMetrics {
  laneWidth: number;
  rowHeight: number;
  marginX: number;
  /// Radius of the rounded right-angle corners where an edge changes lane.
  cornerRadius: number;
  /// Where lane 0 starts: 0, or the width of the ref-badge column that the
  /// GitKraken themes draw to the left of the graph.
  originX: number;
  /// How an edge changes lane: a right angle with a rounded corner, or a
  /// smooth S-curve.
  curve: "corner" | "bezier";
}

export const GRAPH_METRICS: GraphMetrics = {
  laneWidth: 16,
  rowHeight: 28,
  marginX: 14,
  cornerRadius: 7,
  originX: 0,
  curve: "corner",
};

export interface GraphNode {
  id: string;
  x: number;
  y: number;
  color: number;
}

export interface GraphEdge {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  color: number;
  /// True when this is a link to a merge parent (any parent but the first).
  ///
  /// Decides which end of the edge the corner sits at, which is what makes the
  /// graph readable: a merge line leaves its commit sideways straight away and
  /// then runs down the parent's lane, whereas a branch that ends runs down its
  /// own lane and only turns in at the very bottom, next to the parent.
  merge: boolean;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
  /// Rightmost lane in use at each row: its own node, plus any edge passing
  /// through it on the way to a parent further down.
  ///
  /// `width` is the widest point of the *whole* log, so sizing the commit-text
  /// gutter from it means one busy stretch of history indents every row — 220px
  /// reserved on rows that need 60. This lets the renderer indent to the lanes
  /// actually on screen instead. Indexed by row.
  occupiedLane: Int32Array;
}

function rowY(index: number, metrics: GraphMetrics): number {
  return index * metrics.rowHeight + metrics.rowHeight / 2;
}

/**
 * Lay out rows (newest-first) into graph coordinates. Each commit becomes a node;
 * each parent that is also present in `rows` becomes an edge from the commit down
 * to the parent. Parents outside the loaded window are skipped.
 *
 * `laneWidth` controls horizontal lane spacing; callers compress it for repos
 * with many parallel lanes so the graph gutter stays bounded. `metrics` is the
 * theme's row height, margins and origin.
 */
export function layoutGraph(
  rows: CommitRow[],
  laneWidth: number = GRAPH_METRICS.laneWidth,
  metrics: GraphMetrics = GRAPH_METRICS,
): GraphLayout {
  const laneX = (lane: number) => metrics.originX + metrics.marginX + lane * laneWidth;

  const indexById = new Map<string, number>();
  rows.forEach((r, i) => indexById.set(r.id, i));

  const nodes: GraphNode[] = rows.map((r, i) => ({
    id: r.id,
    x: laneX(r.lane),
    y: rowY(i, metrics),
    color: r.color,
  }));

  const edges: GraphEdge[] = [];
  rows.forEach((r, i) => {
    r.parents.forEach((parentId, k) => {
      const j = indexById.get(parentId);
      if (j === undefined) return;
      edges.push({
        fromX: laneX(r.lane),
        fromY: rowY(i, metrics),
        toX: laneX(rows[j].lane),
        toY: rowY(j, metrics),
        color: r.color,
        merge: k > 0,
      });
    });
  });

  const maxLane = rows.reduce((m, r) => Math.max(m, r.lane), 0);
  const width = laneX(maxLane) + metrics.marginX;
  const height = rows.length * metrics.rowHeight;

  return { nodes, edges, width, height, occupiedLane: occupiedLanes(rows, indexById, maxLane) };
}

/**
 * The rightmost lane in use at each row.
 *
 * An edge from row `i` down to row `j` keeps a lane busy for every row between
 * them, so a row's own lane isn't enough — a commit alone in lane 0 can still
 * have five branch lines running past it. Swept top to bottom keeping a count
 * of the spans covering each lane, which is O(rows + edges); walking each span
 * row by row instead would be quadratic on a long-lived branch that spans the
 * whole log.
 */
function occupiedLanes(
  rows: CommitRow[],
  indexById: Map<string, number>,
  maxLane: number,
): Int32Array {
  const occupied = new Int32Array(rows.length);
  // Spans opening at each row, and the lanes to release after each row.
  const opening = new Map<number, { lane: number; end: number }[]>();
  rows.forEach((r, i) => {
    for (const parentId of r.parents) {
      const j = indexById.get(parentId);
      if (j === undefined || j <= i) continue;
      // The edge bends between the two lanes somewhere in the span, so reserve
      // the wider of them for the whole of it.
      const lane = Math.max(r.lane, rows[j].lane);
      const list = opening.get(i);
      if (list) list.push({ lane, end: j });
      else opening.set(i, [{ lane, end: j }]);
    }
  });

  const active = new Int32Array(maxLane + 2); // spans currently covering each lane
  const closing = new Map<number, number[]>();
  let top = 0; // highest lane with a live span

  for (let i = 0; i < rows.length; i++) {
    for (const span of opening.get(i) ?? []) {
      active[span.lane] += 1;
      if (span.lane > top) top = span.lane;
      const list = closing.get(span.end + 1);
      if (list) list.push(span.lane);
      else closing.set(span.end + 1, [span.lane]);
    }
    occupied[i] = Math.max(rows[i].lane, top);
    for (const lane of closing.get(i + 1) ?? []) {
      active[lane] -= 1;
    }
    closing.delete(i + 1);
    // Walk `top` back down past any lane that just went idle.
    while (top > 0 && active[top] === 0) top -= 1;
  }
  return occupied;
}

/**
 * The SVG path for one edge: straight down when the lanes match, otherwise a
 * right angle with a rounded corner, in the style of GitKraken and Fork.
 *
 * The corner is a quadratic curve whose control point is the corner itself,
 * which is both simpler and less error-prone than an elliptical arc (no sweep
 * flags to get backwards) and indistinguishable at this radius.
 *
 * The radius shrinks to fit edges shorter than a full corner — a lane change
 * between adjacent rows, or between adjacent lanes on a compressed graph —
 * so the curve never overshoots either endpoint.
 *
 * With `metrics.curve` set to "bezier" the lane change is instead a cubic
 * S-curve one row tall, at the same end of the edge as the corner would be.
 */
export function edgePath(edge: GraphEdge, metrics: GraphMetrics = GRAPH_METRICS): string {
  const { fromX, fromY, toX, toY } = edge;
  if (fromX === toX) return `M ${fromX} ${fromY} L ${toX} ${toY}`;

  if (metrics.curve === "bezier") {
    const h = Math.min(metrics.rowHeight, Math.abs(toY - fromY));
    const k = h * 0.6; // control-point reach: how upright the curve leaves each end
    if (edge.merge) {
      const y = fromY + h;
      return `M ${fromX} ${fromY} C ${fromX} ${fromY + k} ${toX} ${y - k} ${toX} ${y} L ${toX} ${toY}`;
    }
    const y = toY - h;
    return `M ${fromX} ${fromY} L ${fromX} ${y} C ${fromX} ${y + k} ${toX} ${toY - k} ${toX} ${toY}`;
  }

  const dir = toX > fromX ? 1 : -1;
  const r = Math.min(metrics.cornerRadius, Math.abs(toX - fromX), Math.abs(toY - fromY));

  if (edge.merge) {
    // Corner at the top: out sideways from the commit, then down the parent lane.
    return `M ${fromX} ${fromY} L ${toX - dir * r} ${fromY} Q ${toX} ${fromY} ${toX} ${fromY + r} L ${toX} ${toY}`;
  }
  // Corner at the bottom: down this commit's own lane, turning in at the parent.
  return `M ${fromX} ${fromY} L ${fromX} ${toY - r} Q ${fromX} ${toY} ${fromX + dir * r} ${toY} L ${toX} ${toY}`;
}

/**
 * Choose a lane width so the graph gutter fits within `paneWidth` while never
 * exceeding the default spacing. Repos with many lanes get compressed rather than
 * pushing commit text off-screen.
 */
export function fitLaneWidth(
  maxLane: number,
  paneWidth: number,
  metrics: GraphMetrics = GRAPH_METRICS,
): number {
  if (maxLane <= 0) return metrics.laneWidth;
  const maxGutter = Math.min(240, Math.max(80, paneWidth * 0.45));
  const usable = maxGutter - 2 * metrics.marginX;
  return Math.max(4, Math.min(metrics.laneWidth, usable / maxLane));
}
