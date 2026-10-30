// The Workspaces screen: named groups of repository folders (see
// local-workspaces.ts) and bulk Fetch / Pull / Open / Reveal / Remove over the
// checked repos. Laid out like Settings on the `.modal-overlay` / `.modal`
// shell: the workspaces on the left, the chosen one's repos on the right.
//
// Fetch and pull run a few repos at a time, each on a handle of its own in the
// backend, so the active repo is never switched or locked; each row shows its
// progress and then its result, and Cancel stops the batch.

import { el } from "../dom";
import {
  browseForFolder,
  cancelWorkspaceOps,
  confirmDialog,
  isCancelled,
  isTauri,
  onWorkspaceProgress,
  revealFolder,
  workspaceFetch,
  workspacePull,
  workspaceRepoSummary,
  workspaceScanFolder,
} from "../api";
import {
  folderName,
  loadLocalWorkspaces,
  runPool,
  saveLocalWorkspaces,
  summaryText,
  withRepoMoved,
  withReposAdded,
  withReposRemoved,
  withWorkspaceAdded,
  withWorkspaceDeleted,
  withWorkspaceRenamed,
  workspaceNameError,
  type LocalWorkspace,
} from "../local-workspaces";
import type { PullMode, RepoSummary } from "../types";
import { openFormDialog } from "./form-dialog";
import { showErrorDialog } from "./message-dialog";

export interface WorkspacesActions {
  activeRepo: () => string;
  // Open `paths` as tabs, the last one active.
  openRepos: (paths: string[]) => Promise<void>;
  // Reload the active repo's views after a batch fetched or pulled it.
  refreshActive: () => Promise<void>;
  // How a bulk Pull integrates: the Pull button's method.
  pullMode: () => PullMode;
  setStatus: (message: string) => void;
}

// Enough to overlap the network waits without a dozen gits fighting for the
// disk (or a remote's rate limit).
const CONCURRENCY = 3;

type RowResult = { kind: "queued" | "running" | "done" | "failed" | "cancelled"; text: string; detail?: string };

let overlay: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;
let unlisten: (() => void) | null = null;

// The fetch / pull batch belongs to the module, not to one dialog: closing the
// dialog doesn't stop it, so a reopened dialog has to show it still running —
// rows, Cancel, actions disabled — rather than let a second batch start over
// it and trip on index.lock. `view` is the open dialog the batch paints into.
let running = false;
let stopped = false;
const results = new Map<string, RowResult>();
let view: {
  paintResult: (path: string) => void;
  refreshBulkBar: () => void;
  note: (message: string) => void;
  loadSummary: (path: string) => Promise<void>;
} | null = null;

function setResult(path: string, r: RowResult): void {
  results.set(path, r);
  view?.paintResult(path);
}

export function closeWorkspacesDialog(): void {
  overlay?.remove();
  overlay = null;
  view = null;
  if (onKey) document.removeEventListener("keydown", onKey, true);
  onKey = null;
  unlisten?.();
  unlisten = null;
}

