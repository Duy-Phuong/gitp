// Timings of the log's pure logic on a history the size of a large repository:
// 100k commits, ~400 branches with their remote copies, ~460 tags. Not a
// pass/fail test: it prints how long each step takes. Skipped unless asked for:
//
//   GITP_PERF=1 npx vitest run src/large-repo-timing.test.ts
//
// The history is synthetic but shaped like the generated repo the backend
// timings run on (scripts/gen-large-repo.py): a main line,
// feature branches that fork, take a few commits and merge back, ~30 open at a
// time, and a few hundred never merged.

import { describe, it } from "vitest";
import { edgePath, layoutGraph, visibleEdges } from "./graph";
import { branchReach, ghostBranch, rebuildCommitRefs, refLabelsAt } from "./commit-refs";
import { state } from "./app-state";
import { authorsOf } from "./log-columns";
import { highlighter, hunkRuns } from "./highlight";
import { hunkWordDiffs } from "./worddiff";
import type { BranchRef, CommitRow, RemoteBranch, TagRef } from "./types";

const COMMITS = 100_000;

// A deterministic pseudo-random sequence, so every run times the same history.
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x80000000;
  };
}

const hex = (n: number) => n.toString(16).padStart(40, "0");

// Lanes as the backend's graph.rs lays them out (no pinned branch).
function assignLanes(rows: CommitRow[]): void {
  const active: (string | null)[] = [];
  const colors: number[] = [];
  let next = 0;
  const free = () => {
    const i = active.indexOf(null);
    if (i >= 0) return i;
    active.push(null);
    return active.length - 1;
  };
  for (const row of rows) {
    let lane = active.indexOf(row.id);
    let color: number;
    if (lane >= 0) color = colors[lane];
    else {
      lane = free();
      color = next++;
    }
    row.lane = lane;
    row.color = color;
    for (let i = 0; i < active.length; i++) if (active[i] === row.id) active[i] = null;
    const [first, ...extra] = row.parents;
    if (first !== undefined && !active.includes(first)) {
      active[lane] = first;
      colors[lane] = color;
    }
    for (const p of extra) {
      if (active.includes(p)) continue;
      const i = free();
      active[i] = p;
      colors[i] = next++;
    }
  }
}

function history(): { rows: CommitRow[]; branches: BranchRef[]; remotes: RemoteBranch[]; tags: TagRef[] } {
  const rand = rng(52);
  const made: CommitRow[] = [];
  const words = ["parse", "render", "cache", "graph", "lane", "fetch", "merge", "fix"];
  const commit = (parents: number[]): number => {
    const n = made.length;
    const a = Math.floor(rand() * 50);
    made.push({
      id: hex(n + 1),
      short_id: hex(n + 1).slice(-7),
      summary: `${words[n % 8]} ${words[(n >> 3) % 8]} in src/mod${n % 100}/file${n}.rs`,
      author_name: `Dev ${a}`,
      author_email: `dev${a}@example.com`,
      time: 1_400_000_000 + n * 300,
      parents: parents.map((p) => made[p].id),
      lane: 0,
      color: 0,
    });
    return n;
  };
  let main = commit([]);
  let mainCount = 0;
  const open = new Map<string, number>();
  const left: [string, number][] = [];
  const tags: TagRef[] = [];
  let nb = 0;
  while (made.length < COMMITS) {
    const r = rand();
    const names = [...open.keys()];
    if (r < 0.45 || (!open.size && r >= 0.55)) {
      main = commit([main]);
      if (++mainCount % 100 === 0) tags.push({ name: `v${mainCount / 100}.0`, target: made[main].id, message: null });
    } else if (r < 0.55 && open.size < 30) {
      open.set(`feature/${++nb}`, commit([main]));
    } else if (open.size && r < 0.9) {
      const name = names[Math.floor(rand() * names.length)];
      open.set(name, commit([open.get(name)!]));
    } else if (open.size) {
      const name = names[Math.floor(rand() * names.length)];
      const tip = open.get(name)!;
      open.delete(name);
      if (rand() < 0.04 && left.length < 400) left.push([name, tip]);
      else main = commit([main, tip]);
    }
  }
  const rows = made.reverse();
  assignLanes(rows);
  const ends: [string, number][] = [...open.entries(), ...left];
  const branches: BranchRef[] = ends.map(([name, tip]) => ({
    name,
    target: hex(tip + 1),
    is_head: false,
    ahead: 0,
    behind: 0,
    has_upstream: true,
  }));
  branches.push({ name: "main", target: hex(main + 1), is_head: true, ahead: 0, behind: 0, has_upstream: true });
  const remotes = branches.map((b) => ({ remote: "origin", name: `origin/${b.name}`, target: b.target }));
  return { rows, branches, remotes, tags };
}

