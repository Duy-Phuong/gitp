// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import { buildTree, renderExplorer, revealPath, type ExplorerState } from "./explorer";
import type { FileEntry } from "../../types";

const entry = (path: string): FileEntry => ({ path, size: 1, lang: null, mtime_ms: 1 });

describe("buildTree", () => {
  it("orders folders before files, case-insensitively, at every level", () => {
    const tree = buildTree(["zeta.ts", "Alpha/x.ts", "beta/y.ts", "Beta.md", "alpha/a.ts"].map(entry));
    expect(tree.children!.map((n) => n.name)).toEqual(["Alpha", "alpha", "beta", "Beta.md", "zeta.ts"]);
    expect(tree.children![0].children?.map((n) => n.path)).toEqual(["Alpha/x.ts"]);
  });

  it("nests deep paths", () => {
    const tree = buildTree([entry("a/b/c/d.ts")]);
    expect(tree.children![0].children?.[0].children?.[0].children?.[0].path).toBe("a/b/c/d.ts");
  });
});

describe("revealPath", () => {
  it("expands every ancestor and selects the file", () => {
    const state: ExplorerState = { expanded: new Set(), selected: null };
    revealPath(state, "a/b/c.ts");
    expect([...state.expanded]).toEqual(["a", "a/b"]);
    expect(state.selected).toBe("a/b/c.ts");
  });
});

describe("renderExplorer", () => {
  it("shows only expanded folders' children and opens a file on click", () => {
    const host = document.createElement("div");
    const tree = buildTree(["src/a.ts", "src/b.ts", "README.md"].map(entry));
    const state: ExplorerState = { expanded: new Set(), selected: null };
    const open = vi.fn();
    renderExplorer(host, tree, state, { open, toggle: (p) => (state.expanded.has(p) ? state.expanded.delete(p) : state.expanded.add(p)) });
    const rows = () => [...host.querySelectorAll<HTMLElement>(".code-row")].map((r) => r.dataset.path);
    expect(rows()).toEqual(["src", "README.md"]);
    host.querySelector<HTMLElement>('.code-row[data-path="src"]')!.click();
    renderExplorer(host, tree, state, { open, toggle: () => {} });
    expect(rows()).toEqual(["src", "src/a.ts", "src/b.ts", "README.md"]);
    host.querySelector<HTMLElement>('.code-row[data-path="src/b.ts"]')!.click();
    expect(open).toHaveBeenCalledWith("src/b.ts");
  });

  it("marks the selected file", () => {
    const host = document.createElement("div");
    const tree = buildTree([entry("a.ts"), entry("b.ts")]);
    renderExplorer(host, tree, { expanded: new Set(), selected: "b.ts" }, { open: () => {}, toggle: () => {} });
    expect(host.querySelector(".code-row.selected")?.getAttribute("data-path")).toBe("b.ts");
  });
});
