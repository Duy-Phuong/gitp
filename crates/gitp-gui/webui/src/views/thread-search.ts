// The search over the stored Claude thread conversations (views beside the
// Pull Requests list): a box that searches 200 ms after the last key, a
// month picker, and the hits — pull request, title, file and line, the
// snippet with the words bold, the date of the last turn and the badges. A
// click opens the pull request on that thread; Esc or Back returns.
//
// The snippets are what reviewers and Claude wrote, so they are set as text.

import { clear, el } from "../dom";
import { fullTime, relativeTime } from "../timeago";
import { highlightParts, keptMonths, monthRange, parseThreadQuery, searchStatus } from "../thread-search";
import type { ThreadHit, ThreadSearch } from "../types";

export interface ThreadSearchCallbacks {
  search: (query: string, range: [number, number] | null, pr: number | null) => Promise<ThreadSearch>;
  open: (hit: ThreadHit) => void;
  back: () => void;
  reportError: (title: string, err: unknown) => void;
  // Today, for the months offered.
  now?: () => Date;
}

export interface ThreadSearchHandle {
  // The cursor in the box, and the search run again: the files change.
  show: () => void;
}

export const SEARCH_DEBOUNCE_MS = 200;

export function setupThreadSearchView(host: HTMLElement, cb: ThreadSearchCallbacks): ThreadSearchHandle {
  // Drops an answer for a query that is no longer the latest.
  let generation = 0;
  let timer: number | undefined;

  const back = el("button", { class: "btn small ghost ts-back", text: "← Back", title: "Back to where you were (Esc)" });
  back.addEventListener("click", () => cb.back());
  const box = el("input", {
    class: "prl-search ts-search",
    type: "search",
    placeholder: "Words, a file, #123 for one pull request",
    "aria-label": "Search conversations",
    spellcheck: "false",
  });
  const month = el("select", { class: "ts-month", "aria-label": "Month" });
  const status = el("span", { class: "ts-status" });
  const list = el("div", { class: "ts-list" });
  host.append(
    el("div", { class: "prl-head" }, [
      el("div", { class: "prl-head-row" }, [el("span", { class: "prl-title-text", text: "Search conversations" }), el("span", { class: "spacer" }), back]),
      el("div", { class: "prl-head-row" }, [box, month, el("span", { class: "spacer" }), status]),
    ]),
    list,
  );

  const fillMonths = () => {
    const chosen = month.value;
    clear(month);
    month.append(el("option", { value: "", text: "Any month" }));
    for (const m of keptMonths(cb.now?.() ?? new Date())) month.append(el("option", { value: `${m.year}-${m.month}`, text: m.label }));
    month.value = [...month.options].some((o) => o.value === chosen) ? chosen : "";
  };

  const range = (): [number, number] | null => {
    const [y, m] = month.value.split("-").map(Number);
    return month.value ? monthRange(y, m) : null;
  };

  async function run(): Promise<void> {
    window.clearTimeout(timer);
    const mine = ++generation;
    const q = parseThreadQuery(box.value);
    try {
      const found = await cb.search(q.text, range(), q.pr);
      if (mine !== generation) return;
      draw(found, q.text);
    } catch (err) {
      if (mine !== generation) return;
      status.textContent = "Couldn't search.";
      cb.reportError("Couldn't search the conversations", err);
    }
  }

  function draw(found: ThreadSearch, words: string): void {
    status.textContent = searchStatus(found.hits.length, found.total);
    clear(list);
    for (const h of found.hits) list.append(row(h, words));
  }

  function row(h: ThreadHit, words: string): HTMLElement {
    const secs = Math.floor(h.at / 1000);
    const top = el("div", { class: "ts-row-top" }, [el("span", { class: "ts-pr", text: `#${h.pr}` })]);
    if (h.title) top.append(el("span", { class: "ts-title", text: h.title }));
    top.append(el("span", { class: "spacer" }), el("span", { class: "ts-date", text: relativeTime(secs), title: fullTime(secs) }));
    const place = el("div", { class: "ts-row-place" }, [el("code", { class: "ts-place", text: h.line ? `${h.path}:${h.line}` : h.path })]);
    if (h.fixed) place.append(el("span", { class: "pr-badge ts-badge", text: "fixed" }));
    if (h.reply_state) place.append(el("span", { class: "pr-badge ts-badge", text: h.reply_state === "ready" ? "reply ready" : "posted" }));
    const snippet = el("div", { class: "ts-snippet" }, highlightParts(h.snippet, words).map((p) => (p.bold ? el("b", { text: p.text }) : p.text)));
    const lines = [top, place];
    if (h.dropped) lines.push(el("div", { class: "ts-row-dropped" }, [el("span", { class: "pr-badge ts-dropped", text: "dropped" }), snippet]));
    else lines.push(snippet);
    const node = el("div", { class: "ts-row", role: "button", tabindex: 0, title: `Open #${h.pr} on this thread` }, lines);
    node.addEventListener("click", () => cb.open(h));
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter") cb.open(h);
    });
    return node;
  }

  box.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), SEARCH_DEBOUNCE_MS);
  });
  month.addEventListener("change", () => void run());
  host.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    cb.back();
  });

  return {
    show: () => {
      fillMonths();
      box.focus();
      void run();
    },
  };
}
