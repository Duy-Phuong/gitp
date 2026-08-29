// Local Changes: the staging area. Unstaged and Staged panels (collapsible file
// trees), the selected file's diff, and a commit box (subject + description +
// Amend + Commit). A stateful controller owns the selection, per-panel collapse
// state, and the commit fields, reloading from the backend after each mutation.

import { autoGrowTextarea, clear, copyToClipboard, el } from "../dom";
import type { CommitDetail, FileDiff, StatusLists } from "../types";
import { type MenuItem, showContextMenu } from "./context-menu";
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
  // File-level operations driven by the file-row right-click menu, each acting
  // on the current checkbox multi-selection (or the right-clicked file).
  discardFiles: (paths: string[]) => Promise<void>;
  stashFiles: (paths: string[]) => Promise<string>;
  saveFilesPatch: (paths: string[], staged: boolean, defaultName: string) => Promise<string | null>;
  addToGitignore: (paths: string[]) => Promise<number>;
  revealPath: (path: string) => Promise<void>;
  // Open the file in the OS default application (e.g. the user's editor).
  openInEditor: (path: string) => Promise<void>;
  // Absolute path of the active repo's working directory (for Copy Absolute
  // Path). Null when no repo is open.
  repoRoot: () => string | null;
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
  // Show git's full (often multi-line) output for a failed operation — e.g. a
  // pre-commit hook's messages — in a dialog rather than the status line.
  reportError: (title: string, detail: string) => void;
}

export interface ChangesHandle {
  reload: () => Promise<void>;
  // Apply a status snapshot the host already fetched, instead of running
  // `git status` again ourselves — the single most expensive read on a large
  // repo, so it should happen once per refresh, not once per view.
  applyStatus: (status: StatusLists) => void;
  // Pre-fill the commit subject/body — e.g. a merge/cherry-pick/revert's
  // pending message, so it's ready to commit here without retyping it. A
  // no-op once the user has typed anything, so it never clobbers real input.
  prefillMessage: (subject: string, body: string) => void;
}

