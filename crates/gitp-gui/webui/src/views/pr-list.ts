// The Pull Requests view: the sidebar's list of the repo's pull requests, as a
// table across the main panel. It shares the sidebar's All / Created by me /
// Review requested / Reviewed filter and its search, and adds its own by
// authors (any of several), base branch, checks, review and draft, and a
// sort by any column.
// A row opens its pull request; its corner arrows, in a tab of its own.

import { clear, el, svg } from "../dom";
import {
  filterPrList,
  hasPrListFilters,
  isoSeconds,
  NO_PR_LIST_FILTERS,
  prAttentionTags,
  PR_FILTERS,
  prListChoices,
  prMatches,
  prNumberQuery,
  reviewDecisionLabel,
  sortPrList,
  type PrListFilters,
  type PrSortKey,
} from "../pull-requests";
import { relativeTime } from "../timeago";
import type { PrFilter, PullRequest } from "../types";
import { labelChip } from "./pull-request";
import type { PrSectionState } from "./sidebar";

export interface PullRequestListCallbacks {
  open: (number: number) => void;
  openInTab: (pr: PullRequest) => void;
  menu: (pr: PullRequest, x: number, y: number) => void;
  setFilter: (filter: PrFilter) => void;
  search: (text: string) => void;
  refresh: () => void;
  signIn: () => void;
  // The saved review's badge, as the sidebar shows it.
  reviewBadge: (pr: PullRequest) => { kind: string; text: string } | null;
  // The search over the stored Claude thread conversations.
  searchConversations: () => void;
}

export interface PullRequestListHandle {
  // Draw it again from `prs`: the list, a filter or the search changed.
  render: (prs: PrSectionState) => void;
  // The cursor in the search box.
  focusSearch: () => void;
}

const COLUMNS: { key: PrSortKey | null; label: string; cls: string }[] = [
  { key: null, label: "", cls: "prl-checks" },
  { key: "number", label: "#", cls: "prl-number" },
  { key: "title", label: "Title", cls: "prl-title" },
  { key: "author", label: "Author", cls: "prl-author" },
  { key: "branches", label: "Base ← Head", cls: "prl-branches" },
  { key: "review", label: "Review", cls: "prl-review" },
  { key: "updated", label: "Updated", cls: "prl-updated" },
  { key: null, label: "", cls: "prl-actions" },
];

// Arrows to the corners, as on the pull request's own button.
const TAB_ICON = ["M15 3h6v6", "M21 3l-7 7", "M9 21H3v-6", "M3 21l7-7"];

