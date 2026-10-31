// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupSearchPanel } from "./search-panel";
import type { SearchQuery, SearchResult } from "../../types";

const hit = (path: string, line: number, col: number, text: string, end = col + 5) => ({ path, line, col, end_col: end, text });

function setup(results: SearchResult | (() => Promise<SearchResult>) = { hits: [], truncated: false, files_searched: 0 }) {
  const host = document.createElement("div");
  document.body.append(host);
  const search = vi.fn(typeof results === "function" ? results : async () => results);
  const jump = vi.fn();
  const panel = setupSearchPanel(host, { search, jump });
  const input = host.querySelector<HTMLInputElement>("input.code-search-input")!;
  const type = (text: string) => {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  return { host, search, jump, panel, input, type };
}

describe("setupSearchPanel", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("groups hits by file with the match highlighted", async () => {
    const { host, type } = setup({ hits: [hit("a.ts", 2, 4, "let total = 1;"), hit("a.ts", 7, 0, "total();"), hit("b.py", 0, 2, "x total")], truncated: false, files_searched: 3 });
    type("total");
    await vi.advanceTimersByTimeAsync(300);
    const files = [...host.querySelectorAll<HTMLElement>(".code-search-file")].map((f) => f.dataset.path);
    expect(files).toEqual(["a.ts", "b.py"]);
    const rows = [...host.querySelectorAll<HTMLElement>(".code-search-hit")];
    expect(rows.length).toBe(3);
    expect(rows[0].querySelector("mark")?.textContent).toBe("total");
    expect(rows[0].textContent).toContain("3"); // the 1-based line number
    expect(host.querySelector(".code-search-summary")?.textContent).toContain("3 hits in 2 files");
  });

  it("debounces typing by 250 ms", async () => {
    const { search, type } = setup();
    type("t");
    type("to");
    await vi.advanceTimersByTimeAsync(200);
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith({ pattern: "to", regex: false, case_sensitive: false, whole_word: false, include_glob: null });
  });

  it("drops a stale response that arrives after a newer query's", async () => {
    let resolveFirst!: (r: SearchResult) => void;
    const first = new Promise<SearchResult>((r) => (resolveFirst = r));
    const search = vi.fn<(q: SearchQuery) => Promise<SearchResult>>();
    search.mockReturnValueOnce(first).mockResolvedValueOnce({ hits: [hit("new.ts", 0, 0, "second")], truncated: false, files_searched: 1 });
    const host = document.createElement("div");
    document.body.append(host);
    setupSearchPanel(host, { search, jump: () => {} });
    const input = host.querySelector<HTMLInputElement>("input.code-search-input")!;
    input.value = "a";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(260);
    input.value = "ab";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(260);
    resolveFirst({ hits: [hit("old.ts", 0, 0, "first")], truncated: false, files_searched: 1 });
    await vi.advanceTimersByTimeAsync(0);
    const files = [...host.querySelectorAll<HTMLElement>(".code-search-file")].map((f) => f.dataset.path);
    expect(files).toEqual(["new.ts"]);
  });

  it("a click jumps to the hit's line and columns", async () => {
    const { host, jump, type } = setup({ hits: [hit("a.ts", 4, 6, "xx total yy", 11)], truncated: false, files_searched: 1 });
    type("total");
    await vi.advanceTimersByTimeAsync(300);
    host.querySelector<HTMLElement>(".code-search-hit")!.click();
    expect(jump).toHaveBeenCalledWith({ path: "a.ts", line: 4, col: 6 }, 11);
  });

  it("says when the results were cut off", async () => {
    const { host, type } = setup({ hits: [hit("a.ts", 0, 0, "x")], truncated: true, files_searched: 9 });
    type("x");
    await vi.advanceTimersByTimeAsync(300);
    expect(host.querySelector(".code-search-summary")?.textContent).toContain("narrowed");
  });

  it("shows the backend's error text", async () => {
    const { host, type } = setup(async () => {
      throw new Error("regex parse error: unclosed group");
    });
    type("(");
    await vi.advanceTimersByTimeAsync(300);
    expect(host.querySelector(".code-search-error")?.textContent).toContain("unclosed group");
  });

  it("the toggles and the glob go into the query", async () => {
    const { host, search, type } = setup();
    host.querySelector<HTMLElement>('[data-toggle="regex"]')!.click();
    host.querySelector<HTMLElement>('[data-toggle="case"]')!.click();
    host.querySelector<HTMLElement>('[data-toggle="word"]')!.click();
    const glob = host.querySelector<HTMLInputElement>("input.code-search-glob")!;
    glob.value = "*.ts";
    glob.dispatchEvent(new Event("input", { bubbles: true }));
    type("x");
    await vi.advanceTimersByTimeAsync(300);
    expect(search).toHaveBeenLastCalledWith({ pattern: "x", regex: true, case_sensitive: true, whole_word: true, include_glob: "*.ts" });
  });
});
