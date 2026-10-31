// The call hierarchy as a lazily loaded tree: callers of the root (who calls
// it, then who calls them…) or callees (what it calls, and on down). A symbol
// that is already an ancestor is a leaf, so recursion never loops.

import type { HierarchyNode, Reference, Symbol } from "../../types";

export type HierarchyMode = "callers" | "callees";

export interface HNode {
  symbol: Symbol | null;
  // The call site this node came from; null for the root.
  reference: Reference | null;
  certain: boolean;
  // null = not loaded yet; [] = nothing (or a leaf).
  children: HNode[] | null;
  expanded: boolean;
  onPath: boolean;
}

const same = (a: Symbol, b: Symbol) => a.path === b.path && a.name_range.start_line === b.name_range.start_line && a.name_range.start_col === b.name_range.start_col;

export class HierarchyModel {
  mode: HierarchyMode;
  private rootNode: HNode;

  constructor(
    rootSymbol: Symbol,
    mode: HierarchyMode,
    private load: (symbol: Symbol, mode: HierarchyMode) => Promise<HierarchyNode[]>,
  ) {
    this.mode = mode;
    this.rootNode = { symbol: rootSymbol, reference: null, certain: true, children: null, expanded: false, onPath: false };
  }

  root(): HNode {
    return this.rootNode;
  }

  toggleMode(): void {
    this.mode = this.mode === "callers" ? "callees" : "callers";
    this.rootNode = { ...this.rootNode, children: null, expanded: false };
  }

  /// Load `n`'s children if needed and open it; a leaf stays a leaf.
  async expand(n: HNode): Promise<void> {
    if (n.children === null) {
      if (!n.symbol || n.onPath) {
        n.children = [];
      } else {
        const path = this.ancestors(n);
        const loaded = await this.load(n.symbol, this.mode);
        n.children = loaded.map((h) => ({
          symbol: h.symbol,
          reference: h.reference,
          certain: h.certain,
          children: h.symbol ? null : [],
          expanded: false,
          onPath: !!h.symbol && path.some((s) => same(s, h.symbol!)),
        }));
      }
    }
    n.expanded = true;
  }

  collapse(n: HNode): void {
    n.expanded = false;
  }

  /// The symbols from the root down to `n`, inclusive.
  private ancestors(n: HNode): Symbol[] {
    const out: Symbol[] = [];
    const walk = (node: HNode, trail: Symbol[]): boolean => {
      const here = node.symbol ? [...trail, node.symbol] : trail;
      if (node === n) {
        out.push(...here);
        return true;
      }
      return (node.children ?? []).some((c) => walk(c, here));
    };
    walk(this.rootNode, []);
    return out;
  }
}
