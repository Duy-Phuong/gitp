// Clean Up Storage: the repository's worktrees with their size and whether
// removing one would lose anything, the local branches already merged into
// the default branch, and the build folders (target, node_modules) with
// their size. Worktrees that are safe go in one click, merged branches in
// another (one Undo brings them back); build folders are only shown.

import { buildFolders, deleteBranches, diskUsage, listWorktrees, mergedBranches, removeWorktree, revealFolder, worktreeUnsavedWork } from "../api";
import { clear, el } from "../dom";
import { deletableBranches, formatBytes, worktreeVerdict } from "../storage-model";
import type { Worktree } from "../types";

export interface StorageCallbacks {
  // Refresh the sidebar and log after a removal or deletion.
  changed: () => Promise<void>;
  reportDone: (msg: string) => void;
  reportError: (title: string, err: unknown) => void;
}

let overlay: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;

export function closeStorageDialog(): void {
  overlay?.remove();
  overlay = null;
  if (onKey) document.removeEventListener("keydown", onKey, true);
  onKey = null;
}

const name = (path: string) => path.replace(/\/+$/, "").split("/").pop() ?? path;

export function openStorageDialog(repoRoot: string, cb: StorageCallbacks): void {
  closeStorageDialog();
  overlay = el("div", { class: "modal-overlay" });
  const body = el("div", { class: "storage-body" });
  const close = el("button", { class: "btn", text: "Close" });
  close.addEventListener("click", closeStorageDialog);
  overlay.append(
    el("div", { class: "modal storage-dialog" }, [
      el("div", { class: "modal-title", text: "Clean Up Storage" }),
      el("div", { class: "modal-sub", text: "What this repository and its worktrees take on disk, and what can go without losing work." }),
      body,
      el("div", { class: "modal-actions" }, [el("span", { class: "spacer" }), close]),
    ]),
  );
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeStorageDialog();
  });
  onKey = (e) => {
    if (e.key === "Escape") closeStorageDialog();
  };
  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);

  // A size cell filled when `du` answers; sizes of the same path are asked once.
  const sizes = new Map<string, Promise<number>>();
  const sizeCell = (path: string) => {
    const cell = el("span", { class: "storage-size", text: "measuring…" });
    if (!sizes.has(path)) sizes.set(path, diskUsage(path));
    sizes.get(path)!.then(
      (n) => (cell.textContent = formatBytes(n)),
      () => (cell.textContent = "—"),
    );
    return cell;
  };

  const section = (title: string, hint: string) => {
    const list = el("div", { class: "storage-list" });
    const actions = el("div", { class: "storage-actions" });
    body.append(
      el("section", { class: "storage-section" }, [
        el("h3", { class: "storage-title", text: title }),
        el("div", { class: "storage-hint", text: hint }),
        list,
        actions,
      ]),
    );
    return { list, actions };
  };

  async function render(): Promise<void> {
    clear(body);
    body.append(el("div", { class: "storage-hint", text: "Reading…" }));
    let worktrees: Worktree[];
    let merged: { base: string; branches: string[] };
    let folders: string[];
    try {
      [worktrees, merged, folders] = await Promise.all([
        listWorktrees(),
        mergedBranches().catch(() => ({ base: "", branches: [] })),
        buildFolders().catch(() => []),
      ]);
    } catch (err) {
      clear(body);
      cb.reportError("Couldn't read the storage", err);
      return;
    }
    clear(body);
    const mergedSet = new Set(merged.branches);

    // --- worktrees ---
    const linked = worktrees.filter((w) => !w.is_main && !w.prunable);
    const wt = section(
      `Worktrees · ${linked.length}`,
      "Safe ones are ticked: nothing changed or untracked, and their commits pushed or merged. Removing deletes the folder; the branch stays.",
    );
    const picked = new Set<string>();
    const removeBtn = el("button", { class: "btn", text: "Remove" });
    const paintRemove = () => {
      removeBtn.textContent = `Remove ${picked.size} worktree${picked.size === 1 ? "" : "s"}`;
      removeBtn.disabled = picked.size === 0;
    };
    if (!linked.length) wt.list.append(el("div", { class: "storage-empty", text: "No linked worktrees." }));
    for (const w of linked) {
      const box = el("input", { type: "checkbox" });
      box.disabled = true;
      const why = el("span", { class: "storage-why", text: "checking…" });
      wt.list.append(
        el("label", { class: "storage-row", title: w.path }, [
          box,
          el("span", { class: "storage-name", text: name(w.path) }),
          el("span", { class: "storage-branch", text: w.branch ?? "detached" }),
          why,
          sizeCell(w.path),
        ]),
      );
      void worktreeUnsavedWork(w.path).then(
        (work) => {
          const v = worktreeVerdict(w, work, mergedSet);
          why.textContent = v.why;
          why.classList.toggle("safe", v.safe);
          box.disabled = !v.safe;
          box.checked = v.safe;
          if (v.safe) picked.add(w.path);
          paintRemove();
        },
        () => (why.textContent = "couldn't check"),
      );
      box.addEventListener("change", () => {
        if (box.checked) picked.add(w.path);
        else picked.delete(w.path);
        paintRemove();
      });
    }
    removeBtn.addEventListener("click", () => void removeWorktrees([...picked]));
    paintRemove();
    if (linked.length) wt.actions.append(removeBtn);

    // --- merged branches ---
    const offered = deletableBranches(merged.branches, worktrees);
    const br = section(
      `Branches merged into ${merged.base || "the default branch"} · ${offered.length}`,
      "Their commits are all in the default branch already. One Undo brings them back.",
    );
    const chosen = new Set(offered);
    const deleteBtn = el("button", { class: "btn", text: "Delete" });
    const paintDelete = () => {
      deleteBtn.textContent = `Delete ${chosen.size} branch${chosen.size === 1 ? "" : "es"}`;
      deleteBtn.disabled = chosen.size === 0;
    };
    if (!offered.length) br.list.append(el("div", { class: "storage-empty", text: "No merged branches to delete." }));
    for (const b of offered) {
      const box = el("input", { type: "checkbox" });
      box.checked = true;
      box.addEventListener("change", () => {
        if (box.checked) chosen.add(b);
        else chosen.delete(b);
        paintDelete();
      });
      br.list.append(el("label", { class: "storage-row" }, [box, el("span", { class: "storage-name", text: b })]));
    }
    deleteBtn.addEventListener("click", () => void deleteMerged([...chosen]));
    paintDelete();
    if (offered.length) br.actions.append(deleteBtn);

    // --- build folders ---
    const bf = section(
      `Build folders · ${folders.length}`,
      "Made again by the next build or install: cargo clean, or delete node_modules, when you need the space.",
    );
    if (!folders.length) bf.list.append(el("div", { class: "storage-empty", text: "No target or node_modules folders." }));
    for (const f of folders) {
      const show = el("button", { class: "btn ghost small", text: "Show in Finder" });
      show.addEventListener("click", () => void revealFolder(f));
      const rel = f.startsWith(`${repoRoot}/`) ? f.slice(repoRoot.length + 1) : f;
      bf.list.append(el("div", { class: "storage-row" }, [el("span", { class: "storage-name", text: rel }), sizeCell(f), show]));
    }
  }

  async function removeWorktrees(paths: string[]): Promise<void> {
    let done = 0;
    const failed: string[] = [];
    for (const p of paths) {
      try {
        await removeWorktree(p, true);
        done++;
      } catch {
        failed.push(name(p));
      }
    }
    await cb.changed();
    cb.reportDone(`Removed ${done} worktree${done === 1 ? "" : "s"}${failed.length ? `; couldn't remove ${failed.join(", ")}` : ""}.`);
    if (overlay) await render();
  }

  async function deleteMerged(names: string[]): Promise<void> {
    try {
      const out = await deleteBranches(names, true);
      await cb.changed();
      const n = names.length - out.failed.length;
      cb.reportDone(`Deleted ${n} merged branch${n === 1 ? "" : "es"} — Undo restores them.${out.failed.length ? ` Failed: ${out.failed.join(", ")}.` : ""}`);
    } catch (err) {
      cb.reportError("Couldn't delete the branches", err);
    }
    if (overlay) await render();
  }

  void render();
}
