// Commit detail: a tabbed view — Commit (metadata + message + changed files),
// Changes (file list + selected file), and File Tree (all files at the commit).
//
// In the Changes tab the selected file has its own toolbar: switch between
// Diff / Blame / History, step through changes with the arrows, and toggle a
// unified or split (side-by-side) diff, and show fewer / more / all unchanged
// lines around each change, wrap long lines, and ignore whitespace. A single
// stateful controller owns the pane: active tab, selected file, view mode,
// split flag, context size, current hunk, and the lazily-loaded tree / blame /
// history / re-contexted diff (each cached). Wrap and ignore-whitespace are
// persisted preferences shared with Local Changes (see prefs.ts).
//
// The same pane also shows a comparison of two revisions (showCompare): a
// compare header in place of the tabs, over the Changes view of the files that
// differ — so the diff renderer, context controls and Blame / History (as of
// the head side) all work unchanged.

import { DEFAULT_CONTEXT_LINES, FULL_FILE_CONTEXT } from "../api";
import { clear, copyToClipboard, el, statusBadge, svg } from "../dom";
import { loadDiffWrap, loadIgnoreWhitespace, saveDiffWrap, saveIgnoreWhitespace } from "../prefs";
import type { BlameLine, CommitDetail, CommitSignature, CompareEnd, Comparison, FileCommit, FileDiff, SignatureStatus } from "../types";
import { hunkWordDiffs, type Seg } from "../worddiff";
import { renderFileTree } from "./tree";

// Which pane of the commit detail is showing. Exported so the host can persist
// the user's choice — see initialTab / onTabChange below.
export type DetailTab = "commit" | "changes" | "tree";
type Tab = DetailTab;
type FileMode = "diff" | "blame" | "history";

export interface DetailCallbacks {
  // Select another commit (parent-SHA clicks and file-history rows).
  onSelectCommit: (id: string) => void;
  // Labels of refs (branches/remotes/tags) whose tip is this commit.
  refsAt: (id: string) => string[];
  // Fetch the full file tree for a commit.
  fetchTree: (id: string) => Promise<string[]>;
  // Fetch per-line blame / commit history for a file at a commit.
  fetchBlame: (id: string, path: string) => Promise<BlameLine[]>;
  fetchFileHistory: (id: string, path: string) => Promise<FileCommit[]>;
  // Re-diff one of the commit's files with `contextLines` of context, and
  // optionally ignoring whitespace (the commit detail's own diffs use the
  // default context and show every change).
  fetchFileDiff: (id: string, file: FileDiff, contextLines: number, ignoreWhitespace: boolean) => Promise<FileDiff | null>;
  // The same for one of a comparison's files.
  fetchCompareFileDiff: (
    cmp: Comparison,
    file: FileDiff,
    contextLines: number,
    ignoreWhitespace: boolean,
  ) => Promise<FileDiff | null>;
  // The compare header: re-run the comparison with these ends and mode (Swap,
  // the two-dot / three-dot toggle), or close it.
  onCompare: (base: string, head: string, threeDot: boolean) => void;
  onCloseCompare: () => void;
  // Verify the commit's signature (null when unsigned). Can be slow — it runs
  // gpg / ssh-keygen — so the Commit tab fills its badge in when this lands.
  fetchSignature: (id: string) => Promise<CommitSignature | null>;
  // Which tab to open with. The pane keeps whichever tab you last used as you
  // move between commits; this is the starting point, restored across restarts
  // by the host. Defaults to Changes — clicking a commit to see what changed in
  // it and landing on its metadata instead cost a second click every time.
  initialTab?: DetailTab;
  // Called when the user switches tabs, so the host can persist it.
  onTabChange?: (tab: DetailTab) => void;
}

export interface DetailHandle {
  show: (detail: CommitDetail) => void;
  showEmpty: () => void;
  // Re-render the current commit (e.g. after refs load) — no-op when empty.
  refresh: () => void;
  // Switch to the Commit tab — used when jumping to a commit via a link.
  focusCommit: () => void;
  // Open one of the selected commit's changed files in the given mode, from
  // outside the pane (Quick Launch's Blame/File History). Returns false when
  // the path isn't among them, so the caller can say so.
  openFile: (path: string, mode: "diff" | "blame" | "history") => boolean;
  // Show what differs between two revisions, in place of a commit.
  showCompare: (cmp: Comparison) => void;
  // The comparison on screen, or null while showing a commit (or nothing).
  comparison: () => Comparison | null;
}

