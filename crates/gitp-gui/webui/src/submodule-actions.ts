// Submodules: the sidebar's submodule menu, updating / syncing them, and
// adding, re-pointing and removing one.

import {
  addSubmodule,
  confirmDialog,
  removeSubmodule,
  revealPath,
  setSubmoduleUrl,
  syncSubmodules,
  updateSubmodules,
} from "./api";
import { showContextMenu, type MenuItem } from "./views/context-menu";
import { openFormDialog } from "./views/form-dialog";
import type { Submodule } from "./types";
import { state } from "./app-state";
import { opFailed, readFailed, reportDone, setStatus } from "./report";
import { copyText } from "./clipboard";
import { loadRepo, loadSidebar } from "./shell";

// Right-click a submodule in the sidebar.
export function onSubmoduleMenu(sm: Submodule, x: number, y: number): void {
  const initialized = sm.state !== "uninitialized";
  const items: MenuItem[] = [];
  if (initialized) items.push({ label: "Open", run: () => openSubmodule(sm) });
  items.push(
    { label: initialized ? "Update" : "Initialize and Update", run: () => void updateSubmodulesAction(sm.path) },
    { label: "Update All Submodules", run: () => void updateSubmodulesAction(null) },
    { separator: true },
    { label: "Sync URL", run: () => void syncSubmodulesAction(sm.path) },
    {
      label: "Edit URL…",
      prompt: {
        placeholder: "Submodule URL",
        value: sm.url ?? "",
        onSubmit: (url) => {
          if (url !== sm.url) void runSubmoduleOp(`Changing the URL of ${sm.path}`, () => setSubmoduleUrl(sm.path, url));
        },
      },
    },
  );
  if (initialized) items.push({ label: "Reveal in Finder", run: () => void revealSubmodule(sm) });
  items.push({ separator: true });
  items.push({ label: "Copy Path", run: () => void copyText(sm.path, `Copied ${sm.path}`) });
  items.push({ separator: true });
  items.push({ label: "Remove…", danger: true, run: () => void removeSubmoduleAction(sm) });
  showContextMenu(x, y, items);
}

// "+" on the Submodules header / Quick Launch: a URL, and the folder to clone
// it into (left empty, git names it after the repository).
export function addSubmoduleAction(): void {
  openFormDialog(
    {
      title: "Add Submodule",
      sub: "Clones the repository into the folder and stages it, ready to commit.",
      fields: [
        { label: "URL:", placeholder: "git@github.com:owner/lib.git", required: true },
        { label: "Path:", placeholder: "Defaults to the repository's name" },
      ],
      submitLabel: "Add Submodule",
    },
    ([url, path]) =>
      void runSubmoduleOp(path ? `Adding submodule ${path}` : "Adding submodule", () => addSubmodule(url, path || null)),
  );
}

async function removeSubmoduleAction(sm: Submodule): Promise<void> {
  const ok = await confirmDialog(
    `Remove the submodule ${sm.path}?\n\n` +
      `Its folder and its local clone (with any changes or commits not pushed) are deleted. ` +
      `The removal is staged in Local Changes, ready to commit.`,
  );
  if (!ok) {
    setStatus("Remove cancelled.");
    return;
  }
  await runSubmoduleOp(`Removing submodule ${sm.path}`, () => removeSubmodule(sm.path));
}

// Open a submodule as a repo tab. Its path is relative to the repository's
// top folder — the current worktree's path, which (unlike the tab's path) is
// never a subfolder the user happened to open.
export function openSubmodule(sm: Submodule): void {
  const root = state.worktrees.find((w) => w.is_current)?.path ?? state.repoPath;
  void loadRepo(`${root.replace(/\/+$/, "")}/${sm.path}`);
}

async function revealSubmodule(sm: Submodule): Promise<void> {
  try {
    await revealPath(sm.path);
    setStatus(`Revealed ${sm.path}`);
  } catch (err) {
    readFailed("Couldn't reveal the submodule", err);
  }
}

// `git submodule update --init --recursive` for one submodule (`path`) or all.
// It can clone and fetch, so it runs as a network operation: progress in the
// status bar, and Cancel.
export function updateSubmodulesAction(path: string | null): Promise<void> {
  const label = path ? `Updating submodule ${path}` : "Updating submodules";
  return runSubmoduleOp(label, () => updateSubmodules(path), "Submodules are up to date.");
}

export function syncSubmodulesAction(path: string | null): Promise<void> {
  const label = path ? `Syncing the URL of ${path}` : "Syncing submodule URLs";
  return runSubmoduleOp(label, () => syncSubmodules(path));
}

// loadSidebar also hands the refreshed `git status` to Local Changes, where an
// updated submodule stops showing as changed.
async function runSubmoduleOp(label: string, op: () => Promise<string>, emptyNote?: string): Promise<void> {
  setStatus(`${label}…`);
  try {
    const out = (await op()).trim();
    await loadSidebar();
    reportDone(out || emptyNote || `${label} done.`);
  } catch (err) {
    await loadSidebar();
    opFailed(`${label} failed`, err);
  }
}
