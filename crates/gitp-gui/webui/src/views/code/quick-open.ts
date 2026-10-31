// Quick open (Cmd/Ctrl+P): a file by fuzzy name, in Quick Launch's clothes.
// Enter opens; Cmd/Ctrl+Enter opens and reveals it in the explorer. With no
// query, the recently opened files come first, newest first.

import { clear, el } from "../../dom";
import { rankFuzzy } from "../../fuzzy";
import type { FileEntry } from "../../types";

const LIMIT = 50;

export function openQuickOpen(files: FileEntry[], onPick: (path: string, reveal: boolean) => void, recent: string[] = []): void {
  const overlay = el("div", { class: "ql-overlay" });
  const panel = el("div", { class: "ql-panel", role: "dialog", "aria-label": "Open file" });
  const input = el("input", { class: "ql-input", type: "text", placeholder: "Open file by name…", autocomplete: "off", spellcheck: "false" });
  const list = el("div", { class: "ql-list", role: "listbox" });
  const hint = el("div", { class: "ql-hint", text: "↑↓ to move · ↵ to open · ⌘↵ to open and reveal · esc to close" });
  panel.append(el("div", { class: "ql-bar" }, [input]), list, hint);
  overlay.append(panel);

  let shown: string[] = [];
  let selected = 0;

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const pick = (reveal: boolean) => {
    const path = shown[selected];
    if (!path) return;
    close();
    onPick(path, reveal);
  };

  const render = () => {
    clear(list);
    const query = input.value.trim();
    let ranked = rankFuzzy(query, files, (f) => f.path, LIMIT);
    // Recent files that still exist head the list; the rest follow under "Files".
    let recentCount = 0;
    if (!query) {
      const byPath = new Map(files.map((f) => [f.path, f]));
      const head = recent.flatMap((p) => (byPath.has(p) ? [{ item: byPath.get(p)!, match: { score: 0, positions: [] } }] : []));
      const seen = new Set(head.map((r) => r.item.path));
      ranked = [...head, ...ranked.filter((r) => !seen.has(r.item.path))].slice(0, LIMIT);
      recentCount = head.length;
    }
    shown = ranked.map((r) => r.item.path);
    selected = Math.min(selected, Math.max(0, shown.length - 1));
    if (!shown.length) {
      list.append(el("div", { class: "ql-empty", text: "No file matches" }));
      return;
    }
    ranked.forEach(({ item, match }, i) => {
      if (recentCount && i === 0) list.append(el("div", { class: "ql-section", text: "Recently opened" }));
      if (recentCount && i === recentCount) list.append(el("div", { class: "ql-section", text: "Files" }));
      const row = el("div", { class: `ql-row${i === selected ? " selected" : ""}`, role: "option", "data-path": item.path });
      const label = el("span", { class: "ql-label" });
      const hits = new Set(match.positions);
      for (let j = 0; j < item.path.length; j++) {
        const ch = item.path[j];
        label.append(hits.has(j) ? el("b", {}, [ch]) : ch);
      }
      row.append(label);
      row.addEventListener("mousemove", () => {
        if (selected !== i) {
          selected = i;
          render();
        }
      });
      row.addEventListener("click", (e) => pick(e.metaKey || e.ctrlKey));
      list.append(row);
    });
    list.querySelector(".ql-row.selected")?.scrollIntoView?.({ block: "nearest" });
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return;
      selected = (selected + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(e.metaKey || e.ctrlKey);
    }
  };

  input.addEventListener("input", () => {
    selected = 0;
    render();
  });
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  render();
  input.focus();
}