export function openWorkspacesDialog(actions: WorkspacesActions): void {
  closeWorkspacesDialog();

  let list = loadLocalWorkspaces();
  let current: string | null = list[0]?.name ?? null;
  const checked = new Set<string>();
  // What each repo's row shows: its summary (or why there is none), and the
  // outcome of the last bulk operation that included it.
  const summaries = new Map<string, RepoSummary | { error: string }>();
  // A new dialog starts with clean rows, unless a batch is still running.
  if (!running) results.clear();
  // The cells a progress event or a finished summary rewrites in place.
  const rowCells = new Map<string, { branch: HTMLElement; state: HTMLElement; result: HTMLElement; fix: HTMLElement }>();

  const commit = (next: LocalWorkspace[]) => {
    list = next;
    saveLocalWorkspaces(list);
  };
  const isMissing = (p: string) => {
    const s = summaries.get(p);
    return !!s && "missing" in s && s.missing;
  };

  overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal workspaces-modal", role: "dialog", "aria-label": "Workspaces" });
  overlay.append(modal);
  document.body.append(overlay);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeWorkspacesDialog();
  });

  const nav = el("nav", { class: "settings-nav workspaces-nav" });
  const body = el("div", { class: "workspaces-body" });
  const footer = el("span", { class: "workspaces-status", "aria-live": "polite" });
  const note = (message: string) => {
    footer.textContent = message;
  };

  // --- the workspace list ---------------------------------------------------

  const renderNav = () => {
    nav.replaceChildren();
    for (const w of list) {
      const b = el("button", { class: `settings-nav-item${w.name === current ? " active" : ""}`, title: w.name }, [
        el("span", { class: "workspaces-nav-name", text: w.name }),
        el("span", { class: "workspaces-nav-count", text: String(w.repos.length) }),
      ]);
      b.addEventListener("click", () => select(w.name));
      nav.append(b);
    }
    const add = el("button", { class: "btn ghost small workspaces-new", text: "New Workspace…" });
    add.addEventListener("click", newWorkspace);
    nav.append(add);
  };

  const select = (name: string | null) => {
    current = name;
    checked.clear();
    renderNav();
    renderBody();
  };

  const newWorkspace = () =>
    openFormDialog(
      { title: "New Workspace", sub: "A named group of repositories to fetch, pull or open together.", fields: [{ label: "Name", required: true }], submitLabel: "Create" },
      ([name]) => {
        const error = workspaceNameError(list, name);
        if (error) {
          note(error);
          return;
        }
        commit(withWorkspaceAdded(list, name));
        select(name.trim());
      },
    );

  const renameWorkspace = (from: string) =>
    openFormDialog({ title: "Rename Workspace", fields: [{ label: "Name", value: from, required: true }], submitLabel: "Rename" }, ([name]) => {
      const error = workspaceNameError(list, name, from);
      if (error) {
        note(error);
        return;
      }
      commit(withWorkspaceRenamed(list, from, name));
      select(name.trim());
    });

  const deleteWorkspace = async (name: string) => {
    if (!(await confirmDialog(`Delete the workspace “${name}”? Its repositories stay where they are on disk.`, "Delete Workspace"))) return;
    commit(withWorkspaceDeleted(list, name));
    select(list[0]?.name ?? null);
  };

  // --- adding repos -----------------------------------------------------------

  const pickFolder = async (title: string): Promise<string | null> => {
    const folder = await browseForFolder(title);
    if (!folder && !isTauri()) note("The folder picker is only available in the desktop app.");
    return folder;
  };

  const addRepos = (paths: string[]) => {
    if (!current) return;
    commit(withReposAdded(list, current, paths));
    renderNav();
    renderBody();
  };

  const addFolder = async () => {
    const folder = await pickFolder("Add a Repository to the Workspace");
    if (folder) addRepos([folder]);
  };

  const addAllInFolder = async () => {
    const folder = await pickFolder("Add Every Repository in a Folder");
    if (!folder) return;
    try {
      const found = await workspaceScanFolder(folder);
      if (found.length === 0) {
        note(`No repositories directly inside ${folder}.`);
        return;
      }
      addRepos(found);
      note(`Found ${found.length} ${found.length === 1 ? "repository" : "repositories"} in ${folder}.`);
    } catch (err) {
      note(`Couldn't read ${folder}: ${String(err)}`);
    }
  };

  const locate = async (from: string) => {
    if (!current) return;
    const to = await pickFolder(`Locate ${folderName(from)}`);
    if (!to) return;
    commit(withRepoMoved(list, current, from, to));
    checked.delete(from);
    summaries.delete(from);
    renderBody();
  };

  const remove = (paths: string[]) => {
    if (!current || paths.length === 0) return;
    commit(withReposRemoved(list, current, paths));
    for (const p of paths) checked.delete(p);
    renderNav();
    renderBody();
  };

  // --- rows -------------------------------------------------------------------

  const paintSummary = (path: string) => {
    const cells = rowCells.get(path);
    const s = summaries.get(path);
    if (!cells || !s) return;
    cells.fix.replaceChildren();
    cells.state.classList.remove("missing", "error");
    if ("error" in s) {
      cells.branch.textContent = "";
      cells.state.textContent = s.error;
      cells.state.classList.add("error");
    } else {
      cells.branch.textContent = s.missing ? "" : (s.branch ?? "detached");
      cells.state.textContent = summaryText(s);
      cells.state.classList.toggle("missing", s.missing);
    }
    if ("error" in s || s.missing) {
      const find = el("button", { class: "btn ghost small", text: "Locate…", title: "Choose where this repository is now" });
      find.addEventListener("click", () => void locate(path));
      const drop = el("button", { class: "btn ghost small", text: "Remove", title: "Remove from this workspace" });
      drop.addEventListener("click", () => remove([path]));
      cells.fix.append(find, drop);
    }
  };

  const loading = new Set<string>();
  const loadSummary = async (path: string) => {
    loading.add(path);
    try {
      summaries.set(path, await workspaceRepoSummary(path));
    } catch (err) {
      summaries.set(path, { error: String(err) });
    } finally {
      loading.delete(path);
    }
    paintSummary(path);
  };

  const paintResult = (path: string) => {
    const cell = rowCells.get(path)?.result;
    const r = results.get(path);
    if (!cell) return;
    cell.replaceChildren();
    cell.className = `workspaces-result ${r?.kind ?? ""}`;
    if (!r) return;
    if (r.kind === "running") cell.append(el("span", { class: "status-spinner", "aria-hidden": "true" }));
    const text = el("span", { text: r.text, title: r.detail ?? r.text });
    cell.append(text);
    if (r.kind === "failed" && r.detail) {
      const detail = r.detail;
      text.classList.add("workspaces-result-link");
      text.addEventListener("click", () => showErrorDialog(`${folderName(path)}: failed`, detail));
    }
  };

  // --- the chosen workspace -------------------------------------------------

  const renderBody = () => {
    body.replaceChildren();
    rowCells.clear();
    const ws = list.find((w) => w.name === current);
    if (!ws) {
      const create = el("button", { class: "btn", text: "New Workspace…" });
      create.addEventListener("click", newWorkspace);
      body.append(
        el("div", { class: "workspaces-empty" }, [
          el("p", { text: "No workspaces yet. A workspace is a named group of repositories you can fetch, pull or open together." }),
          create,
        ]),
      );
      return;
    }

    const rename = el("button", { class: "btn ghost small", text: "Rename…" });
    rename.addEventListener("click", () => renameWorkspace(ws.name));
    const del = el("button", { class: "btn ghost small", text: "Delete…" });
    del.addEventListener("click", () => void deleteWorkspace(ws.name));
    const addOne = el("button", { class: "btn ghost small", text: "Add Folder…", title: "Add one repository" });
    addOne.addEventListener("click", () => void addFolder());
    const addAll = el("button", { class: "btn ghost small", text: "Add All in Folder…", title: "Add every repository directly inside a folder" });
    addAll.addEventListener("click", () => void addAllInFolder());
    body.append(
      el("div", { class: "workspaces-head" }, [el("span", { class: "settings-heading", text: ws.name }), el("span", { class: "spacer" }), addOne, addAll, rename, del]),
    );

    if (ws.repos.length === 0) {
      body.append(el("div", { class: "workspaces-empty" }, [el("p", { text: "No repositories yet — add them with Add Folder… or Add All in Folder…." })]));
      return;
    }

    body.append(bulkBar(ws.repos));

    const all = el("input", { type: "checkbox", title: "Select all" });
    const syncAll = () => {
      all.checked = ws.repos.every((p) => checked.has(p));
      all.indeterminate = !all.checked && ws.repos.some((p) => checked.has(p));
    };
    all.addEventListener("change", () => {
      for (const p of ws.repos) {
        if (all.checked) checked.add(p);
        else checked.delete(p);
      }
      renderBody();
    });
    syncAll();

    const table = el("table", { class: "workspaces-table" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { class: "workspaces-check" }, [all]),
          el("th", { text: "Repository" }),
          el("th", { text: "Branch" }),
          el("th", { text: "Status" }),
          el("th", { text: "Result" }),
        ]),
      ]),
    ]);
    const tbody = el("tbody");
    for (const path of ws.repos) {
      const box = el("input", { type: "checkbox" });
      box.checked = checked.has(path);
      box.addEventListener("change", () => {
        if (box.checked) checked.add(path);
        else checked.delete(path);
        syncAll();
        refreshBulkBar();
      });
      const cells = {
        branch: el("td", { class: "workspaces-branch" }),
        state: el("td", { class: "workspaces-state" }),
        result: el("span", { class: "workspaces-result" }),
        fix: el("span", { class: "workspaces-fix" }),
      };
      rowCells.set(path, cells);
      tbody.append(
        el("tr", {}, [
          el("td", { class: "workspaces-check" }, [box]),
          el("td", { class: "workspaces-repo" }, [
            el("div", { class: "workspaces-name", text: folderName(path) }),
            el("div", { class: "workspaces-path", text: path, title: path }),
          ]),
          cells.branch,
          cells.state,
          el("td", {}, [cells.fix, cells.result]),
        ]),
      );
      paintSummary(path);
      paintResult(path);
    }
    table.append(tbody);
    body.append(el("div", { class: "workspaces-table-wrap" }, [table]));

    // A re-render (checking "all", say) mustn't ask again for what's on its way.
    const unknown = ws.repos.filter((p) => !summaries.has(p) && !loading.has(p));
    void runPool(unknown, 4, loadSummary);
  };

  // --- bulk actions -----------------------------------------------------------

  let refreshBulkBar = () => {};

  const bulkBar = (paths: string[]): HTMLElement => {
    const bar = el("div", { class: "workspaces-bulk" });
    const selected = () => paths.filter((p) => checked.has(p));
    const button = (label: string, title: string, run: (sel: string[]) => void) => {
      const b = el("button", { class: "btn ghost small", text: label, title });
      b.addEventListener("click", () => run(selected()));
      return b;
    };
    const fetchBtn = button("Fetch", "Fetch every remote of the checked repositories", (sel) => void runBatch("fetch", sel));
    const pullBtn = button("Pull", "Pull the checked repositories with the Pull button's method", (sel) => void runBatch("pull", sel));
    const openBtn = button("Open", "Open the checked repositories as tabs", (sel) => void openChecked(sel));
    const revealBtn = button("Reveal", "Show the checked repositories in the file manager", (sel) => void revealChecked(sel));
    const removeBtn = button("Remove", "Remove the checked repositories from this workspace (nothing is deleted)", remove);
    const cancelBtn = el("button", { class: "btn small", text: "Cancel", title: "Stop the running fetch / pull" });
    cancelBtn.addEventListener("click", cancelBatch);
    const count = el("span", { class: "workspaces-count" });
    refreshBulkBar = () => {
      const n = selected().length;
      count.textContent = n ? `${n} selected` : "Check repositories to act on them";
      for (const b of [fetchBtn, pullBtn, openBtn, revealBtn, removeBtn]) b.disabled = n === 0 || running;
      cancelBtn.style.display = running ? "" : "none";
    };
    refreshBulkBar();
    bar.append(count, el("span", { class: "spacer" }), fetchBtn, pullBtn, openBtn, revealBtn, removeBtn, cancelBtn);
    return bar;
  };

  // Painted through `view`, as the dialog may be closed and reopened midway.
  const runBatch = async (kind: "fetch" | "pull", paths: string[]) => {
    if (running || paths.length === 0) return;
    running = true;
    stopped = false;
    const workspace = current;
    view?.refreshBulkBar();
    for (const p of paths) setResult(p, { kind: "queued", text: "Queued" });
    const mode = actions.pullMode();
    let failed = 0;
    let done = 0;
    view?.note(`${kind === "fetch" ? "Fetching" : "Pulling"} ${paths.length} ${paths.length === 1 ? "repository" : "repositories"}…`);
    await runPool(
      paths,
      CONCURRENCY,
      async (path) => {
        setResult(path, { kind: "running", text: kind === "fetch" ? "Fetching…" : "Pulling…" });
        try {
          const out = kind === "fetch" ? await workspaceFetch(path) : await workspacePull(path, mode);
          const text = kind === "fetch" ? "Fetched" : /up.to.date/i.test(out) ? "Up to date" : "Pulled";
          setResult(path, { kind: "done", text, detail: out || text });
          done++;
        } catch (err) {
          if (isCancelled(err)) setResult(path, { kind: "cancelled", text: "Cancelled" });
          else {
            failed++;
            const detail = String(err);
            setResult(path, { kind: "failed", text: detail.split("\n")[0], detail });
          }
        }
        await view?.loadSummary(path);
      },
      () => stopped,
    );
    for (const p of paths) if (results.get(p)?.kind === "queued") setResult(p, { kind: "cancelled", text: "Cancelled" });
    running = false;
    view?.refreshBulkBar();
    const verb = kind === "fetch" ? "Fetched" : "Pulled";
    const message = `${verb} ${done} of ${paths.length}${failed ? ` · ${failed} failed` : ""}${stopped ? " · cancelled" : ""}.`;
    view?.note(message);
    actions.setStatus(`Workspace ${workspace ?? ""}: ${message}`);
    if (paths.includes(actions.activeRepo())) await actions.refreshActive();
  };

  const cancelBatch = () => {
    if (!running) return;
    stopped = true;
    note("Cancelling…");
    void cancelWorkspaceOps();
  };

  const openChecked = async (paths: string[]) => {
    const present = paths.filter((p) => !isMissing(p));
    if (present.length === 0) {
      note("The checked repositories are missing.");
      return;
    }
    closeWorkspacesDialog();
    await actions.openRepos(present);
  };

  const revealChecked = async (paths: string[]) => {
    for (const p of paths.filter((p) => !isMissing(p))) {
      try {
        await revealFolder(p);
      } catch (err) {
        setResult(p, { kind: "failed", text: String(err), detail: String(err) });
      }
    }
  };

  // Progress for this dialog's rows only; a row that has already finished
  // ignores a late event.
  void onWorkspaceProgress((p) => {
    if (results.get(p.path)?.kind !== "running") return;
    const pct = p.percent == null ? "" : ` ${p.percent}%`;
    setResult(p.path, { kind: "running", text: `${p.phase}${pct}` });
  }).then((stop) => {
    // The dialog may already be closed (or reopened) by the time the listener
    // is in place.
    if (overlay && modal.isConnected) unlisten = stop;
    else stop();
  });

  view = { paintResult, refreshBulkBar: () => refreshBulkBar(), note, loadSummary };
  if (running) note("A fetch or pull is still running…");

  const close = el("button", { class: "btn", text: "Done" });
  close.addEventListener("click", closeWorkspacesDialog);
  modal.append(
    el("div", { class: "modal-title", text: "Workspaces" }),
    el("div", { class: "settings-layout workspaces-layout" }, [nav, body]),
    el("div", { class: "modal-actions" }, [footer, el("span", { class: "spacer" }), close]),
  );

  onKey = (e: KeyboardEvent) => {
    // A dialog opened on top (New / Rename Workspace) handles its own Escape.
    const overlays = document.querySelectorAll(".modal-overlay");
    if (e.key === "Escape" && overlays[overlays.length - 1] === overlay) closeWorkspacesDialog();
  };
  document.addEventListener("keydown", onKey, true);

  renderNav();
  renderBody();
}
