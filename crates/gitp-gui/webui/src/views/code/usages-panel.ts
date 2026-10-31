// The Usages pane (every use of a symbol, the certain ones first) and the
// Call hierarchy pane (a lazily expanded tree of callers or callees).

import { clear, el } from "../../dom";
import type { HierarchyNode, Location, Symbol, UsagesResult } from "../../types";
import { HierarchyModel, type HierarchyMode, type HNode } from "./hierarchy-model";

export interface UsagesPanelHandle {
  show: (result: UsagesResult) => void;
  clear: () => void;
}

export function setupUsagesPanel(host: HTMLElement, deps: { jump: (loc: Location, endCol: number) => void }): UsagesPanelHandle {
  const show = (r: UsagesResult) => {
    clear(host);
    const n = r.hits.length;
    host.append(
      el("div", { class: "code-usages-title" }, [
        `${n} usage${n === 1 ? "" : "s"} of ${r.symbol.name}`,
        el("span", { class: "code-usages-where" }, [` · ${r.symbol.kind} in ${r.symbol.path}`]),
        r.truncated ? el("span", { class: "code-usages-note" }, [" · narrowed to the first 2 000"]) : "",
      ]),
    );
    for (const kind of ["certain", "possible"] as const) {
      const hits = r.hits.filter((h) => h.certain === (kind === "certain"));
      if (!hits.length) continue;
      const group = el("div", { class: "code-usages-group", "data-kind": kind }, [
        el("div", { class: "code-usages-group-title" }, [kind === "certain" ? "Usages" : "Possible usages (same name, not tied to this definition)"]),
      ]);
      const byFile = new Map<string, typeof hits>();
      for (const h of hits) byFile.set(h.reference.path, [...(byFile.get(h.reference.path) ?? []), h]);
      for (const [path, list] of [...byFile].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const file = el("details", { class: "code-usages-file", "data-path": path, open: "" }, [
          el("summary", {}, [el("span", { class: "code-search-path" }, [path]), el("span", { class: "code-search-count" }, [String(list.length)])]),
        ]);
        for (const h of list) {
          const row = el("div", { class: "code-usages-hit code-search-hit" }, [
            el("span", { class: "code-search-line" }, [String(h.reference.range.start_line + 1)]),
            el("span", { class: "code-search-text" }, [`${h.reference.receiver ? h.reference.receiver + "." : ""}${h.reference.name}${h.reference.kind === "call" ? "(…)" : ""}`]),
          ]);
          row.addEventListener("click", () => deps.jump({ path, line: h.reference.range.start_line, col: h.reference.range.start_col }, h.reference.range.end_col));
          file.append(row);
        }
        group.append(file);
      }
      host.append(group);
    }
  };
  return { show, clear: () => clear(host) };
}

export interface HierarchyPanelHandle {
  show: (root: Symbol, mode: HierarchyMode) => Promise<void>;
  // The symbol the tree is rooted at, for a refresh after the files change.
  root: () => { symbol: Symbol; mode: HierarchyMode } | null;
  clear: () => void;
}

export function setupHierarchyPanel(
  host: HTMLElement,
  deps: { jump: (loc: Location, endCol: number) => void; load: (symbol: Symbol, mode: HierarchyMode) => Promise<HierarchyNode[]> },
): HierarchyPanelHandle {
  let model: HierarchyModel | null = null;

  const render = () => {
    clear(host);
    if (!model) return;
    const m = model;
    const bar = el("div", { class: "code-h-bar" });
    for (const mode of ["callers", "callees"] as const) {
      const btn = el("button", { class: `code-h-mode${m.mode === mode ? " active" : ""}`, "data-mode": mode, type: "button" }, [mode === "callers" ? "Callers" : "Callees"]);
      btn.addEventListener("click", () => {
        if (m.mode === mode) return;
        m.toggleMode();
        void m.expand(m.root()).then(render);
        render();
      });
      bar.append(btn);
    }
    host.append(bar);
    const tree = el("div", { class: "code-h-tree" });
    const walk = (n: HNode, depth: number) => {
      const expandable = !!n.symbol && !n.onPath && !(n.children && n.children.length === 0 && n.expanded);
      const row = el("div", { class: `code-h-row${n.certain ? "" : " possible"}${n.onPath ? " on-path" : ""}`, style: `--depth:${depth}` }, [
        el("span", { class: "code-h-chevron" }, [expandable ? (n.expanded ? "▾" : "▸") : ""]),
        el("span", { class: "code-h-label" }, [
          el("span", { class: "code-h-name" }, [n.symbol ? n.symbol.name : n.reference?.name ?? "?"]),
          el("span", { class: "code-h-where" }, [n.symbol ? ` ${n.symbol.kind} · ${n.symbol.path}:${n.symbol.name_range.start_line + 1}` : n.reference ? ` ${n.reference.path}:${n.reference.range.start_line + 1} (not in the project)` : ""]),
        ]),
      ]);
      row.querySelector(".code-h-chevron")!.addEventListener("click", () => {
        if (!expandable) return;
        if (n.expanded) {
          m.collapse(n);
          render();
        } else void m.expand(n).then(render);
      });
      row.querySelector(".code-h-label")!.addEventListener("click", () => {
        const r = n.reference;
        if (r) deps.jump({ path: r.path, line: r.range.start_line, col: r.range.start_col }, r.range.end_col);
        else if (n.symbol) deps.jump({ path: n.symbol.path, line: n.symbol.name_range.start_line, col: n.symbol.name_range.start_col }, n.symbol.name_range.end_col);
      });
      tree.append(row);
      if (n.expanded) for (const c of n.children ?? []) walk(c, depth + 1);
    };
    walk(m.root(), 0);
    host.append(tree);
  };

  return {
    show: async (root, mode) => {
      model = new HierarchyModel(root, mode, deps.load);
      await model.expand(model.root());
      render();
    },
    root: () => (model?.root().symbol ? { symbol: model.root().symbol!, mode: model.mode } : null),
    clear: () => {
      model = null;
      clear(host);
    },
  };
}
