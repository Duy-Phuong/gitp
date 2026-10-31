// Find in files: a query with Regex / Match case / Whole word toggles and an
// include glob, results grouped by file with the match marked in the line.
// Typing is debounced; a reply that arrives after a newer query's is dropped.

import { clear, el } from "../../dom";
import type { Location, SearchQuery, SearchResult } from "../../types";

const DEBOUNCE_MS = 250;

export interface SearchPanelDeps {
  search: (query: SearchQuery) => Promise<SearchResult>;
  jump: (loc: Location, endCol: number) => void;
}

export interface SearchPanelHandle {
  focus: () => void;
  // Search `text` as if typed (from a selection in the editor).
  query: (text: string) => void;
}

export function setupSearchPanel(host: HTMLElement, deps: SearchPanelDeps): SearchPanelHandle {
  const input = el("input", { class: "code-search-input", type: "text", placeholder: "Find in files…", spellcheck: "false" });
  const glob = el("input", { class: "code-search-glob", type: "text", placeholder: "files to include, e.g. *.ts", spellcheck: "false" });
  const toggles = { regex: false, case: false, word: false };
  const toggleButtons = (Object.keys(toggles) as (keyof typeof toggles)[]).map((name) => {
    const titles = { regex: "Regular expression", case: "Match case", word: "Whole word" };
    const labels = { regex: ".*", case: "Aa", word: "ab" };
    const btn = el("button", { class: "code-search-toggle", "data-toggle": name, title: titles[name], type: "button" }, [labels[name]]);
    btn.addEventListener("click", () => {
      toggles[name] = !toggles[name];
      btn.classList.toggle("on", toggles[name]);
      schedule();
    });
    return btn;
  });
  const summary = el("div", { class: "code-search-summary" });
  const results = el("div", { class: "code-search-results" });
  clear(host);
  host.append(el("div", { class: "code-search-bar" }, [input, ...toggleButtons, glob]), summary, results);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  const currentQuery = (): SearchQuery => ({
    pattern: input.value,
    regex: toggles.regex,
    case_sensitive: toggles.case,
    whole_word: toggles.word,
    include_glob: glob.value.trim() || null,
  });

  const run = async () => {
    const q = currentQuery();
    const mine = ++seq;
    if (!q.pattern) {
      clear(results);
      summary.textContent = "";
      return;
    }
    let result: SearchResult;
    try {
      result = await deps.search(q);
    } catch (err) {
      if (mine !== seq) return;
      clear(results);
      summary.textContent = "";
      results.append(el("div", { class: "code-search-error" }, [String(err instanceof Error ? err.message : err)]));
      return;
    }
    if (mine !== seq) return;
    render(result);
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), DEBOUNCE_MS);
  };

  const render = (r: SearchResult) => {
    clear(results);
    const byFile = new Map<string, SearchResult["hits"]>();
    for (const h of r.hits) {
      let list = byFile.get(h.path);
      if (!list) byFile.set(h.path, (list = []));
      list.push(h);
    }
    const n = r.hits.length;
    summary.textContent = n
      ? `${n} hit${n === 1 ? "" : "s"} in ${byFile.size} file${byFile.size === 1 ? "" : "s"}${r.truncated ? " · narrowed to the first 2 000, refine the search" : ""}`
      : `No hits in ${r.files_searched} files`;
    for (const [path, hits] of byFile) {
      const file = el("details", { class: "code-search-file", "data-path": path, open: "" }, [
        el("summary", {}, [el("span", { class: "code-search-path" }, [path]), el("span", { class: "code-search-count" }, [String(hits.length)])]),
      ]);
      for (const h of hits) {
        const row = el("div", { class: "code-search-hit", title: `${path}:${h.line + 1}:${h.col + 1}` }, [
          el("span", { class: "code-search-line" }, [String(h.line + 1)]),
          el("span", { class: "code-search-text" }, [h.text.slice(0, h.col).trimStart() === h.text.slice(0, h.col) ? h.text.slice(0, h.col) : h.text.slice(0, h.col).trimStart(), el("mark", {}, [h.text.slice(h.col, h.end_col)]), h.text.slice(h.end_col)]),
        ]);
        row.addEventListener("click", () => deps.jump({ path, line: h.line, col: h.col }, h.end_col));
        file.append(row);
      }
      results.append(file);
    }
  };

  input.addEventListener("input", schedule);
  glob.addEventListener("input", schedule);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(timer);
      void run();
    }
  });

  return {
    focus: () => {
      input.focus();
      input.select();
    },
    query: (text) => {
      input.value = text;
      clearTimeout(timer);
      void run();
    },
  };
}
