// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { setupHierarchyPanel, setupUsagesPanel } from "./usages-panel";
import type { HierarchyNode, Reference, Symbol, UsagesResult } from "../../types";

const sym = (path: string, name: string, line = 0): Symbol => ({
  id: { file: 0, byte: line },
  name,
  kind: "method",
  path,
  lang: "typescript",
  container: null,
  range: { start_line: line, start_col: 0, end_line: line + 1, end_col: 0, start_byte: line, end_byte: line + 1 },
  name_range: { start_line: line, start_col: 9, end_line: line, end_col: 9 + name.length, start_byte: line, end_byte: line + 1 },
});
const ref = (path: string, line: number, certain: boolean): { reference: Reference; certain: boolean } => ({
  certain,
  reference: { name: "save", kind: "call", path, enclosing: null, receiver: null, range: { start_line: line, start_col: 2, end_line: line, end_col: 6, start_byte: 0, end_byte: 1 } },
});

afterEach(() => (document.body.innerHTML = ""));

describe("setupUsagesPanel", () => {
  it("lists certain usages above possible ones, grouped by file", () => {
    const host = document.createElement("div");
    const panel = setupUsagesPanel(host, { jump: () => {} });
    const result: UsagesResult = { symbol: sym("a.ts", "save"), hits: [ref("z.ts", 1, false), ref("a.ts", 5, true), ref("b.ts", 2, true)], truncated: false };
    panel.show(result);
    const groups = [...host.querySelectorAll<HTMLElement>(".code-usages-group")].map((g) => g.dataset.kind);
    expect(groups).toEqual(["certain", "possible"]);
    const files = [...host.querySelectorAll<HTMLElement>(".code-usages-file")].map((f) => f.dataset.path);
    expect(files).toEqual(["a.ts", "b.ts", "z.ts"]);
    expect(host.querySelector(".code-usages-title")?.textContent).toContain("3 usages of save");
  });

  it("says when the list was cut off", () => {
    const host = document.createElement("div");
    const panel = setupUsagesPanel(host, { jump: () => {} });
    panel.show({ symbol: sym("a.ts", "save"), hits: [ref("a.ts", 1, true)], truncated: true });
    expect(host.querySelector(".code-usages-title")?.textContent).toContain("narrowed");
  });

  it("a click jumps to the usage", () => {
    const host = document.createElement("div");
    const jump = vi.fn();
    const panel = setupUsagesPanel(host, { jump });
    panel.show({ symbol: sym("a.ts", "save"), hits: [ref("b.ts", 7, true)], truncated: false });
    host.querySelector<HTMLElement>(".code-usages-hit")!.click();
    expect(jump).toHaveBeenCalledWith({ path: "b.ts", line: 7, col: 2 }, 6);
  });
});

describe("setupHierarchyPanel", () => {
  it("renders the root, expands a node on click and switches mode", async () => {
    const host = document.createElement("div");
    const jump = vi.fn();
    const load = vi.fn(async (_s: Symbol, mode: "callers" | "callees"): Promise<HierarchyNode[]> => (mode === "callers" ? [{ symbol: sym("b.ts", "caller", 3), reference: ref("b.ts", 4, true).reference, certain: true }] : []));
    const panel = setupHierarchyPanel(host, { jump, load });
    await panel.show(sym("a.ts", "save"), "callers");
    const rows = () => [...host.querySelectorAll<HTMLElement>(".code-h-row")].map((r) => r.textContent);
    expect(rows()[0]).toContain("save");
    expect(rows().length).toBe(2); // the root is expanded on show
    expect(rows()[1]).toContain("caller");
    host.querySelectorAll<HTMLElement>(".code-h-row")[1].querySelector<HTMLElement>(".code-h-label")!.click();
    expect(jump).toHaveBeenCalledWith({ path: "b.ts", line: 4, col: 2 }, 6);
    host.querySelector<HTMLElement>('[data-mode="callees"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(rows().length).toBe(1);
    expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ name: "save" }), "callees");
  });
});
