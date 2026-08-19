// Local Changes: the staging area. Unstaged and Staged panels (collapsible file
// trees), the selected file's diff, and a commit box (subject + description +
// Amend + Commit). A stateful controller owns the selection, per-panel collapse
// state, and the commit fields, reloading from the backend after each mutation.

import { autoGrowTextarea, clear, el } from "../dom";
import type { CommitDetail, FileDiff, StatusLists } from "../types";
import { showContextMenu } from "./context-menu";
import { renderFile, renderSplitDiff } from "./detail";
import { renderFileTree } from "./tree";

type Panel = "unstaged" | "staged";

export interface ChangesCallbacks {
  // Staging trees: paths + statuses only, no hunks (cheap to refresh).
  fetchStatus: () => Promise<StatusLists>;
  // The selected file's full diff (with hunks), fetched on demand.
  fetchFileDiff: (path: string, staged: boolean) => Promise<FileDiff | null>;
  stage: (path: string) => Promise<void>;
  unstage: (path: string) => Promise<void>;
  stageAll: () => Promise<void>;
  unstageAll: () => Promise<void>;
  // Per-hunk (per-block) operations, driven by the diff's right-click menu.
  stageHunk: (path: string, hunkIndex: number) => Promise<void>;
  unstageHunk: (path: string, hunkIndex: number) => Promise<void>;
  discardHunk: (path: string, hunkIndex: number) => Promise<void>;
  // Confirm a destructive action (discard); resolves true to proceed.
  confirm: (message: string) => Promise<boolean>;
  // The current HEAD commit (message + files), for pre-filling an amend and
  // showing the commit being amended. Null when the branch has no commits.
  fetchHead: () => Promise<CommitDetail | null>;
  commit: (subject: string, body: string, amend: boolean) => Promise<string>;
  // After every reload: the number of distinct changed paths, for the sidebar
  // badge — cheap enough to pass along instead of a separate backend scan.
  onChanged: (localChangeCount: number) => void;
  // After a successful commit (refresh history + sidebar).
  onCommitted: () => void;
  setStatus: (msg: string) => void;
}

export interface ChangesHandle {
  reload: () => Promise<void>;
}

