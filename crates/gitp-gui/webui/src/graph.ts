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

function laneX(lane: number): number {
  return GRAPH_METRICS.marginX + lane * GRAPH_METRICS.laneWidth;
}

function rowY(index: number): number {
  return index * GRAPH_METRICS.rowHeight + GRAPH_METRICS.rowHeight / 2;
}

/**
 * Lay out rows (newest-first) into graph coordinates. Each commit becomes a node;
 * each parent that is also present in `rows` becomes an edge from the commit down
 * to the parent. Parents outside the loaded window are skipped.
 */
export function layoutGraph(rows: CommitRow[]): GraphLayout {
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
