// When a name has several possible definitions (the same method in three
// classes), a small list at the caret: arrows move, Enter picks, Escape
// leaves. Resolves with the pick, or null.

import { clear, el } from "../../dom";
import type { Symbol } from "../../types";

export function showDefinitionPicker(anchor: { x: number; y: number }, items: Symbol[]): Promise<Symbol | null> {
  return new Promise((resolve) => {
    const box = el("div", { class: "code-picker", role: "listbox" });
    let index = 0;
    const done = (pick: Symbol | null) => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onOutside, true);
      box.remove();
      resolve(pick);
    };
    const render = () => {
      clear(box);
      items.forEach((s, i) => {
        const row = el("div", { class: `code-picker-row${i === index ? " active" : ""}`, role: "option" }, [
          el("span", { class: "code-picker-kind" }, [s.kind]),
          el("span", { class: "code-picker-name" }, [s.name]),
          el("span", { class: "code-picker-where" }, [`${s.path}:${s.name_range.start_line + 1}`]),
        ]);
        row.addEventListener("click", () => done(s));
        row.addEventListener("mousemove", () => {
          if (index !== i) {
            index = i;
            render();
          }
        });
        box.append(row);
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") index = (index + 1) % items.length;
      else if (e.key === "ArrowUp") index = (index - 1 + items.length) % items.length;
      else if (e.key === "Enter") return void (e.preventDefault(), done(items[index]));
      else if (e.key === "Escape") return void (e.preventDefault(), done(null));
      else return;
      e.preventDefault();
      render();
    };
    const onOutside = (e: MouseEvent) => {
      if (!box.contains(e.target as Node)) done(null);
    };
    render();
    box.style.left = `${Math.max(8, Math.min(anchor.x, window.innerWidth - 420))}px`;
    box.style.top = `${Math.min(anchor.y + 18, window.innerHeight - 40 - Math.min(items.length, 8) * 26)}px`;
    document.body.append(box);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onOutside, true);
  });
}
