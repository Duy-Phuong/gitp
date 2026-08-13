// Commit detail: a tabbed view — Commit (metadata + message + changed files),
// Changes (file list + selected diff), and File Tree (all files at the commit).
//
// A single stateful controller owns the pane: the active tab, which file is
// selected in Changes, and the lazily-loaded file tree (cached per commit).

import { clear, el } from "../dom";
import type { CommitDetail, FileDiff } from "../types";
import { renderFileTree } from "./tree";

type Tab = "commit" | "changes" | "tree";

export interface DetailCallbacks {
  // Select another commit (used by parent-SHA clicks).
  onSelectCommit: (id: string) => void;
  // Labels of refs (branches/remotes/tags) whose tip is this commit.
  refsAt: (id: string) => string[];
  // Fetch the full file tree for a commit.
  fetchTree: (id: string) => Promise<string[]>;
}

export interface DetailHandle {
  show: (detail: CommitDetail) => void;
  showEmpty: () => void;
  // Re-render the current commit (e.g. after refs load) — no-op when empty.
  refresh: () => void;
}

export function setupDetail(host: HTMLElement, cb: DetailCallbacks): DetailHandle {
  let detail: CommitDetail | null = null;
  let tab: Tab = "commit";
  let selectedFile = 0;
  let tree: { id: string; paths: string[] } | null = null;
  const collapsed = new Set<string>(); // collapsed folders in the File Tree

  function show(next: CommitDetail): void {
    const isNewCommit = detail?.id !== next.id;
    detail = next;
    if (isNewCommit) {
      selectedFile = 0;
      tree = null;
      collapsed.clear();
    }
    render();
  }

  function showEmpty(): void {
    detail = null;
    clear(host);
    host.append(el("div", { class: "detail-empty", text: "Select a commit to view its changes." }));
  }

  function setTab(next: Tab): void {
    tab = next;
    render();
  }

  // Jump to a changed file's diff in the Changes tab (from Commit or File Tree).
  function openFileDiff(path: string): void {
    if (!detail) return;
    const idx = detail.files.findIndex((f) => f.path === path);
    if (idx < 0) return;
    selectedFile = idx;
    tab = "changes";
    render();
  }

  function render(): void {
    if (!detail) return showEmpty();
    clear(host);
    host.append(tabBar());
    const pane = el("div", { class: "detail-body-pane" });
    host.append(pane);
    if (tab === "commit") {
      const scroll = el("div", { class: "tab-scroll" });
      pane.append(scroll);
      renderCommit(scroll);
    } else if (tab === "changes") {
      renderChanges(pane);
    } else {
      renderTree(pane);
    }
  }

  function tabBar(): HTMLElement {
    const bar = el("div", { class: "detail-tabs" });
    const mk = (id: Tab, label: string) => {
      const b = el("button", { class: `detail-tab${tab === id ? " active" : ""}`, text: label });
      b.addEventListener("click", () => setTab(id));
      return b;
    };
    bar.append(mk("commit", "Commit"), mk("changes", "Changes"), mk("tree", "File Tree"));
    return bar;
  }

  function renderCommit(scroll: HTMLElement): void {
    const d = detail!;
    scroll.append(el("h2", { class: "detail-summary", text: d.summary }));

    const refs = cb.refsAt(d.id);
    if (refs.length) {
      const row = el("div", { class: "detail-refs" });
      for (const r of refs) row.append(el("span", { class: "ref-chip", text: r }));
      scroll.append(row);
    }

    const body = d.message.split("\n").slice(1).join("\n").trim();
    if (body) scroll.append(el("div", { class: "detail-body", text: body }));

    const when = new Date(d.author_time * 1000).toLocaleString();
    const meta = el("div", { class: "detail-meta" }, [
      el("div", { text: `${d.author_name} <${d.author_email}>` }),
      el("div", { text: when }),
      el("div", {}, [el("span", { text: "SHA " }), el("span", { class: "sha", text: d.id })]),
    ]);
    if (d.parents.length) {
      const p = el("div", {}, [el("span", { text: "Parents " })]);
      d.parents.forEach((par, i) => {
        if (i) p.append(document.createTextNode(" "));
        const link = el("span", { class: "sha link", text: par.slice(0, 10) });
        link.addEventListener("click", () => cb.onSelectCommit(par));
        p.append(link);
      });
      meta.append(p);
    }
    scroll.append(meta);

    if (d.files.length === 0) {
      scroll.append(el("div", { class: "detail-empty", text: "No file changes." }));
      return;
    }
    const list = el("div", { class: "file-list" });
    d.files.forEach((f, idx) =>
      list.append(fileRow(f, false, () => {
        selectedFile = idx;
        setTab("changes");
      })),
    );
    scroll.append(list);
  }

  function renderChanges(pane: HTMLElement): void {
    const d = detail!;
    if (d.files.length === 0) {
      const scroll = el("div", { class: "tab-scroll" });
      scroll.append(el("div", { class: "detail-empty", text: "No file changes." }));
      pane.append(scroll);
      return;
    }
    selectedFile = Math.min(selectedFile, d.files.length - 1);

    const split = el("div", { class: "changes-split" });
    const listCol = el("div", { class: "changes-list" });
    d.files.forEach((f, idx) =>
      listCol.append(fileRow(f, idx === selectedFile, () => {
        selectedFile = idx;
        render();
      })),
    );
    const diffCol = el("div", { class: "changes-diff" }, [renderFile(d.files[selectedFile])]);
    split.append(listCol, diffCol);
    pane.append(split);
  }

  function renderTree(pane: HTMLElement): void {
    const d = detail!;
    if (tree && tree.id === d.id) {
      const changed = new Map(d.files.map((f) => [f.path, f.status]));
      const view = el("div", { class: "tree-view" });
      pane.append(view);
      renderFileTree(view, tree.paths, {
        collapsed,
        onToggle: (p) => {
          if (collapsed.has(p)) collapsed.delete(p);
          else collapsed.add(p);
          render();
        },
        statusOf: (p) => changed.get(p) ?? null,
        onFileClick: openFileDiff,
      });
      return;
    }

    const scroll = el("div", { class: "tab-scroll" });
    scroll.append(el("div", { class: "detail-empty", text: "Loading file tree…" }));
    pane.append(scroll);

    const id = d.id;
    cb.fetchTree(id)
      .then((paths) => {
        tree = { id, paths };
        if (detail?.id === id && tab === "tree") render();
      })
      .catch(() => {
        if (detail?.id === id && tab === "tree") {
          clear(scroll);
          scroll.append(el("div", { class: "detail-empty", text: "Failed to load file tree." }));
        }
      });
  }

  // A single row in a changed-files list (Commit tab and Changes tab list).
  function fileRow(file: FileDiff, active: boolean, onClick: () => void): HTMLElement {
    const row = el("div", { class: `file-item${active ? " active" : ""}`, title: file.path });
    row.append(el("span", { class: `status-badge status-${file.status}`, text: file.status[0] }));
    const label =
      file.old_path && file.old_path !== file.path ? `${file.old_path} → ${file.path}` : file.path;
    row.append(el("span", { class: "file-item-path", text: label }));
    row.addEventListener("click", onClick);
    return row;
  }

  showEmpty();
  return {
    show,
    showEmpty,
    refresh: () => {
      if (detail) render();
    },
  };
}

// A single file's diff (head + hunks). Shared with the Local Changes view.
export function renderFile(file: FileDiff): HTMLElement {
  const container = el("div", { class: "file" });

  const head = el("div", { class: "file-head" });
  head.append(el("span", { class: `status-badge status-${file.status}`, text: file.status }));
  const label =
    file.old_path && file.old_path !== file.path ? `${file.old_path} → ${file.path}` : file.path;
  head.append(el("span", { text: label }));
  container.append(head);

  for (const hunk of file.hunks) {
    container.append(el("div", { class: "hunk-header", text: hunk.header }));
    for (const line of hunk.lines) {
      const cls =
        line.origin === "+" ? "diff-line add" : line.origin === "-" ? "diff-line del" : "diff-line";
      container.append(el("div", { class: cls, text: `${line.origin} ${line.content}` }));
    }
  }
  return container;
}