export function setupChanges(host: HTMLElement, cb: ChangesCallbacks): ChangesHandle {
  // staged/unstaged hold summaries (no hunks); selectedDiff holds the fetched
  // hunks for the currently selected file only.
  let staged: FileDiff[] = [];
  let unstaged: FileDiff[] = [];
  let selected: { panel: Panel; path: string } | null = null;
  let selectedDiff: FileDiff | null = null;
  // Whether the current selection's diff fetch has completed — distinguishes
  // "still loading" from "loaded but no textual diff" (binary / Git LFS file).
  let diffLoaded = false;
  // Bumped on every diff fetch so a slow response for a since-changed selection
  // is discarded instead of overwriting the current one.
  let diffToken = 0;
  const collapsed: Record<Panel, Set<string>> = { unstaged: new Set(), staged: new Set() };
  let subject = "";
  let body = "";
  let amend = false;
  // When amend is on: the files from HEAD (with hunks), shown in the Staged
  // panel so the commit being amended is visible. Empty when amend is off.
  let amendFiles: FileDiff[] = [];
  // The message we auto-filled from HEAD, so unchecking Amend can clear it only
  // when the user hasn't edited it.
  let amendPrefill: { subject: string; body: string } | null = null;
  let busy = false;
  let splitView = false;
  let diffHost: HTMLElement | null = null;

  async function reload(): Promise<void> {
    const s = await cb.fetchStatus();
    staged = s.staged;
    unstaged = s.unstaged;
    resolveSelection();
    render();
    // Distinct changed paths (a file can be both staged and unstaged).
    const paths = new Set([...staged, ...unstaged].map((f) => f.path));
    cb.onChanged(paths.size);
    await loadSelectedDiff();
  }

  // Fetch (and render) the hunks for the current selection. No-op to an empty
  // diff pane when nothing is selected.
  async function loadSelectedDiff(): Promise<void> {
    const sel = selected;
    const token = ++diffToken;
    selectedDiff = null;
    diffLoaded = false;
    if (!sel) {
      if (diffHost) renderDiffInto(diffHost);
      return;
    }
    // Amend-only files aren't in the index; their diff is HEAD's cached hunks.
    if (sel.panel === "staged") {
      const cached = amendOnly(sel.path);
      if (cached) {
        selectedDiff = cached;
        diffLoaded = true;
        if (diffHost) renderDiffInto(diffHost);
        return;
      }
    }
    const file = await cb.fetchFileDiff(sel.path, sel.panel === "staged");
    if (token !== diffToken) return; // selection moved on; drop this result
    selectedDiff = file;
    diffLoaded = true;
    if (diffHost) renderDiffInto(diffHost);
  }

  // Keep the selection valid after files move between panels or disappear.
  function resolveSelection(): void {
    if (!selected) return;
    if (unstaged.some((f) => f.path === selected!.path)) selected = { panel: "unstaged", path: selected.path };
    else if (staged.some((f) => f.path === selected!.path)) selected = { panel: "staged", path: selected.path };
    else if (amendOnly(selected.path)) selected = { panel: "staged", path: selected.path };
    else selected = null;
  }

  async function run(action: () => Promise<void>, after?: () => void): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await action();
      after?.();
      await reload();
    } catch (err) {
      cb.setStatus(String(err));
    } finally {
      busy = false;
    }
  }

  function render(): void {
    clear(host);
    const wrap = el("div", { class: "staging" });
    const left = el("div", { class: "staging-left" });
    left.append(
      panel("unstaged", "Unstaged", unstaged),
      panel("staged", amend ? "Staged — amending last commit" : "Staged", stagedDisplay()),
      commitBox(),
    );
    diffHost = el("div", { class: "staging-diff" });
    renderDiffInto(diffHost);
    wrap.append(left, diffHost);
    host.append(wrap);
  }

  // Selecting a file updates only the highlight + diff — it must NOT rebuild the
  // trees, so file rows survive for a native double-click (instant staging).
  function selectFile(panel: Panel, path: string): void {
    selected = { panel, path };
    selectedDiff = null;
    diffLoaded = false;
    for (const r of host.querySelectorAll<HTMLElement>(".tree-file.selected")) {
      r.classList.remove("selected");
    }
    const trees = host.querySelectorAll<HTMLElement>(".stage-tree");
    const container = panel === "unstaged" ? trees[0] : trees[1];
    for (const r of container?.querySelectorAll<HTMLElement>(".tree-file") ?? []) {
      if (r.getAttribute("title") === path) {
        r.classList.add("selected");
        break;
      }
    }
    if (diffHost) renderDiffInto(diffHost);
    void loadSelectedDiff();
  }

  function renderDiffInto(pane: HTMLElement): void {
    clear(pane);
    if (!selected) {
      pane.append(el("div", { class: "detail-empty", text: "Select a file to view its changes." }));
      return;
    }
    const hasDiff = selectedDiff != null && selectedDiff.hunks.length > 0;
    if (hasDiff) pane.append(diffToolbar());
    const body = el("div", { class: "staging-diff-body" });
    if (hasDiff) {
      body.append(splitView ? renderSplitDiff(selectedDiff!) : renderFile(selectedDiff!));
      attachHunkMenus(body);
      // Amend-only files (shown while amending) aren't in the index — their
      // blocks can't be staged/unstaged, so skip the per-hunk controls.
      if (!amendOnly(selected.path)) attachHunkControls(body);
    } else if (!diffLoaded) {
      body.append(el("div", { class: "detail-empty", text: "Loading changes…" }));
    } else {
      // Loaded, but no textual diff — a binary or Git-LFS-tracked file. It still
      // appears in the list and can be staged/committed like any change.
      body.append(
        el("div", { class: "detail-empty", text: "No text preview — binary or Git LFS file." }),
      );
    }
    pane.append(body);
  }

  // Unified / Split toggle above the diff.
  function diffToolbar(): HTMLElement {
    const mk = (label: string, on: boolean, set: boolean) => {
      const b = el("button", { class: `btn ghost small${on ? " active" : ""}`, text: label });
      b.addEventListener("click", () => {
        if (splitView === set) return;
        splitView = set;
        if (diffHost) renderDiffInto(diffHost);
      });
      return b;
    };
    return el("div", { class: "diff-toolbar" }, [
      mk("Unified", !splitView, false),
      mk("Split", splitView, true),
    ]);
  }

  // Per-block action buttons on each hunk header, revealed on hover: Stage /
  // Discard for unstaged blocks, Unstage for staged ones. The same operations
  // are also on the block's right-click menu (attachHunkMenus).
  function attachHunkControls(body: HTMLElement): void {
    const sel = selected;
    if (!sel) return;
    for (const hunkEl of body.querySelectorAll<HTMLElement>(".hunk[data-hunk]")) {
      const header = hunkEl.querySelector(".hunk-header");
      if (!header) continue;
      const index = Number(hunkEl.dataset.hunk);
      const actions = el("div", { class: "hunk-actions" });
      const btn = (label: string, danger: boolean, onClick: () => void) => {
        const b = el("button", { class: `hunk-btn${danger ? " danger" : ""}`, text: label });
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          onClick();
        });
        return b;
      };
      if (sel.panel === "unstaged") {
        actions.append(
          btn("Stage", false, () => void run(() => cb.stageHunk(sel.path, index))),
          btn("Discard…", true, () => void discardHunkAction(sel.path, index)),
        );
      } else {
        actions.append(btn("Unstage", false, () => void run(() => cb.unstageHunk(sel.path, index))));
      }
      header.append(actions);
    }
  }

  // Right-click a hunk block → stage / discard (unstaged) or unstage (staged)
  // just that block. Hunk index comes from the data-hunk attribute the diff
  // renderers set on each `.hunk` element.
  function attachHunkMenus(body: HTMLElement): void {
    const sel = selected;
    if (!sel) return;
    for (const hunkEl of body.querySelectorAll<HTMLElement>(".hunk[data-hunk]")) {
      const index = Number(hunkEl.dataset.hunk);
      hunkEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const items =
          sel.panel === "unstaged"
            ? [
                { label: "Stage this block", run: () => run(() => cb.stageHunk(sel.path, index)) },
                {
                  label: "Discard this block…",
                  danger: true,
                  run: () => void discardHunkAction(sel.path, index),
                },
              ]
            : [{ label: "Unstage this block", run: () => run(() => cb.unstageHunk(sel.path, index)) }];
        showContextMenu(e.clientX, e.clientY, items);
      });
    }
  }

  async function discardHunkAction(path: string, index: number): Promise<void> {
    const ok = await cb.confirm(`Discard this block of ${path}? This change will be lost.`);
    if (!ok) {
      cb.setStatus("Discard cancelled.");
      return;
    }
    await run(() => cb.discardHunk(path, index));
  }

  function panel(which: Panel, label: string, files: FileDiff[]): HTMLElement {
    const box = el("div", { class: "stage-panel" });

    const head = el("div", { class: "stage-head" }, [
      el("span", { class: "stage-title", text: `${label} (${files.length})` }),
    ]);
    const allBtn = el("button", {
      class: "btn ghost small",
      text: which === "unstaged" ? "Stage All" : "Unstage All",
    }) as HTMLButtonElement;
    allBtn.disabled = files.length === 0;
    allBtn.addEventListener("click", () =>
      run(which === "unstaged" ? cb.stageAll : cb.unstageAll),
    );
    head.append(allBtn);
    box.append(head);

    const tree = el("div", { class: "stage-tree" });
    if (files.length === 0) {
      tree.append(el("div", { class: "stage-empty", text: `No ${which} changes` }));
    } else {
      const status = new Map(files.map((f) => [f.path, f.status]));
      renderFileTree(tree, files.map((f) => f.path), {
        collapsed: collapsed[which],
        onToggle: (p) => {
          const set = collapsed[which];
          if (set.has(p)) set.delete(p);
          else set.add(p);
          render();
        },
        statusOf: (p) => status.get(p) ?? null,
        onFileClick: (p) => selectFile(which, p),
        onFileDblClick: (p) => {
          // Amend-only rows aren't really staged, so there's nothing to unstage.
          if (which === "staged" && amendOnly(p)) return;
          run(which === "unstaged" ? () => cb.stage(p) : () => cb.unstage(p));
        },
        selectedPath: selected?.panel === which ? selected.path : undefined,
      });
    }
    box.append(tree);
    return box;
  }

  function commitBox(): HTMLElement {
    const box = el("div", { class: "commit-box" });

    const subjectInput = el("input", {
      class: "commit-subject",
      placeholder: "Commit subject",
      value: subject,
      spellcheck: false,
    }) as HTMLInputElement;
    subjectInput.addEventListener("input", () => {
      subject = subjectInput.value;
      commitBtn.disabled = !canCommit();
    });

    const bodyInput = el("textarea", {
      class: "commit-body",
      placeholder: "Description",
      rows: 3,
    }) as HTMLTextAreaElement;
    bodyInput.value = body;
    bodyInput.addEventListener("input", () => {
      body = bodyInput.value;
    });
    autoGrowTextarea(bodyInput);

    const amendBox = el("input", { type: "checkbox" }) as HTMLInputElement;
    amendBox.checked = amend;
    amendBox.addEventListener("change", () => void toggleAmend(amendBox.checked));
    const amendLabel = el("label", { class: "commit-amend" }, [amendBox, "Amend"]);

    const commitBtn = el("button", { class: "btn commit-btn", text: "Commit" }) as HTMLButtonElement;
    commitBtn.disabled = !canCommit();
    commitBtn.addEventListener("click", () => {
      if (!canCommit()) return;
      const subj = subject.trim();
      const bdy = body;
      const am = amend;
      run(
        async () => {
          const out = await cb.commit(subj, bdy, am);
          cb.setStatus(out || "Committed.");
        },
        () => {
          subject = "";
          body = "";
          amend = false;
          amendFiles = [];
          amendPrefill = null;
          cb.onCommitted();
        },
      );
    });

    const controls = el("div", { class: "commit-controls" }, [amendLabel, commitBtn]);
    box.append(subjectInput, bodyInput, controls);
    return box;
  }

  // Toggle "Amend last commit": pull in HEAD's message (if the box is empty) and
  // its files (shown in Staged), or undo both when switching off.
  async function toggleAmend(on: boolean): Promise<void> {
    amend = on;
    if (on) {
      const head = await cb.fetchHead().catch(() => null);
      if (head) {
        amendFiles = head.files;
        // Only pre-fill an empty box, so we never clobber a typed message.
        if (subject.trim() === "" && body.trim() === "") {
          subject = head.summary;
          const rest = head.message.startsWith(head.summary)
            ? head.message.slice(head.summary.length)
            : head.message;
          body = rest.replace(/^\s+/, "").trimEnd();
          amendPrefill = { subject, body };
        }
      }
    } else {
      amendFiles = [];
      // Clear the message only if it's still exactly what we pre-filled.
      if (amendPrefill && subject === amendPrefill.subject && body === amendPrefill.body) {
        subject = "";
        body = "";
      }
      amendPrefill = null;
    }
    render();
  }

  // Files shown in the Staged panel: real staged changes plus, when amending,
  // HEAD's files that aren't already staged (so the amended commit's full
  // contents are visible). Real staged entries win on path collisions.
  function stagedDisplay(): FileDiff[] {
    if (!amend) return staged;
    const paths = new Set(staged.map((f) => f.path));
    return [...staged, ...amendFiles.filter((f) => !paths.has(f.path))];
  }

  // A staged-panel path that comes only from the amended commit (not actually
  // staged) — its diff is the cached HEAD hunks, and it can't be unstaged.
  function amendOnly(path: string): FileDiff | undefined {
    if (!amend || staged.some((f) => f.path === path)) return undefined;
    return amendFiles.find((f) => f.path === path);
  }

  function canCommit(): boolean {
    return subject.trim() !== "" && (staged.length > 0 || amend);
  }

  render();
  return { reload };
}
