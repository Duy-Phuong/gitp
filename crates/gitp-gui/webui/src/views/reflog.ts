// The Reflog view: every position HEAD (or one branch) has held, newest first,
// so a commit that a reset, amend, rebase or deleted branch left unreachable
// can be found and brought back — Undo only remembers the last action.
//
// It sits where the log does and borrows History's detail pane: selecting an
// entry shows its commit there. The recovery actions (right-click, or the ⋯
// button) are the caller's — this view only lists and selects.

import { clear, el } from "../dom";
import { relativeTime } from "../timeago";
import type { ReflogEntry } from "../types";

export interface ReflogCallbacks {
  fetch: (refname: string) => Promise<ReflogEntry[]>;
  onSelect: (entry: ReflogEntry) => void;
  onMenu: (entry: ReflogEntry, x: number, y: number) => void;
  reportError: (title: string, err: unknown) => void;
}

export interface ReflogHandle {
  // Which reflog to list on the next reload: `HEAD` or `refs/heads/<name>`.
  setRef: (refname: string) => void;
  reload: () => Promise<void>;
  // Back to HEAD — a branch picked in one repo needn't exist in the next.
  reset: () => void;
}

// Split git's reflog message at its first ": " into the action and what it
// acted on: "commit (amend): fix: typo" → { action: "commit (amend)", detail:
// "fix: typo" }. A message without one (written by some other tool) is all
// detail.
export function splitReflogMessage(message: string): { action: string; detail: string } {
  const m = /^([^:\n]{1,60}): (.*)$/s.exec(message);
  return m ? { action: m[1], detail: m[2] } : { action: "", detail: message };
}

// An entry's identity across reloads. Its index shifts by one with every new
// move, so the selection is kept by what the entry *is* instead.
function entryKey(e: ReflogEntry): string {
  return `${e.time}:${e.old_id}:${e.new_id}:${e.message}`;
}

export function setupReflog(host: HTMLElement, cb: ReflogCallbacks): ReflogHandle {
  let refname = "HEAD";
  let entries: ReflogEntry[] = [];
  let selectedKey: string | null = null;
  // Drops a slow reload's result once a newer one has started.
  let generation = 0;

  const title = el("span", { class: "reflog-title" });
  const headBtn = el("button", { class: "btn small ghost", text: "Show HEAD", title: "Show HEAD's reflog" });
  headBtn.addEventListener("click", () => {
    refname = "HEAD";
    void reload();
  });
  const list = el("div", { class: "log-pane reflog-pane", tabindex: "0" });
  host.append(el("div", { class: "log-toolbar" }, [title, headBtn]), list);

  list.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
    if (!step || !entries.length) return;
    e.preventDefault();
    const at = entries.findIndex((x) => entryKey(x) === selectedKey);
    select(entries[Math.max(0, Math.min(entries.length - 1, at + step))], true);
  });

  function select(entry: ReflogEntry, scroll = false): void {
    const key = entryKey(entry);
    if (key === selectedKey) return;
    selectedKey = key;
    for (const row of list.querySelectorAll<HTMLElement>(".reflog-row")) {
      row.classList.toggle("selected", row.dataset.key === key);
      if (scroll && row.dataset.key === key) row.scrollIntoView({ block: "nearest" });
    }
    cb.onSelect(entry);
  }

  function render(): void {
    const short = refname.replace(/^refs\/heads\//, "");
    title.textContent = `Reflog of ${short}`;
    headBtn.style.display = refname === "HEAD" ? "none" : "";
    const keep = list.scrollTop;
    clear(list);
    if (!entries.length) {
      list.append(el("div", { class: "detail-empty", text: `${short} has no reflog entries.` }));
      return;
    }
    for (const entry of entries) list.append(row(entry));
    list.scrollTop = keep;
  }

  function row(entry: ReflogEntry): HTMLElement {
    const key = entryKey(entry);
    const gone = entry.summary === null;
    const { action, detail } = splitReflogMessage(entry.message);
    const tip = [
      `${entry.selector} · ${entry.new_id}`,
      entry.message,
      gone ? "The commit no longer exists (pruned)." : `Commit: ${entry.summary}`,
      "Click: show commit · Right-click: actions",
    ].join("\n");
    const more = el("button", { class: "reflog-more", title: "Actions", "aria-label": "Actions", text: "⋯" });
    const r = el(
      "div",
      { class: `commit-row reflog-row${key === selectedKey ? " selected" : ""}${gone ? " gone" : ""}`, title: tip },
      [
        el("span", { class: "reflog-selector", text: entry.selector }),
        ...(action ? [el("span", { class: "reflog-action", text: action })] : []),
        el("span", { class: "commit-summary", text: detail }),
        el("span", { class: "commit-meta", text: relativeTime(entry.time) }),
        el("span", { class: "commit-sha", text: entry.short_id }),
        more,
      ],
    );
    r.dataset.key = key;
    r.addEventListener("click", () => select(entry));
    r.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      select(entry);
      cb.onMenu(entry, e.clientX, e.clientY);
    });
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      select(entry);
      const rect = more.getBoundingClientRect();
      cb.onMenu(entry, rect.left, rect.bottom);
    });
    return r;
  }

  async function reload(): Promise<void> {
    const mine = ++generation;
    let fetched: ReflogEntry[];
    try {
      fetched = await cb.fetch(refname);
    } catch (err) {
      if (mine === generation) cb.reportError("Failed to load the reflog", err);
      return;
    }
    if (mine !== generation) return;
    entries = fetched;
    const kept = entries.find((e) => entryKey(e) === selectedKey);
    render();
    // Show something in the shared detail pane right away: the newest entry,
    // unless the one already selected is still listed.
    if (!kept && entries.length) select(entries[0]);
  }

  return {
    setRef: (name) => {
      refname = name;
    },
    reload,
    reset: () => {
      refname = "HEAD";
      entries = [];
      selectedKey = null;
    },
  };
}
