// Local Changes: the staging area. Unstaged and Staged panels (collapsible file
// trees), the selected file's diff, and a commit box (subject + description +
// Amend + Commit). A stateful controller owns the selection, per-panel collapse
// state, and the commit fields, reloading from the backend after each mutation.

import { clear, el } from "../dom";
import type { FileDiff, StatusLists } from "../types";
import { renderFile } from "./detail";
import { renderFileTree } from "./tree";

type Panel = "unstaged" | "staged";

export interface ChangesCallbacks {
  fetchStatus: () => Promise<StatusLists>;
  stage: (path: string) => Promise<void>;
  unstage: (path: string) => Promise<void>;
  stageAll: () => Promise<void>;
  unstageAll: () => Promise<void>;
  commit: (subject: string, body: string, amend: boolean) => Promise<string>;
  // After stage/unstage (refresh the sidebar change count).
  onChanged: () => void;
  // After a successful commit (refresh history + sidebar).
  onCommitted: () => void;
  setStatus: (msg: string) => void;
}

export interface ChangesHandle {
  reload: () => Promise<void>;
}

export function setupChanges(host: HTMLElement, cb: ChangesCallbacks): ChangesHandle {
  let staged: FileDiff[] = [];
  let unstaged: FileDiff[] = [];
  let selected: { panel: Panel; path: string } | null = null;
  const collapsed: Record<Panel, Set<string>> = { unstaged: new Set(), staged: new Set() };
  let subject = "";
  let body = "";
  let amend = false;
  let busy = false;
  let diffHost: HTMLElement | null = null;

  async function reload(): Promise<void> {
    const s = await cb.fetchStatus();
    staged = s.staged;
    unstaged = s.unstaged;
    resolveSelection();
    render();
  }

  // Keep the selection valid after files move between panels or disappear.
  function resolveSelection(): void {
    if (!selected) return;
    if (unstaged.some((f) => f.path === selected!.path)) selected = { panel: "unstaged", path: selected.path };
    else if (staged.some((f) => f.path === selected!.path)) selected = { panel: "staged", path: selected.path };
    else selected = null;
  }

  async function run(action: () => Promise<void>, after: () => void): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await action();
      after();
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
      panel("staged", "Staged", staged),
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
  }

  function renderDiffInto(pane: HTMLElement): void {
    clear(pane);
    const file = selected
      ? (selected.panel === "unstaged" ? unstaged : staged).find((f) => f.path === selected!.path)
      : undefined;
    if (file) pane.append(renderFile(file));
    else pane.append(el("div", { class: "detail-empty", text: "Select a file to view its changes." }));
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
      run(which === "unstaged" ? cb.stageAll : cb.unstageAll, cb.onChanged),
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
        onFileDblClick: (p) =>
          run(which === "unstaged" ? () => cb.stage(p) : () => cb.unstage(p), cb.onChanged),
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

    const amendBox = el("input", { type: "checkbox" }) as HTMLInputElement;
    amendBox.checked = amend;
    amendBox.addEventListener("change", () => {
      amend = amendBox.checked;
      commitBtn.disabled = !canCommit();
    });
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
          cb.onCommitted();
        },
      );
    });

    const controls = el("div", { class: "commit-controls" }, [amendLabel, commitBtn]);
    box.append(subjectInput, bodyInput, controls);
    return box;
  }

  function canCommit(): boolean {
    return subject.trim() !== "" && (staged.length > 0 || amend);
  }

  render();
  return { reload };
}
