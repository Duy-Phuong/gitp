import { describe, expect, it, vi } from "vitest";

import { HierarchyModel } from "./hierarchy-model";
import type { HierarchyNode, Reference, Symbol } from "../../types";

const sym = (path: string, name: string, line = 0): Symbol => ({
  id: { file: 0, byte: line },
  name,
  kind: "function",
  path,
  lang: "typescript",
  container: null,
  range: { start_line: line, start_col: 0, end_line: line + 1, end_col: 0, start_byte: line, end_byte: line + 1 },
  name_range: { start_line: line, start_col: 9, end_line: line, end_col: 9 + name.length, start_byte: line, end_byte: line + 1 },
});
const ref = (path: string, name: string, line = 0): Reference => ({ name, kind: "call", path, enclosing: null, receiver: null, range: { start_line: line, start_col: 2, end_line: line, end_col: 2 + name.length, start_byte: 0, end_byte: 1 } });
const node = (symbol: Symbol | null, reference: Reference, certain = true): HierarchyNode => ({ symbol, reference, certain });

describe("HierarchyModel", () => {
  it("expand loads a node's children once", async () => {
    const load = vi.fn(async (s: Symbol) => (s.name === "a" ? [node(sym("b.ts", "b", 3), ref("b.ts", "a", 4))] : []));
    const m = new HierarchyModel(sym("a.ts", "a"), "callers", load);
    expect(m.root().children).toBeNull();
    await m.expand(m.root());
    expect(m.root().expanded).toBe(true);
    expect(m.root().children?.map((c) => c.symbol?.name)).toEqual(["b"]);
    await m.expand(m.root());
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("a symbol already on the path is a leaf (no cycle)", async () => {
    const a = sym("a.ts", "a");
    const b = sym("b.ts", "b", 3);
    const load = vi.fn(async (s: Symbol) => (s.name === "a" ? [node(b, ref("b.ts", "a"))] : [node(a, ref("a.ts", "b"))]));
    const m = new HierarchyModel(a, "callers", load);
    await m.expand(m.root());
    const bNode = m.root().children![0];
    await m.expand(bNode);
    const aAgain = bNode.children![0];
    expect(aAgain.onPath).toBe(true);
    await m.expand(aAgain);
    expect(aAgain.children).toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("an unresolved call is a leaf", async () => {
    const m = new HierarchyModel(sym("a.ts", "a"), "callees", async () => [node(null, ref("a.ts", "log"))]);
    await m.expand(m.root());
    const leaf = m.root().children![0];
    expect(leaf.children).toEqual([]);
    await m.expand(leaf);
    expect(leaf.children).toEqual([]);
  });

  it("toggling the mode reloads the root", async () => {
    const load = vi.fn(async (_s: Symbol, mode: "callers" | "callees") => [node(sym("x.ts", mode), ref("x.ts", mode))]);
    const m = new HierarchyModel(sym("a.ts", "a"), "callers", load);
    await m.expand(m.root());
    expect(m.root().children![0].symbol?.name).toBe("callers");
    m.toggleMode();
    expect(m.mode).toBe("callees");
    expect(m.root().children).toBeNull();
    await m.expand(m.root());
    expect(m.root().children![0].symbol?.name).toBe("callees");
  });
});
