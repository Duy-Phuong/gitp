// Pure geometry: turn lane-assigned CommitRows into node/edge coordinates for
// SVG rendering. No DOM, no side effects — unit-tested in graph.test.ts.

import type { CommitRow } from "./types";

export const GRAPH_METRICS = {
  laneWidth: 16,
  rowHeight: 28,
  marginX: 14,
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
    for (const parentId of r.parents) {
      const j = indexById.get(parentId);
      if (j === undefined) continue;
      edges.push({
        fromX: laneX(r.lane),
        fromY: rowY(i),
        toX: laneX(rows[j].lane),
        toY: rowY(j),
        color: r.color,
      });
    }
  });

  const maxLane = rows.reduce((m, r) => Math.max(m, r.lane), 0);
  const width = laneX(maxLane) + GRAPH_METRICS.marginX;
  const height = rows.length * GRAPH_METRICS.rowHeight;

  return { nodes, edges, width, height };
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
