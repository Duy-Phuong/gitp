// Pure geometry: turn lane-assigned CommitRows into node/edge coordinates for
// SVG rendering. No DOM, no side effects — unit-tested in graph.test.ts.

import type { CommitRow } from "./types";

export const GRAPH_METRICS = {
  laneWidth: 16,
  rowHeight: 28,
  marginX: 14,
  /// Radius of the rounded right-angle corners where an edge changes lane.
  cornerRadius: 7,
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
}

function rowY(index: number): number {
  return index * GRAPH_METRICS.rowHeight + GRAPH_METRICS.rowHeight / 2;
}

/**
 * Lay out rows (newest-first) into graph coordinates. Each commit becomes a node;
 * each parent that is also present in `rows` becomes an edge from the commit down
 * to the parent. Parents outside the loaded window are skipped.
 *
 * `laneWidth` controls horizontal lane spacing; callers compress it for repos
 * with many parallel lanes so the graph gutter stays bounded.
 */
export function layoutGraph(
  rows: CommitRow[],
  laneWidth: number = GRAPH_METRICS.laneWidth,
): GraphLayout {
  const laneX = (lane: number) => GRAPH_METRICS.marginX + lane * laneWidth;

  const indexById = new Map<string, number>();
  rows.forEach((r, i) => indexById.set(r.id, i));

  const nodes: GraphNode[] = rows.map((r, i) => ({
    id: r.id,
    x: laneX(r.lane),
    y: rowY(i),
    color: r.color,
  }));

  const edges: GraphEdge[] = [];
  rows.forEach((r, i) => {
    r.parents.forEach((parentId, k) => {
      const j = indexById.get(parentId);
      if (j === undefined) return;
      edges.push({
        fromX: laneX(r.lane),
        fromY: rowY(i),
        toX: laneX(rows[j].lane),
        toY: rowY(j),
        color: r.color,
        merge: k > 0,
      });
    });
  });

  const maxLane = rows.reduce((m, r) => Math.max(m, r.lane), 0);
  const width = laneX(maxLane) + GRAPH_METRICS.marginX;
  const height = rows.length * GRAPH_METRICS.rowHeight;

  return { nodes, edges, width, height };
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
 */
export function edgePath(edge: GraphEdge): string {
  const { fromX, fromY, toX, toY } = edge;
  if (fromX === toX) return `M ${fromX} ${fromY} L ${toX} ${toY}`;

  const dir = toX > fromX ? 1 : -1;
  const r = Math.min(GRAPH_METRICS.cornerRadius, Math.abs(toX - fromX), Math.abs(toY - fromY));

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
export function fitLaneWidth(maxLane: number, paneWidth: number): number {
  if (maxLane <= 0) return GRAPH_METRICS.laneWidth;
  const maxGutter = Math.min(240, Math.max(80, paneWidth * 0.45));
  const usable = maxGutter - 2 * GRAPH_METRICS.marginX;
  return Math.max(4, Math.min(GRAPH_METRICS.laneWidth, usable / maxLane));
}