// The best of `runs` timings, in ms, printed.
function time(label: string, runs: number, f: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    f();
    best = Math.min(best, performance.now() - t);
  }
  console.log(`${label.padEnd(58)} ${best.toFixed(2).padStart(9)} ms`);
  return best;
}

describe.skipIf(!import.meta.env.GITP_PERF)("large repository timings", () => {
  it("prints timings", () => {
    const h = history();
    const rows = h.rows;
    console.log(`${rows.length} rows, max lane ${Math.max(...rows.map((r) => r.lane))}, ${h.branches.length} branches, ${h.tags.length} tags`);
    state.refs = { head: "main", branches: h.branches, remotes: h.remotes, tags: h.tags, stashes: [], recent: [] };

    for (const n of [1000, 10_000, COMMITS]) {
      const page = rows.slice(0, n);
      time(`layoutGraph (${n} rows)`, 3, () => layoutGraph(page));
      time(`rebuildCommitRefs (${n} rows)`, 3, () => {
        state.rows = page.slice(); // a new identity: the cache must not hit
        rebuildCommitRefs();
      });
    }

    // One scroll / hover repaint: the rows and edges a screen at the middle of
    // the fully loaded log needs. Before: every edge and node tested.
    const layout = layoutGraph(rows);
    const rowH = 28;
    const start = 50_000;
    const end = start + 40;
    const top = start * rowH;
    const bottom = end * rowH;
    time("one repaint: test every edge and node (before)", 20, () => {
      let n = 0;
      for (const e of layout.edges) {
        if (Math.max(e.fromY, e.toY) < top || Math.min(e.fromY, e.toY) > bottom) continue;
        n++;
      }
      for (const node of layout.nodes) if (node.y >= top && node.y <= bottom) n++;
      return n;
    });
    time("one repaint: visibleEdges + window nodes (after)", 20, () => {
      let n = visibleEdges(layout, top, bottom).length;
      for (let i = start; i < end; i++) if (layout.nodes[i].y >= top) n++;
      return n;
    });
    time("edgePath for the window's edges", 20, () => visibleEdges(layout, top, bottom).map((e) => edgePath(e)));

    // Hover fade: the test per drawn row, for a local and a remote branch.
    const window = rows.slice(start, end);
    const local = h.branches[0].name;
    const remote = h.remotes[0].name;
    time("branchReach local (hover start)", 20, () => branchReach({ kind: "local", name: local }));
    // A remote branch isn't in the bitsets: its reach is walked from the tip.
    const screenTop = rows.slice(0, 40);
    time("hover a remote branch, screen at the top", 5, () => {
      const test = branchReach({ kind: "remote", name: remote })!;
      return screenTop.filter((r) => test(r.id)).length;
    });
    time("hover a remote branch, screen at row 50k", 5, () => {
      const test = branchReach({ kind: "remote", name: remote })!;
      return window.filter((r) => test(r.id)).length;
    });
    time("ghostBranch for the window's rows", 20, () => window.map((r) => ghostBranch(refLabelsAt(r.id))));
    time("authorsOf (author filter menu, all rows)", 3, () => authorsOf(rows));

    // A large diff: 5000 lines, one hunk of changed pairs.
    const lines: { origin: string; content: string }[] = [];
    for (let i = 0; i < 2500; i++) {
      lines.push({ origin: "-", content: `  const value${i} = compute(${i}, "old string ${i}"); // note ${i}` });
    }
    for (let i = 0; i < 2500; i++) {
      lines.push({ origin: "+", content: `  const value${i} = compute(${i + 1}, "new string ${i}"); // note ${i}` });
    }
    time("hunkRuns (highlight 5000-line diff)", 3, () => hunkRuns(lines, highlighter("big.ts")!));
    time("hunkWordDiffs (5000-line hunk, capped)", 3, () => hunkWordDiffs(lines));
    const small = lines.slice(0, 500).concat(lines.slice(2500, 3000));
    time("hunkWordDiffs (1000-line hunk)", 3, () => hunkWordDiffs(small));
  });
});
