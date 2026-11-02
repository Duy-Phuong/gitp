// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { openQuickOpen } from "./quick-open";
import type { FileEntry } from "../../types";

const entry = (path: string): FileEntry => ({ path, size: 1, lang: null, mtime_ms: 1 });
const files = ["src/cart.ts", "src/chart.ts", "docs/notes.md", "README.md", ...Array.from({ length: 80 }, (_, i) => `gen/file${i}.ts`)].map(entry);

const overlay = () => document.querySelector<HTMLElement>(".ql-overlay");
const rows = () => [...document.querySelectorAll<HTMLElement>(".ql-overlay .ql-row")];
const type = (text: string) => {
  const input = document.querySelector<HTMLInputElement>(".ql-overlay input")!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const key = (k: string, mods: Partial<{ meta: boolean; ctrl: boolean }> = {}) =>
  document.querySelector<HTMLInputElement>(".ql-overlay input")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, bubbles: true, cancelable: true }));

afterEach(() => overlay()?.remove());

describe("openQuickOpen", () => {
  it("typing filters the files and bolds the matched characters", () => {
    openQuickOpen(files, () => {});
    type("cart");
    expect(rows().map((r) => r.dataset.path)).toEqual(["src/cart.ts", "src/chart.ts"]);
    expect(rows()[0].querySelectorAll("b").length).toBe(4);
  });

  it("finds gitignored files too, greyed", () => {
    const pick = vi.fn();
    openQuickOpen(files, pick, [], ["target/notes/3.36.0.md"]);
    type("3.36.0");
    expect(rows().map((r) => r.dataset.path)).toEqual(["target/notes/3.36.0.md"]);
    expect(rows()[0].classList.contains("ql-row-ignored")).toBe(true);
    key("Enter");
    expect(pick).toHaveBeenCalledWith("target/notes/3.36.0.md", false);
  });

  it("Enter picks the highlighted row; arrows move it", () => {
    const pick = vi.fn();
    openQuickOpen(files, pick);
    type("cart");
    key("ArrowDown");
    key("Enter");
    expect(pick).toHaveBeenCalledWith("src/chart.ts", false);
    expect(overlay()).toBeNull();
  });

  it("Mod+Enter asks to reveal in the explorer", () => {
    const pick = vi.fn();
    openQuickOpen(files, pick);
    type("notes");
    key("Enter", { meta: true });
    expect(pick).toHaveBeenCalledWith("docs/notes.md", true);
  });

  it("Escape closes without a pick", () => {
    const pick = vi.fn();
    openQuickOpen(files, pick);
    key("Escape");
    expect(pick).not.toHaveBeenCalled();
    expect(overlay()).toBeNull();
  });

  it("shows at most 50 rows", () => {
    openQuickOpen(files, () => {});
    type("");
    expect(rows().length).toBe(50);
    type("file");
    expect(rows().length).toBe(50);
  });

  it("an empty query lists recent files first, newest first, then the rest", () => {
    openQuickOpen(files, () => {}, ["README.md", "src/cart.ts", "gone.ts"]);
    expect(rows().slice(0, 3).map((r) => r.dataset.path)).toEqual(["README.md", "src/cart.ts", expect.any(String)]);
    expect([...document.querySelectorAll(".ql-overlay .ql-section")].map((h) => h.textContent)).toEqual(["Recently opened", "Files"]);
    expect(rows().filter((r) => r.dataset.path === "README.md")).toHaveLength(1); // not again under Files
    expect(rows().some((r) => r.dataset.path === "gone.ts")).toBe(false); // deleted since
  });

  it("Enter on an empty query opens the most recent file", () => {
    const pick = vi.fn();
    openQuickOpen(files, pick, ["docs/notes.md"]);
    key("Enter");
    expect(pick).toHaveBeenCalledWith("docs/notes.md", false);
  });

  it("typing searches all files and drops the sections", () => {
    openQuickOpen(files, () => {}, ["README.md"]);
    type("cart");
    expect(rows().map((r) => r.dataset.path)).toEqual(["src/cart.ts", "src/chart.ts"]);
    expect(document.querySelector(".ql-overlay .ql-section")).toBeNull();
  });
});
