import { describe, it, expect } from "vitest";
import { layoutGraph, fitLaneWidth, GRAPH_METRICS } from "./graph";
import type { CommitRow } from "./types";

function row(partial: Partial<CommitRow> & { id: string }): CommitRow {
  return {
    short_id: partial.id.slice(0, 7),
    summary: "",
    author_name: "",
    author_email: "",
    time: 0,
    parents: [],
    lane: 0,
    color: 0,
    ...partial,
  };
}

describe("layoutGraph", () => {
  it("places linear commits in one column with increasing rows", () => {
    const rows: CommitRow[] = [
      row({ id: "c", parents: ["b"], lane: 0 }),
      row({ id: "b", parents: ["a"], lane: 0 }),
      row({ id: "a", parents: [], lane: 0 }),
    ];

    const layout = layoutGraph(rows);

    expect(layout.nodes).toHaveLength(3);
    const xs = layout.nodes.map((n) => n.x);
    expect(new Set(xs).size).toBe(1); // same column
    expect(layout.nodes[0].y).toBeLessThan(layout.nodes[1].y);
    expect(layout.nodes[1].y).toBeLessThan(layout.nodes[2].y);
  });

  it("connects each commit to its parent with an edge", () => {
    const rows: CommitRow[] = [
      row({ id: "c", parents: ["b"], lane: 0 }),
      row({ id: "b", parents: ["a"], lane: 0 }),
      row({ id: "a", parents: [], lane: 0 }),
    ];

    const layout = layoutGraph(rows);

    // Two parent links: c->b and b->a.
    expect(layout.edges).toHaveLength(2);
    const cNode = layout.nodes.find((n) => n.id === "c")!;
    const bNode = layout.nodes.find((n) => n.id === "b")!;
    const edge = layout.edges[0];
    expect(edge.fromY).toBe(cNode.y);
    expect(edge.toY).toBe(bNode.y);
  });

  it("offsets a commit on a higher lane further right", () => {
    const rows: CommitRow[] = [
      row({ id: "m", parents: ["b", "c"], lane: 0 }),
      row({ id: "c", parents: ["a"], lane: 1 }),
      row({ id: "b", parents: ["a"], lane: 0 }),
      row({ id: "a", parents: [], lane: 1 }),
    ];

    const layout = layoutGraph(rows);

    const cNode = layout.nodes.find((n) => n.id === "c")!;
    const bNode = layout.nodes.find((n) => n.id === "b")!;
    expect(cNode.x).toBeGreaterThan(bNode.x);
    expect(cNode.x - bNode.x).toBe(GRAPH_METRICS.laneWidth);
  });

  it("ignores parents outside the loaded window", () => {
    const rows: CommitRow[] = [row({ id: "c", parents: ["missing"], lane: 0 })];

    const layout = layoutGraph(rows);

    expect(layout.nodes).toHaveLength(1);
    expect(layout.edges).toHaveLength(0);
  });
});

describe("fitLaneWidth", () => {
  it("uses the default width when there are no extra lanes", () => {
    expect(fitLaneWidth(0, 340)).toBe(GRAPH_METRICS.laneWidth);
  });

  it("keeps the default width for a few lanes", () => {
    expect(fitLaneWidth(2, 340)).toBe(GRAPH_METRICS.laneWidth);
  });

  it("compresses many lanes so the graph fits (regression: wide graphs hid text)", () => {
    const maxLane = 32;
    const paneWidth = 340;
    const laneWidth = fitLaneWidth(maxLane, paneWidth);

    expect(laneWidth).toBeLessThan(GRAPH_METRICS.laneWidth);

    // The graph gutter must leave room for commit text in the pane.
    const rows: CommitRow[] = Array.from({ length: 3 }, (_, i) =>
      row({ id: `c${i}`, lane: i === 0 ? maxLane : 0 }),
    );
    const layout = layoutGraph(rows, laneWidth);
    expect(layout.width).toBeLessThan(paneWidth * 0.6);
  });
});