export function setupChanges(host: HTMLElement, cb: ChangesCallbacks): ChangesHandle {
  // staged/unstaged hold summaries (no hunks); selectedDiff holds the fetched
  // hunks for the currently selected file only.
  let staged: FileDiff[] = [];
  let unstaged: FileDiff[] = [];
  let selected: { panel: Panel; path: string } | null = null;
  let selectedDiff: FileDiff | null = null;
  // The status-list summary (path/old_path/status, no hunks) that selectedDiff
  // was fetched for — lets loadSelectedDiff skip re-fetching on a reload() where
  // that summary hasn't changed (see loadSelectedDiff).
  let selectedDiffSummary: FileDiff | null = null;
  // Whether the current selection's diff fetch has completed — distinguishes
  // "still loading" from "loaded but no textual diff" (binary / Git LFS file).
  let diffLoaded = false;
  // Bumped on every diff fetch so a slow response for a since-changed selection
  // is discarded instead of overwriting the current one.
  let diffToken = 0;
  const collapsed: Record<Panel, Set<string>> = { unstaged: new Set(), staged: new Set() };
  // Checkbox multi-selection per panel, driving the file-row context menu.
  const checked: Record<Panel, Set<string>> = { unstaged: new Set(), staged: new Set() };
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
    applyStatus(await cb.fetchStatus());
  }

  // Render from an already-fetched status snapshot. The selected file's hunks
  // are loaded in the background (they have their own loading state and a
  // staleness token), so callers don't wait on a second round trip.
  function applyStatus(s: StatusLists): void {
    staged = s.staged;
    unstaged = s.unstaged;
    pruneChecked();
    resolveSelection();
    render();
    // Distinct changed paths (a file can be both staged and unstaged).
    const paths = new Set([...staged, ...unstaged].map((f) => f.path));
    cb.onChanged(paths.size);
    void loadSelectedDiff();
  }

  // Fetch (and render) the hunks for the current selection. No-op to an empty
  // diff pane when nothing is selected. Skips the fetch entirely when reload()
  // brought back the exact same status entry we already have hunks for — a
  // plain view switch shouldn't re-diff a file nothing happened to.
  async function loadSelectedDiff(): Promise<void> {
    const sel = selected;
    if (!sel) {
      selectedDiff = null;
      diffLoaded = false;
      selectedDiffSummary = null;
      if (diffHost) renderDiffInto(diffHost);
      return;
    }
    // Amend-only files aren't in the index; their diff is HEAD's cached hunks.
    if (sel.panel === "staged") {
      const cached = amendOnly(sel.path);
      if (cached) {
        selectedDiff = cached;
        diffLoaded = true;
        selectedDiffSummary = null;
        if (diffHost) renderDiffInto(diffHost);
        return;
      }
    }
    const summary = (sel.panel === "staged" ? staged : unstaged).find((f) => f.path === sel.path) ?? null;
    if (diffLoaded && selectedDiff && summary && sameSummary(summary, selectedDiffSummary)) {
      return; // status for this file is unchanged — the hunks we have are still current
    }
    const token = ++diffToken;
    selectedDiff = null;
    diffLoaded = false;
    const file = await cb.fetchFileDiff(sel.path, sel.panel === "staged");
    if (token !== diffToken) return; // selection moved on; drop this result
    selectedDiff = file;
    diffLoaded = true;
    selectedDiffSummary = summary;
    if (diffHost) renderDiffInto(diffHost);
  }

  function sameSummary(a: FileDiff, b: FileDiff | null): boolean {
    return b !== null && a.path === b.path && a.old_path === b.old_path && a.status === b.status;
  }

  // Keep the selection valid after files move between panels or disappear.
  function resolveSelection(): void {
    if (!selected) return;
    if (unstaged.some((f) => f.path === selected!.path)) selected = { panel: "unstaged", path: selected.path };
    else if (staged.some((f) => f.path === selected!.path)) selected = { panel: "staged", path: selected.path };
    else if (amendOnly(selected.path)) selected = { panel: "staged", path: selected.path };
    else selected = null;
  }

  async function run(
    action: () => Promise<void>,
    after?: () => void,
    errorTitle = "Operation failed",
  ): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await action();
      after?.(); // success-only side effects (clear the commit box, refresh history)
    } catch (err) {
      // A failed op — e.g. a pre-commit hook that reformats files and aborts the
      // commit — often still changes the working tree, so surface git's full
      // output and fall through to reload() so those changes appear.
      cb.setStatus(`${errorTitle}.`);
      cb.reportError(errorTitle, String(err));
    } finally {
      // Always re-read the working tree: hooks (or a partial op) may have
      // changed files whether or not the command itself succeeded.
      try {
        await reload();
      } catch (err) {
        cb.setStatus(`Failed to refresh changes: ${String(err)}`);
      }
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
    pane.append(diffToolbar(hasDiff));
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

  // Unified / Split toggle (when there's a diff to show) plus an always-present
  // Edit File shortcut, above the diff.
  function diffToolbar(hasDiff: boolean): HTMLElement {
    const mk = (label: string, on: boolean, set: boolean) => {
      const b = el("button", { class: `btn ghost small${on ? " active" : ""}`, text: label });
      b.addEventListener("click", () => {
        if (splitView === set) return;
        splitView = set;
        if (diffHost) renderDiffInto(diffHost);
      });
      return b;
    };
    const editBtn = el("button", {
      class: "btn ghost small icon-btn",
      text: "✎",
      title: "Edit File",
    });
    editBtn.addEventListener("click", () => void cb.openInEditor(selected!.path));
    return el("div", { class: "diff-toolbar" }, [
      el("div", { class: "diff-toolbar-group" }, hasDiff ? [mk("Unified", !splitView, false), mk("Split", splitView, true)] : []),
      editBtn,
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

  // Drop checked paths that no longer exist in their panel (files moved between
  // panels or disappeared after an operation).
  function pruneChecked(): void {
    for (const p of [...checked.unstaged]) {
      if (!unstaged.some((f) => f.path === p)) checked.unstaged.delete(p);
    }
    for (const p of [...checked.staged]) {
      if (!staged.some((f) => f.path === p)) checked.staged.delete(p);
    }
  }

  // Right-click a changed file row → the file-level context menu. Actions target
  // the panel's checked files when the right-clicked row is checked, otherwise
  // just that row.
  function openFileMenu(which: Panel, path: string, e: MouseEvent): void {
    e.preventDefault();
    // Amend-only staged rows aren't really in the index — no file ops apply.
    if (which === "staged" && amendOnly(path)) return;

    const files = which === "unstaged" ? unstaged : staged;
    const inPanel = new Set(files.map((f) => f.path));
    let paths = checked[which].has(path)
      ? [...checked[which]].filter((p) => inPanel.has(p))
      : [path];
    if (paths.length === 0) paths = [path];
    const n = paths.length;
    const many = n > 1;
    const label = (verb: string) => (many ? `${verb} ${n} Files` : verb);
    const statusOf = new Map(files.map((f) => [f.path, f.status]));
    const allUntracked = paths.every((p) => statusOf.get(p) === "Untracked");

    const copy = (abs: boolean) => {
      const root = cb.repoRoot();
      const text = paths.map((p) => (abs && root ? `${root}/${p}` : p)).join("\n");
      void copyToClipboard(text).then(() => cb.setStatus(`Copied ${n} path${many ? "s" : ""}.`));
    };
    const patch = () => {
      const base = many ? "changes" : (paths[0].split("/").pop() ?? "changes");
      cb.saveFilesPatch(paths, which === "staged", `${base}.patch`)
        .then((msg) => {
          if (msg) cb.setStatus(msg);
        })
        .catch((err) => cb.reportError("Save as Patch failed", String(err)));
    };

    const items: MenuItem[] =
      which === "unstaged"
        ? [
            { label: label("Stage"), run: () => stageEach(paths) },
            { label: `${label("Discard")}…`, danger: true, run: () => void discardFilesAction(paths) },
            { separator: true },
            {
              label: `${label("Stash")}…`,
              run: () => run(async () => cb.setStatus(await cb.stashFiles(paths))),
            },
            { label: "Save as Patch…", run: patch },
            { separator: true },
            { label: "Edit File", run: () => void cb.openInEditor(path) },
            { label: "Show in Finder", run: () => void cb.revealPath(path) },
            { label: "Copy Relative Path", run: () => copy(false) },
            { label: "Copy Absolute Path", run: () => copy(true) },
            ...(allUntracked
              ? [{ label: "Add to .gitignore", run: () => void ignoreAction(paths) }]
              : []),
            { separator: true },
            { label: "Stage All", run: () => run(cb.stageAll) },
          ]
        : [
            { label: label("Unstage"), run: () => unstageEach(paths) },
            { separator: true },
            { label: "Save as Patch…", run: patch },
            { separator: true },
            { label: "Edit File", run: () => void cb.openInEditor(path) },
            { label: "Show in Finder", run: () => void cb.revealPath(path) },
            { label: "Copy Relative Path", run: () => copy(false) },
            { label: "Copy Absolute Path", run: () => copy(true) },
            { separator: true },
            { label: "Unstage All", run: () => run(cb.unstageAll) },
          ];
    showContextMenu(e.clientX, e.clientY, items);
  }

  function stageEach(paths: string[]): void {
    run(async () => {
      for (const p of paths) await cb.stage(p);
    });
  }

  function unstageEach(paths: string[]): void {
    run(async () => {
      for (const p of paths) await cb.unstage(p);
    });
  }

  async function discardFilesAction(paths: string[]): Promise<void> {
    const what = paths.length > 1 ? `${paths.length} files` : paths[0];
    const ok = await cb.confirm(`Discard changes to ${what}? This cannot be undone.`);
    if (!ok) {
      cb.setStatus("Discard cancelled.");
      return;
    }
    await run(() => cb.discardFiles(paths));
  }

  async function ignoreAction(paths: string[]): Promise<void> {
    await run(async () => {
      const added = await cb.addToGitignore(paths);
      cb.setStatus(
        added > 0 ? `Added ${added} entr${added > 1 ? "ies" : "y"} to .gitignore.` : "Already ignored.",
      );
    });
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
        onFileContextMenu: (p, e) => openFileMenu(which, p, e),
        selectedPath: selected?.panel === which ? selected.path : undefined,
        // Amend-only rows can't be acted on, so no checkboxes while amending the
        // staged panel; otherwise every changed file gets one.
        checkable: !(which === "staged" && amend),
        checkedPaths: checked[which],
        onToggleCheck: (paths, on) => {
          for (const p of paths) on ? checked[which].add(p) : checked[which].delete(p);
          render();
        },
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
        "Commit failed",
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

  function prefillMessage(newSubject: string, newBody: string): void {
    if (subject.trim() !== "" || body.trim() !== "") return; // don't clobber what's already typed
    subject = newSubject;
    body = newBody;
    render();
  }

  render();
  return { reload, applyStatus, prefillMessage };
}