// A single-entry cache keyed by `${commitId}:${path}`.
interface Cached<T> {
  key: string;
  data: T;
}

export function setupDetail(host: HTMLElement, cb: DetailCallbacks): DetailHandle {
  let detail: CommitDetail | null = null;
  // Set while showing a comparison. `detail` then stands in for its head
  // commit, carrying the comparison's files, so everything below that reads
  // `detail.files` — or blames as of `detail.id` — needs no second code path.
  let compare: Comparison | null = null;
  let tab: Tab = cb.initialTab ?? "changes";
  let selectedFile = 0;
  let fileMode: FileMode = "diff";
  let splitView = false;
  let contextLines = DEFAULT_CONTEXT_LINES;
  let currentHunk = 0;
  let tree: { id: string; paths: string[] } | null = null;
  let blame: Cached<BlameLine[]> | null = null;
  let history: Cached<FileCommit[]> | null = null;
  // The selected file re-diffed at a non-default context or ignoring
  // whitespace; key adds both.
  let recontexted: Cached<FileDiff | null> | null = null;
  // The re-diff currently being fetched, so repeated render()s while it's in
  // flight don't each start another request.
  let recontextInFlight: string | null = null;
  const collapsed = new Set<string>(); // collapsed folders in the File Tree
  // The last commit whose signature was verified, and the one being verified.
  let signature: { id: string; sig: CommitSignature | null } | null = null;
  let signatureInFlight: string | null = null;
  // The ref chips the Commit tab was last drawn with — the only thing on any
  // tab that a refs refresh can change.
  let shownRefs: string | null = null;

  function show(next: CommitDetail): void {
    const isNewCommit = compare !== null || detail?.id !== next.id;
    compare = null;
    detail = next;
    if (isNewCommit) {
      selectedFile = 0;
      currentHunk = 0;
      tree = null;
      collapsed.clear();
    }
    render();
  }

  function showCompare(cmp: Comparison): void {
    const before = compare ? viewKey() : null;
    compare = cmp;
    detail = {
      id: cmp.head.id,
      summary: cmp.head.summary,
      message: cmp.head.summary,
      author_name: "",
      author_email: "",
      author_time: 0,
      parents: [],
      files: cmp.files,
    };
    // A refresh of the same comparison keeps your place; anything else starts
    // at the first file.
    if (viewKey() !== before) {
      selectedFile = 0;
      currentHunk = 0;
    }
    render();
  }

  // What's on screen, for keying the caches: a commit, or both ends and the
  // mode of a comparison.
  function viewKey(): string {
    if (compare) return `${compare.base.id}${compare.three_dot ? "..." : ".."}${compare.head.id}`;
    return detail!.id;
  }

  function showEmpty(): void {
    detail = null;
    compare = null;
    clear(host);
    host.append(el("div", { class: "detail-empty", text: "Select a commit to view its changes." }));
  }

  function setTab(next: Tab): void {
    tab = next;
    cb.onTabChange?.(next);
    render();
  }

  // Show a specific file in the Changes tab (from Commit list / File Tree /
  // Quick Launch). `false` means this commit doesn't touch that path.
  function openFile(path: string, mode: FileMode): boolean {
    if (!detail) return false;
    const idx = detail.files.findIndex((f) => f.path === path);
    if (idx < 0) return false;
    selectedFile = idx;
    currentHunk = 0;
    fileMode = mode;
    tab = "changes";
    render();
    return true;
  }

  function openFileDiff(path: string): void {
    openFile(path, "diff");
  }

  function render(): void {
    if (!detail) return showEmpty();
    clear(host);
    host.append(compare ? compareHeader(compare) : tabBar());
    const pane = el("div", { class: "detail-body-pane" });
    host.append(pane);
    if (compare) {
      renderChanges(pane);
    } else if (tab === "commit") {
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

  // --- Commit tab -----------------------------------------------------------

  function renderCommit(scroll: HTMLElement): void {
    const d = detail!;
    scroll.append(el("h2", { class: "detail-summary", text: d.summary }));

    const refs = cb.refsAt(d.id);
    shownRefs = refs.join("\n");
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
    const sigRow = el("div", { class: "detail-signature" });
    meta.append(sigRow);
    fillSignature(sigRow, d.id);
    scroll.append(meta);

    if (d.files.length === 0) {
      scroll.append(el("div", { class: "detail-empty", text: "No file changes." }));
      return;
    }
    const list = el("div", { class: "file-list" });
    d.files.forEach((f, idx) =>
      list.append(fileRow(f, false, () => {
        selectedFile = idx;
        currentHunk = 0;
        fileMode = "diff";
        setTab("changes");
      })),
    );
    scroll.append(list);
  }

  // --- Changes tab ----------------------------------------------------------

  function renderChanges(pane: HTMLElement): void {
    const d = detail!;
    if (d.files.length === 0) {
      const scroll = el("div", { class: "tab-scroll" });
      scroll.append(el("div", { class: "detail-empty", text: compare ? "No differences." : "No file changes." }));
      pane.append(scroll);
      return;
    }
    selectedFile = Math.min(selectedFile, d.files.length - 1);

    const split = el("div", { class: "changes-split" });
    const listCol = el("div", { class: "changes-list" });
    d.files.forEach((f, idx) =>
      listCol.append(fileRow(f, idx === selectedFile, () => {
        selectedFile = idx;
        currentHunk = 0;
        render();
      })),
    );

    const right = el("div", { class: "changes-right" });
    right.append(fileToolbar());
    const view = el("div", { class: "file-view" });
    renderFileView(view);
    right.append(view);

    split.append(listCol, right);
    pane.append(split);
  }

  function fileToolbar(): HTMLElement {
    const diffMode = fileMode === "diff";
    const bar = el("div", { class: "file-toolbar" });

    bar.append(
      textBtn("Blame", fileMode === "blame", () => setFileMode("blame")),
      textBtn("History", fileMode === "history", () => setFileMode("history")),
      sep(),
      iconBtn(["M12 19V5", "M6 11l6-6 6 6"], "Previous change", !diffMode, () => gotoChange(-1)),
      iconBtn(["M12 5v14", "M6 13l6 6 6-6"], "Next change", !diffMode, () => gotoChange(1)),
      sep(),
      ...contextControls(contextLines, !diffMode, setContext),
      sep(),
      ...diffToggles(splitView, !diffMode, (what) => {
        if (what === "ws") currentHunk = 0;
        render();
      }),
    );

    const toggle = el("div", { class: "tb-group" }, [
      iconBtn(["M4 6h16", "M4 12h16", "M4 18h16"], "Unified", !diffMode, () => setSplit(false), !splitView && diffMode),
      iconBtn(["M4 5h16v14H4z", "M12 5v14"], "Split", !diffMode, () => setSplit(true), splitView && diffMode),
    ]);
    bar.append(toggle);
    return bar;
  }

  function renderFileView(view: HTMLElement): void {
    const file = detail!.files[selectedFile];
    if (fileMode === "blame") return renderBlameView(view, file);
    if (fileMode === "history") return renderHistoryView(view, file);
    const shown = displayedDiff(selectedFile);
    if (shown === undefined) return renderRecontexted(view, file);
    view.classList.toggle("wrap-lines", loadDiffWrap());
    view.append(splitView ? renderSplitDiff(shown) : renderUnifiedDiff(shown));
    if (shown.hunks.length === 0 && file.hunks.length > 0) {
      view.append(el("div", { class: "detail-empty", text: "Only whitespace changed — Ignore whitespace is on." }));
    }
  }

  // The file as it should be drawn at the current context and whitespace
  // setting: the commit's own diff at the default, the cached re-diff
  // otherwise, or `undefined` while that re-diff hasn't been fetched yet.
  function displayedDiff(idx: number): FileDiff | undefined {
    const file = detail!.files[idx];
    if (contextLines === DEFAULT_CONTEXT_LINES && !loadIgnoreWhitespace()) return file;
    if (recontexted?.key !== contextKey(file)) return undefined;
    return recontexted.data ?? file;
  }

  function contextKey(file: FileDiff): string {
    return `${viewKey()}:${file.path}:${contextLines}:${loadIgnoreWhitespace() ? "-w" : ""}`;
  }

  function renderRecontexted(view: HTMLElement, file: FileDiff): void {
    view.append(el("div", { class: "detail-empty", text: "Loading…" }));
    const key = contextKey(file);
    if (recontextInFlight === key) return;
    recontextInFlight = key;
    // Only repaint if the user is still looking at this file and context.
    const stillViewing = () => detail !== null && contextKey(detail.files[selectedFile]) === key;
    const ws = loadIgnoreWhitespace();
    const fetched = compare
      ? cb.fetchCompareFileDiff(compare, file, contextLines, ws)
      : cb.fetchFileDiff(detail!.id, file, contextLines, ws);
    fetched
      .then((data) => {
        recontexted = { key, data };
        if (stillViewing()) render();
      })
      .catch((err) => {
        if (!stillViewing()) return;
        clear(view);
        view.append(el("div", { class: "detail-empty", text: `Diff failed: ${String(err)}` }));
      })
      .finally(() => {
        if (recontextInFlight === key) recontextInFlight = null;
      });
  }

  function setContext(next: number): void {
    contextLines = next;
    currentHunk = 0;
    render();
  }

  function setFileMode(mode: FileMode): void {
    // Clicking the active Blame/History button returns to the diff.
    fileMode = fileMode === mode ? "diff" : mode;
    render();
  }

  function setSplit(on: boolean): void {
    splitView = on;
    render();
  }

  // Step to the previous/next hunk, spilling into the adjacent changed file.
  function gotoChange(dir: -1 | 1): void {
    const d = detail!;
    let fileIdx = selectedFile;
    let hunk = currentHunk + dir;
    // Hunks as drawn — more context merges nearby ones, so count those.
    const hunkCount = (idx: number) => (displayedDiff(idx) ?? d.files[idx]).hunks.length;
    const count = hunkCount(fileIdx);

    if (hunk < 0) {
      if (fileIdx === 0) return; // already at the first change
      fileIdx -= 1;
      hunk = Math.max(0, hunkCount(fileIdx) - 1);
    } else if (hunk >= count) {
      if (fileIdx === d.files.length - 1) return; // already at the last change
      fileIdx += 1;
      hunk = 0;
    }
    selectedFile = fileIdx;
    currentHunk = hunk;
    render();
    requestAnimationFrame(() => {
      const node = host.querySelector(`.file-view [data-hunk="${currentHunk}"]`);
      if (node) {
        node.scrollIntoView({ block: "center" });
        node.classList.add("hunk-current");
      }
    });
  }

  // --- Blame / History views ------------------------------------------------

  function renderBlameView(view: HTMLElement, file: FileDiff): void {
    const d = detail!;
    const key = `${d.id}:${file.path}`;
    if (blame?.key === key) {
      view.append(buildBlame(blame.data));
      return;
    }
    view.append(el("div", { class: "detail-empty", text: "Loading blame…" }));
    cb.fetchBlame(d.id, file.path)
      .then((lines) => {
        blame = { key, data: lines };
        if (stillViewing(d.id, file.path, "blame")) render();
      })
      .catch((err) => {
        if (stillViewing(d.id, file.path, "blame")) {
          clear(view);
          view.append(el("div", { class: "detail-empty", text: `Blame failed: ${String(err)}` }));
        }
      });
  }

  function buildBlame(lines: BlameLine[]): HTMLElement {
    const wrap = el("div", { class: "blame" });
    for (const l of lines) {
      const clickable = l.commit !== "";
      const row = el("div", { class: `blame-row${clickable ? " link" : ""}` }, [
        el("span", { class: "blame-commit", text: l.commit.slice(0, 7) }),
        el("span", { class: "blame-author", text: l.author }),
        el("span", { class: "blame-ln", text: String(l.line_no) }),
        el("span", { class: "blame-code", text: l.content }),
      ]);
      if (clickable) {
        row.title = `Open commit ${l.commit.slice(0, 10)} — ${l.author}`;
        row.addEventListener("click", () => cb.onSelectCommit(l.commit));
      }
      wrap.append(row);
    }
    return wrap;
  }

  function renderHistoryView(view: HTMLElement, file: FileDiff): void {
    const d = detail!;
    const key = `${d.id}:${file.path}`;
    if (history?.key === key) {
      view.append(buildHistory(history.data));
      return;
    }
    view.append(el("div", { class: "detail-empty", text: "Loading history…" }));
    cb.fetchFileHistory(d.id, file.path)
      .then((commits) => {
        history = { key, data: commits };
        if (stillViewing(d.id, file.path, "history")) render();
      })
      .catch((err) => {
        if (stillViewing(d.id, file.path, "history")) {
          clear(view);
          view.append(el("div", { class: "detail-empty", text: `History failed: ${String(err)}` }));
        }
      });
  }

  function buildHistory(commits: FileCommit[]): HTMLElement {
    if (commits.length === 0) {
      return el("div", { class: "detail-empty", text: "No history for this file." });
    }
    const wrap = el("div", { class: "file-history" });
    for (const c of commits) {
      const when = new Date(c.time * 1000).toLocaleDateString();
      const row = el("div", { class: "hist-row", title: c.id }, [
        el("span", { class: "hist-sha", text: c.short_id }),
        el("span", { class: "hist-summary", text: c.summary }),
        el("span", { class: "hist-meta", text: `${c.author_name} · ${when}` }),
      ]);
      row.addEventListener("click", () => cb.onSelectCommit(c.id));
      wrap.append(row);
    }
    return wrap;
  }

  // Guard: a fetch resolved — are we still showing the same file in the same mode?
  function stillViewing(id: string, path: string, mode: FileMode): boolean {
    return (
      detail?.id === id &&
      (compare !== null || tab === "changes") &&
      fileMode === mode &&
      detail.files[selectedFile]?.path === path
    );
  }

  // --- Compare header -------------------------------------------------------

  // `base ← head`, how far apart they are, and the controls: two-dot /
  // three-dot, Swap, Close.
  function compareHeader(cmp: Comparison): HTMLElement {
    const { base, head, three_dot: threeDot } = cmp;
    const bar = el("div", { class: "compare-header" });
    bar.append(
      el("span", { class: "compare-title", text: "Compare" }),
      compareChip(base),
      el("span", { class: "compare-arrow", text: "←", title: `${compareEndLabel(head)} into ${compareEndLabel(base)}` }),
      compareChip(head),
    );
    const apart = `${cmp.ahead} ahead · ${cmp.behind} behind`;
    const since = cmp.merge_base ? `merge base ${cmp.merge_base.slice(0, 7)}` : "no common ancestor";
    bar.append(
      el("span", {
        class: "compare-counts",
        text: `${apart} · ${since}`,
        title:
          `${compareEndLabel(head)} has ${cmp.ahead} commit${cmp.ahead === 1 ? "" : "s"} that ` +
          `${compareEndLabel(base)} doesn't, and is missing ${cmp.behind}.`,
      }),
      el("span", { class: "compare-spacer" }),
    );
    const mode = (label: string, three: boolean, title: string) => {
      const b = textBtn(label, threeDot === three, () => {
        if (threeDot !== three) cb.onCompare(base.rev, head.rev, three);
      });
      b.title = title;
      return b;
    };
    bar.append(
      el("div", { class: "tb-group" }, [
        mode("Two-dot", false, `Everything that differs between ${compareEndLabel(base)} and ${compareEndLabel(head)}`),
        mode(
          "Three-dot",
          true,
          `Only what ${compareEndLabel(head)} changed since it diverged from ${compareEndLabel(base)} (diff from the merge base)`,
        ),
      ]),
      textBtn("Swap", false, () => cb.onCompare(head.rev, base.rev, threeDot)),
      iconBtn(["M6 6l12 12", "M18 6L6 18"], "Close comparison (Esc)", false, cb.onCloseCompare),
    );
    return bar;
  }

  function compareChip(end: CompareEnd): HTMLElement {
    return el("span", { class: "ref-chip compare-end", text: compareEndLabel(end), title: `${end.short_id} — ${end.summary}` });
  }

  // --- File Tree tab --------------------------------------------------------

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

  // The signature badge, verified lazily for the commit on screen: a request
  // of its own, so the tab never waits on gpg / ssh-keygen. Filled into the
  // current `.detail-signature` row when it lands — render() may have rebuilt
  // the tab meanwhile. Unsigned commits (and failed checks) show nothing.
  function fillSignature(row: HTMLElement, id: string): void {
    if (signature?.id === id) {
      if (signature.sig) row.append(signatureBadge(signature.sig));
      return;
    }
    if (signatureInFlight === id) return;
    signatureInFlight = id;
    cb.fetchSignature(id)
      .then((sig) => {
        signature = { id, sig };
      })
      .catch(() => {})
      .finally(() => {
        if (signatureInFlight === id) signatureInFlight = null;
        const slot = host.querySelector<HTMLElement>(".detail-signature");
        if (!slot || detail?.id !== id || signature?.id !== id || !signature.sig) return;
        clear(slot);
        slot.append(signatureBadge(signature.sig));
      });
  }

  function signatureBadge(sig: CommitSignature): HTMLElement {
    const { label, who, title } = signatureText(sig);
    return el("span", { class: "sig-row", title }, [
      el("span", { class: `sig-badge sig-${sig.status.toLowerCase()}`, text: label }),
      who,
    ]);
  }

  // --- small builders -------------------------------------------------------

  function fileRow(file: FileDiff, active: boolean, onClick: () => void): HTMLElement {
    const row = el("div", { class: `file-item${active ? " active" : ""}`, title: file.path });
    row.append(statusBadge(file.status));
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
    // Runs on every refs reload, which any click can trigger (see
    // external-refresh.ts). A rebuild resets the pane's scroll and drops a text
    // selection, so only repaint when the Commit tab's ref chips changed.
    refresh: () => {
      if (!detail || compare || tab !== "commit") return;
      if (cb.refsAt(detail.id).join("\n") === shownRefs) return;
      const scroller = host.querySelector<HTMLElement>(".tab-scroll");
      const keep = scroller?.scrollTop ?? 0;
      render();
      const next = host.querySelector<HTMLElement>(".tab-scroll");
      if (next) next.scrollTop = keep;
    },
    focusCommit: () => {
      if (detail) setTab("commit");
    },
    openFile,
    showCompare,
    comparison: () => compare,
  };
}

// How a comparison names one of its ends: the ref name it was given, or the
// short id when it was given a commit id.
export function compareEndLabel(end: CompareEnd): string {
  return end.id.startsWith(end.rev.toLowerCase()) ? end.short_id : end.rev;
}

// --- toolbar controls -------------------------------------------------------

function textBtn(label: string, active: boolean, onClick: () => void): HTMLElement {
  const b = el("button", { class: `tb-btn${active ? " active" : ""}`, text: label });
  b.addEventListener("click", onClick);
  return b;
}

function iconBtn(
  paths: string[],
  title: string,
  disabled: boolean,
  onClick: () => void,
  active = false,
): HTMLElement {
  const b = el("button", { class: `tb-btn icon${active ? " active" : ""}`, title });
  b.append(icon(paths));
  if (disabled) (b as HTMLButtonElement).disabled = true;
  else b.addEventListener("click", onClick);
  return b;
}

function icon(paths: string[]): SVGElement {
  const s = svg("svg", { viewBox: "0 0 24 24", class: "tb-icon" });
  for (const d of paths) s.append(svg("path", { d }));
  return s;
}

function sep(): HTMLElement {
  return el("span", { class: "tb-sep" });
}

// How many lines "fewer" / "more" moves the context by — git's default size.
const CONTEXT_STEP = 3;
const LINES_ICON = ["M11 6h10", "M11 12h10", "M11 18h10"];

// Show fewer / more unchanged lines around each change, or the full file.
// Shared with the Local Changes diff. `ctx` is the current context size;
// leaving full-file mode (either button) returns to the default.
export function contextControls(ctx: number, disabled: boolean, onChange: (next: number) => void): HTMLElement[] {
  const full = ctx >= FULL_FILE_CONTEXT;
  const now = full ? "full file" : `${ctx} line${ctx === 1 ? "" : "s"}`;
  return [
    iconBtn([...LINES_ICON, "M3 12h5"], `Show fewer lines around changes (now ${now})`, disabled || ctx === 0, () =>
      onChange(full ? DEFAULT_CONTEXT_LINES : Math.max(0, ctx - CONTEXT_STEP)),
    ),
    iconBtn([...LINES_ICON, "M3 12h5", "M5.5 9.5v5"], `Show more lines around changes (now ${now})`, disabled || full, () =>
      onChange(ctx + CONTEXT_STEP),
    ),
    iconBtn(
      [...LINES_ICON, "M6 3v18", "M3 6l3-3 3 3", "M3 18l3 3 3-3"],
      full ? "Show changes only" : "Show full file",
      disabled,
      () => onChange(full ? DEFAULT_CONTEXT_LINES : FULL_FILE_CONTEXT),
      full && !disabled,
    ),
  ];
}

const WRAP_ICON = ["M4 6h16", "M4 12h13a3 3 0 0 1 0 6h-3", "M16 16l-2 2 2 2", "M4 18h6"];
const IGNORE_WS_ICON = ["M4 10v4h16v-4", "M4 5l16 14"];

// Wrap long lines and Ignore whitespace — persisted preferences (prefs.ts),
// shared with the Local Changes diff. Wrapping is CSS only (`.wrap-lines` on
// the diff's container); ignoring whitespace needs a re-diff, so `onChange`
// says which one flipped. The split view always wraps, so Wrap is off there.
export function diffToggles(
  split: boolean,
  disabled: boolean,
  onChange: (what: "wrap" | "ws") => void,
): HTMLElement[] {
  const wrap = loadDiffWrap();
  const ws = loadIgnoreWhitespace();
  return [
    iconBtn(
      WRAP_ICON,
      split ? "Wrap long lines (the split view always wraps)" : "Wrap long lines",
      disabled || split,
      () => {
        saveDiffWrap(!wrap);
        onChange("wrap");
      },
      wrap && !split && !disabled,
    ),
    iconBtn(
      IGNORE_WS_ICON,
      "Ignore whitespace changes (git diff -w)",
      disabled,
      () => {
        saveIgnoreWhitespace(!ws);
        onChange("ws");
      },
      ws && !disabled,
    ),
  ];
}

// --- diff renderers ---------------------------------------------------------

function fileHead(file: FileDiff): HTMLElement {
  const head = el("div", { class: "file-head" });
  head.append(statusBadge(file.status, true));
  const label =
    file.old_path && file.old_path !== file.path ? `${file.old_path} → ${file.path}` : file.path;
  head.append(el("span", { text: label }));
  return head;
}

// Unified diff: inline +/- lines, with intra-line (word) highlights on paired
// deletion/addition lines. Shared with the Local Changes view.
// A hunk's `@@` header plus a Copy button that puts the block's new-side text
// (context + additions, no markers or line numbers) on the clipboard — a clean
// copy that manual selection can't give in a split view.
function hunkHeader(hunk: FileDiff["hunks"][number]): HTMLElement {
  const header = el("div", { class: "hunk-header" }, [
    el("span", { class: "hunk-header-text", text: hunk.header }),
  ]);
  const copy = el("button", { class: "hunk-copy", text: "Copy", title: "Copy this block" });
  copy.addEventListener("click", (e) => {
    e.stopPropagation();
    const text = hunk.lines.filter((l) => l.origin !== "-").map((l) => l.content).join("\n");
    void copyToClipboard(text);
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy"), 1200);
  });
  header.append(copy);
  return header;
}

export function renderFile(file: FileDiff): HTMLElement {
  const container = el("div", { class: "file" }, [fileHead(file)]);
  file.hunks.forEach((hunk, i) => {
    const h = el("div", { class: "hunk", "data-hunk": i });
    h.append(hunkHeader(hunk));
    const at = lineIndexes(hunk);
    const words = hunkWordDiffs(hunk.lines);

    let dels: Line[] = [];
    let adds: Line[] = [];
    const flush = () => {
      dels.forEach((d) => h.append(unifiedLine(d, at.get(d)!, "del", words.get(at.get(d)!) ?? null)));
      adds.forEach((a) => h.append(unifiedLine(a, at.get(a)!, "add", words.get(at.get(a)!) ?? null)));
      dels = [];
      adds = [];
    };
    for (const line of hunk.lines) {
      if (line.origin === "-") dels.push(line);
      else if (line.origin === "+") adds.push(line);
      else {
        flush();
        h.append(unifiedLine(line, at.get(line)!, "ctx", null));
      }
    }
    flush();

    container.append(h);
  });
  return container;
}

// Each line's index within its hunk, tagged on the rendered line as
// `data-line` — with the `.hunk`'s `data-hunk`, it names the line the way the
// backend does (Local Changes' line selection).
function lineIndexes(hunk: FileDiff["hunks"][number]): Map<Line, number> {
  return new Map(hunk.lines.map((l, k) => [l, k]));
}

function unifiedLine(line: Line, index: number, kind: "del" | "add" | "ctx", segs: Seg[] | null): HTMLElement {
  const cls = kind === "add" ? "diff-line add" : kind === "del" ? "diff-line del" : "diff-line";
  // The old/new line numbers and the +/-/space marker are drawn by CSS
  // (`::before { content: attr(...) }`) rather than being text nodes:
  // `user-select: none` still lets them ride along into the selection
  // highlight and the clipboard, generated content cannot.
  const div = el("div", { class: cls, "data-line": index }, [
    el("span", { class: "diff-ln", "data-ln": lineno(line.old_lineno) }),
    el("span", { class: "diff-ln", "data-ln": lineno(line.new_lineno) }),
    el("span", { class: "diff-origin", "data-origin": line.origin }),
  ]);
  if (segs) appendSegs(div, segs, kind === "del" ? "word-del" : "word-add");
  else div.append(document.createTextNode(line.content));
  return div;
}

// A line number for the gutter; blank on the side where the line doesn't exist
// (no old number on an addition, no new number on a deletion).
function lineno(no: number | null | undefined): string {
  return no != null ? String(no) : "";
}

const renderUnifiedDiff = renderFile;

// Split diff: old on the left, new on the right, changed runs aligned.
export function renderSplitDiff(file: FileDiff): HTMLElement {
  const container = el("div", { class: "file" }, [fileHead(file)]);
  file.hunks.forEach((hunk, i) => {
    const h = el("div", { class: "hunk", "data-hunk": i });
    h.append(hunkHeader(hunk));
    const table = el("div", { class: "split-table" });
    const at = lineIndexes(hunk);
    const words = hunkWordDiffs(hunk.lines);

    let dels: FileDiff["hunks"][number]["lines"] = [];
    let adds: FileDiff["hunks"][number]["lines"] = [];
    const flush = () => {
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) table.append(splitRow(dels[k] ?? null, adds[k] ?? null, at, words));
      dels = [];
      adds = [];
    };
    for (const line of hunk.lines) {
      if (line.origin === "-") dels.push(line);
      else if (line.origin === "+") adds.push(line);
      else {
        flush();
        table.append(splitRow(line, line, at, words));
      }
    }
    flush();

    isolateSplitColumnDrag(table);
    h.append(table);
    container.append(h);
  });
  return container;
}

// The old/new columns are DOM siblings within each `.split-row` (a plain
// flex row), so a native drag-select spanning multiple rows passes through
// both columns' text in DOM order — the browser has no idea they're meant to
// be two independent panels. Selecting a paragraph on the left would silently
// pull the corresponding lines from the right into both the visible
// highlight and the clipboard.
//
// Fix at the source: while a drag is in progress, make the *other* column
// unselectable, so the browser's native selection can't extend into it at
// all — the highlight and the copy are correct as a direct consequence,
// without needing a `copy` handler to clean up after the fact.
function isolateSplitColumnDrag(table: HTMLElement): void {
  table.addEventListener("mousedown", (e) => {
    const cell = (e.target as HTMLElement).closest(".split-cell");
    if (!cell) return;
    const side = cell.parentElement?.firstElementChild === cell ? "left" : "right";
    table.classList.add(`dragging-${side}`);
    window.addEventListener(
      "mouseup",
      () => table.classList.remove("dragging-left", "dragging-right"),
      { once: true },
    );
  });
}

type Line = FileDiff["hunks"][number]["lines"][number];

function splitRow(
  left: Line | null,
  right: Line | null,
  at: Map<Line, number>,
  words: Map<number, Seg[]>,
): HTMLElement {
  // Only paired deletion/addition lines have word highlights in `words`.
  const segs = (line: Line | null) => (line ? (words.get(at.get(line)!) ?? null) : null);
  return el("div", { class: "split-row" }, [
    sideCell(left, "left", segs(left), at),
    sideCell(right, "right", segs(right), at),
  ]);
}

function sideCell(
  line: Line | null,
  side: "left" | "right",
  segs: Seg[] | null,
  at: Map<Line, number>,
): HTMLElement {
  if (!line) return el("div", { class: "split-cell empty" });
  const changed = side === "left" ? line.origin === "-" : line.origin === "+";
  const no = side === "left" ? line.old_lineno : line.new_lineno;
  const code = el("span", { class: "split-code" });
  if (segs) appendSegs(code, segs, side === "left" ? "word-del" : "word-add");
  else code.append(document.createTextNode(line.content));
  const cls = `split-cell${changed ? (side === "left" ? " del" : " add") : ""}`;
  return el("div", { class: cls, "data-line": at.get(line)! }, [
    // Line number as CSS generated content — see the note in `unifiedLine`.
    el("span", { class: "split-ln", "data-ln": no != null ? String(no) : "" }),
    code,
  ]);
}

// Append text segments, wrapping changed ones in a highlight span.
function appendSegs(host: HTMLElement, segs: Seg[], changedClass: string): void {
  for (const s of segs) {
    if (s.changed) host.append(el("span", { class: changedClass, text: s.text }));
    else host.append(document.createTextNode(s.text));
  }
}

const SIGNATURE_LABELS: Record<SignatureStatus, string> = {
  Good: "Verified",
  Bad: "Bad signature",
  UnknownKey: "Unknown key",
  Expired: "Expired signature",
  Revoked: "Revoked key",
  Unverifiable: "Signed (can't verify)",
};

// What the signature badge says: the verdict, who signed with which key, and
// a tooltip — git's reason when it couldn't verify at all.
export function signatureText(sig: CommitSignature): { label: string; who: string; title: string } {
  const who = [sig.signer, sig.key].filter(Boolean).join(" · ");
  const title = sig.status === "Unverifiable" && sig.detail ? sig.detail : who;
  return { label: SIGNATURE_LABELS[sig.status], who, title };
}
