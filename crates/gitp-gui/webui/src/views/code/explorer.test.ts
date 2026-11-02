// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import { buildTree, explorerKey, renderExplorer, revealPath, type ExplorerState } from "./explorer";
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

  it("adds ignored paths greyed, a directory's contents once listed", () => {
    const ignored = [
      { path: "target", dir: true },
      { path: "src/gen.log", dir: false },
    ];
    const empty = buildTree([entry("src/a.ts")], ignored);
    expect(empty.children!.map((n) => [n.name, !!n.ignored, !!n.children])).toEqual([
      ["src", false, true],
      ["target", true, true],
    ]);
    expect(empty.children![0].children!.map((n) => n.path)).toEqual(["src/a.ts", "src/gen.log"]);
    expect(empty.children![1].children).toEqual([]);
    const listed = new Map([["target", [{ path: "target/debug", dir: true }, { path: "target/x.o", dir: false }]]]);
    const full = buildTree([entry("src/a.ts")], ignored, listed);
    expect(full.children![1].children!.map((n) => [n.path, !!n.ignored, !!n.children])).toEqual([
      ["target/debug", true, true],
      ["target/x.o", true, false],
    ]);
    const host = document.createElement("div");
    renderExplorer(host, full, { expanded: new Set(["target"]), selected: null }, { open: () => {}, toggle: () => {} });
    expect([...host.querySelectorAll<HTMLElement>(".code-row-ignored")].map((r) => r.dataset.path)).toEqual(["target", "target/debug", "target/x.o"]);
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

describe("explorerKey", () => {
  // src/ (lib/ (x.ts), a.ts), README.md
  const tree = buildTree(["src/lib/x.ts", "src/a.ts", "README.md"].map(entry));
  const fresh = (selected: string | null, expanded: string[] = []): ExplorerState => ({ expanded: new Set(expanded), selected });

  it("Down and Up walk the visible rows and stop at the ends", () => {
    const s = fresh(null, ["src"]);
    expect(explorerKey(tree, s, "ArrowDown")).toBe("moved");
    expect(s.selected).toBe("src");
    explorerKey(tree, s, "ArrowDown");
    explorerKey(tree, s, "ArrowDown");
    expect(s.selected).toBe("src/a.ts"); // lib/ is closed, x.ts is skipped
    explorerKey(tree, s, "ArrowDown");
    explorerKey(tree, s, "ArrowDown");
    expect(s.selected).toBe("README.md");
    explorerKey(tree, s, "ArrowUp");
    expect(s.selected).toBe("src/a.ts");
  });

  it("Right expands a closed folder, then steps into it", () => {
    const s = fresh("src");
    explorerKey(tree, s, "ArrowRight");
    expect(s.expanded.has("src")).toBe(true);
    expect(s.selected).toBe("src");
    explorerKey(tree, s, "ArrowRight");
    expect(s.selected).toBe("src/lib");
  });

  it("Left collapses an open folder, else goes to the parent", () => {
    const s = fresh("src/lib/x.ts", ["src", "src/lib"]);
    explorerKey(tree, s, "ArrowLeft");
    expect(s.selected).toBe("src/lib");
    explorerKey(tree, s, "ArrowLeft");
    expect(s.expanded.has("src/lib")).toBe(false);
    expect(s.selected).toBe("src/lib");
  });

  it("Enter opens a file and toggles a folder", () => {
    const s = fresh("README.md");
    expect(explorerKey(tree, s, "Enter")).toEqual({ open: "README.md" });
    s.selected = "src";
    explorerKey(tree, s, "Enter");
    expect(s.expanded.has("src")).toBe(true);
  });

  it("ignores other keys", () => {
    expect(explorerKey(tree, fresh("src"), "a")).toBe("ignored");
  });
});