export function setupPullRequestListView(host: HTMLElement, cb: PullRequestListCallbacks): PullRequestListHandle {
  let filters: PrListFilters = { ...NO_PR_LIST_FILTERS };
  let sort: { key: PrSortKey; descending: boolean } = { key: "updated", descending: true };
  let last: PrSectionState | null = null;
  // The author checklist is open: kept across a redraw, as the list may
  // change under it.
  let authorsOpen = false;

  // Built once, so typing in the search keeps its cursor while the table
  // below is drawn again.
  const title = el("span", { class: "prl-title-text" });
  const refresh = el("button", { class: "btn small ghost", text: "⟳ Refresh", title: "Read the pull requests again from GitHub" });
  refresh.addEventListener("click", () => cb.refresh());
  const searchConversations = el("button", { class: "btn small ghost", text: "Search conversations", title: "Search the Claude conversations kept on the threads" });
  searchConversations.addEventListener("click", () => cb.searchConversations());
  const segs = el("div", { class: "seg-toggle", role: "group" });
  const search = el("input", {
    class: "prl-search",
    type: "search",
    placeholder: "Search: title, #number, author, branch",
    "aria-label": "Search pull requests",
    spellcheck: "false",
  });
  search.addEventListener("input", () => cb.search(search.value));
  const pickers = el("div", { class: "prl-pickers" });
  const count = el("span", { class: "prl-count" });
  const body = el("div", { class: "prl-body" });
  host.append(
    el("div", { class: "prl-head" }, [
      el("div", { class: "prl-head-row" }, [title, el("span", { class: "spacer" }), searchConversations, refresh]),
      el("div", { class: "prl-head-row" }, [segs, search]),
      el("div", { class: "prl-head-row" }, [pickers, el("span", { class: "spacer" }), count]),
    ]),
    body,
  );

  // A click outside the author checklist, or Esc, closes it.
  document.addEventListener("mousedown", (e) => {
    if (!authorsOpen || (e.target as Element).closest(".prl-authors")) return;
    authorsOpen = false;
    draw();
  });
  host.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !authorsOpen) return;
    e.preventDefault(); // not the pull request tab's Esc
    authorsOpen = false;
    draw();
  });

  // "Author: any", one name, or "3 authors", opening a checklist of the
  // authors with how many pull requests each has open.
  const authorPicker = (list: PullRequest[], authors: string[]): HTMLElement => {
    const chosen = filters.authors;
    const button = el("button", {
      class: `prl-picker prl-authors-button${chosen.length ? " set" : ""}`,
      text: `${chosen.length === 0 ? "any" : chosen.length === 1 ? chosen[0] : `${chosen.length} authors`} ▾`,
      title: chosen.join(", ") || "Pick one author or more",
      "aria-haspopup": "true",
      "aria-expanded": String(authorsOpen),
    });
    button.addEventListener("click", () => {
      authorsOpen = !authorsOpen;
      draw();
    });
    const wrap = el("div", { class: "prl-authors" }, [button]);
    if (!authorsOpen) return el("label", { class: "prl-picker-label" }, ["Author", wrap]);
    const menu = el("div", { class: "prl-authors-menu", role: "group", "aria-label": "Authors" });
    // An author chosen before may have no open pull request in this list.
    for (const a of [...new Set([...authors, ...chosen])]) {
      const box = el("input", { type: "checkbox" });
      box.checked = chosen.includes(a);
      box.addEventListener("change", () => {
        filters = { ...filters, authors: box.checked ? [...chosen, a] : chosen.filter((x) => x !== a) };
        draw();
      });
      const n = list.filter((pr) => pr.author === a).length;
      menu.append(el("label", { class: "prl-authors-row" }, [box, el("span", { text: a }), el("span", { class: "prl-authors-n", text: String(n) })]));
    }
    if (chosen.length) {
      const none = el("button", { class: "btn small ghost", text: "Any author" });
      none.addEventListener("click", () => {
        filters = { ...filters, authors: [] };
        draw();
      });
      menu.append(none);
    }
    wrap.append(menu);
    return el("div", { class: "prl-picker-label" }, ["Author", wrap]);
  };

  const picker = (label: string, key: Exclude<keyof PrListFilters, "authors">, options: [string, string][]): HTMLElement => {
    const select = el("select", { class: "prl-picker", "aria-label": label });
    for (const [value, text] of [["", "any"], ...options]) {
      const o = el("option", { value, text });
      if (value === filters[key]) o.setAttribute("selected", "");
      select.append(o);
    }
    select.addEventListener("change", () => {
      filters = { ...filters, [key]: select.value };
      draw();
    });
    return el("label", { class: "prl-picker-label" }, [label, select]);
  };

  function draw(): void {
    const p = last;
    if (!p) return;
    title.textContent = p.repo ? `Pull Requests · ${p.repo}` : "Pull Requests";
    clear(segs);
    for (const f of PR_FILTERS) {
      const b = el("button", { class: f.value === p.filter ? "seg active" : "seg", text: f.label });
      b.addEventListener("click", () => cb.setFilter(f.value));
      segs.append(b);
    }
    if (document.activeElement !== search && search.value !== p.query) search.value = p.query;
    clear(body);
    clear(pickers);
    count.textContent = "";

    const note = (text: string, cls = "") => body.append(el("div", { class: `prl-note ${cls}`.trim(), text }));
    const account = p.account;
    if (!p.repo) return note("This repository isn't on GitHub.");
    if (!account) return note("Checking GitHub…");
    if (!account.installed) return note("Install the GitHub CLI to see pull requests: brew install gh");
    if (!account.signed_in) {
      const signIn = el("button", { class: "btn small", text: "Sign in to GitHub" });
      signIn.addEventListener("click", () => cb.signIn());
      body.append(el("div", { class: "prl-note" }, [signIn]));
      if (account.message) note(account.message, "prl-error");
      return;
    }
    if (p.error) note(p.error, "prl-error");
    if (!p.list) return void (p.loading && note("Loading…"));

    const { authors, bases } = prListChoices(p.list);
    pickers.append(
      authorPicker(p.list, authors),
      picker("Base", "base", bases.map((b) => [b, b])),
      picker("Checks", "checks", [
        ["success", "passing"],
        ["failure", "failing"],
        ["pending", "pending"],
        ["none", "none"],
      ]),
      picker("Review", "review", [
        ["APPROVED", "approved"],
        ["CHANGES_REQUESTED", "changes requested"],
        ["REVIEW_REQUIRED", "review required"],
        ["none", "none"],
      ]),
      picker("State", "draft", [
        ["ready", "ready"],
        ["draft", "draft"],
      ]),
    );
    if (hasPrListFilters(filters)) {
      const reset = el("button", { class: "btn small ghost", text: "Clear filters" });
      reset.addEventListener("click", () => {
        filters = { ...NO_PR_LIST_FILTERS };
        authorsOpen = false;
        draw();
      });
      pickers.append(reset);
    }

    const q = p.query.trim().toLowerCase();
    const reviewed = new Set(p.reviewFiles.map((f) => f.number));
    const shown = sortPrList(
      filterPrList(
        p.list.filter(
          (pr) => prMatches(pr, (t) => t.toLowerCase().includes(q)) && (p.filter !== "reviewed" || reviewed.has(pr.number)),
        ),
        filters,
      ),
      sort.key,
      sort.descending,
    );
    count.textContent = `${shown.length} of ${p.list.length}`;

    // A number the list doesn't hold: GitHub has it, so offer to open it.
    const number = prNumberQuery(p.query);
    if (number !== null && !p.list.some((pr) => pr.number === number)) {
      const open = el("button", { class: "btn small", text: `Open #${number} from GitHub` });
      open.addEventListener("click", () => cb.open(number));
      body.append(el("div", { class: "prl-note" }, [open]));
    }
    if (shown.length === 0) {
      note(p.list.length ? "No pull request matches." : p.filter === "merged" ? "No merged pull requests." : "No open pull requests.");
      return;
    }
    const table = el("table", { class: "prl-table" });
    const headRow = el("tr");
    for (const c of COLUMNS) {
      // The merged list dates each by its merge.
      const th = el("th", { class: c.cls, text: c.key === "updated" && p.filter === "merged" ? "Merged" : c.label });
      if (c.key) {
        const key = c.key;
        th.classList.add("sortable");
        if (sort.key === key) th.append(el("span", { class: "prl-sort", text: sort.descending ? " ▾" : " ▴" }));
        th.title = "Sort by this column; again to flip";
        th.addEventListener("click", () => {
          // Text sorts A to Z first; numbers and dates, the largest first.
          const first = key === "number" || key === "updated";
          sort = sort.key === key ? { key, descending: !sort.descending } : { key, descending: first };
          draw();
        });
      }
      headRow.append(th);
    }
    const rows = el("tbody");
    for (const pr of shown) rows.append(row(pr, p.open));
    table.append(el("thead", {}, [headRow]), rows);
    body.append(table);
  }

  function row(pr: PullRequest, open: number | null): HTMLElement {
    const titleLine = el("div", { class: "prl-title-line" }, [el("span", { class: "prl-title-text", text: pr.title })]);
    if (pr.is_draft) titleLine.append(el("span", { class: "sb-badge", text: "draft" }));
    for (const tag of prAttentionTags(pr)) titleLine.append(el("span", { class: `pr-flag ${tag.kind}`, text: tag.text, title: tag.title }));
    const saved = cb.reviewBadge(pr);
    if (saved) titleLine.append(el("span", { class: `sb-badge pr-review-${saved.kind}`, text: saved.text }));
    for (const label of pr.labels) titleLine.append(labelChip(label));
    const titleCell = el("td", { class: "prl-title" }, [titleLine]);
    const review = reviewDecisionLabel(pr.review_decision);
    const inTab = el("button", { class: "btn small ghost pr-icon-btn", title: `Open #${pr.number} in a tab of its own` });
    inTab.setAttribute("aria-label", "Open in a tab");
    const icon = svg("svg", { viewBox: "0 0 24 24", class: "tb-icon", "aria-hidden": "true" });
    for (const d of TAB_ICON) icon.append(svg("path", { d }));
    inTab.append(icon);
    inTab.addEventListener("click", (e) => {
      e.stopPropagation();
      cb.openInTab(pr);
    });
    const tr = el("tr", { class: `prl-row${open === pr.number ? " open" : ""}`, title: "Click: open · Right-click: actions" }, [
      el("td", { class: "prl-checks", title: pr.checks ? `checks: ${pr.checks}` : "no checks" }, [
        el("span", { class: `pr-check-dot ${pr.checks ?? "none"}` }),
      ]),
      el("td", { class: "prl-number", text: `#${pr.number}` }),
      titleCell,
      el("td", { class: "prl-author", text: pr.author }),
      el("td", { class: "prl-branches", title: `${pr.head} into ${pr.base}` }, [
        el("code", { text: pr.base }),
        " ← ",
        el("code", { text: pr.head }),
      ]),
      el("td", { class: "prl-review" }, review ? [el("span", { class: `sb-badge review-${pr.review_decision!.toLowerCase()}`, text: review })] : []),
      el("td", {
        class: "prl-updated",
        title: pr.merged_at ? `merged ${pr.merged_at}` : pr.updated_at,
        text: relativeTime(isoSeconds(pr.merged_at ?? pr.updated_at)),
      }),
      el("td", { class: "prl-actions" }, [inTab]),
    ]);
    tr.addEventListener("click", () => cb.open(pr.number));
    tr.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      cb.menu(pr, e.clientX, e.clientY);
    });
    return tr;
  }

  return {
    render: (prs) => {
      last = prs;
      draw();
    },
    focusSearch: () => search.focus(),
  };
}
