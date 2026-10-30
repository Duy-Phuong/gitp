// Linked worktrees: the sidebar's worktree menu, adding one (from a branch's
// menu or Quick Launch), removing, locking and pruning.

import {
  addWorktree,
  confirmDialog,
  lockWorktree,
  pruneWorktrees,
  removeWorktree,
  revealPath,
  unlockWorktree,
} from "./api";
import { showContextMenu, type MenuItem } from "./views/context-menu";
import { siblingWorktreePath, worktreeName } from "./views/sidebar";
import type { BranchRef, Worktree, WorktreeTarget } from "./types";
import type { WipRow } from "./worktree-wip";
import { state } from "./app-state";
import { opFailed, readFailed, reportDone, setStatus } from "./report";
import { copyText } from "./clipboard";
import { closeRepoTab, loadRepo, loadSidebar } from "./shell";
import { deleteLocalBranch } from "./ref-actions";

// Right-click a worktree in the sidebar.
export function onWorktreeMenu(w: Worktree, x: number, y: number): void {
  const items: MenuItem[] = [];
  if (!w.is_current && !w.prunable) items.push({ label: "Open", run: () => void loadRepo(w.path) });
  if (!w.prunable) items.push({ label: "Reveal in Finder", run: () => void revealWorktree(w) });
  if (!w.is_main) {
    items.push({ separator: true });
    if (w.locked) {
      items.push({ label: "Unlock", run: () => void runWorktreeOp(`Unlocking ${worktreeName(w)}`, () => unlockWorktree(w.path)) });
    } else {
      items.push({
        label: "Lock…",
        prompt: {
          placeholder: "Reason (e.g. on an external drive)",
          onSubmit: (reason) => void runWorktreeOp(`Locking ${worktreeName(w)}`, () => lockWorktree(w.path, reason)),
        },
      });
    }
    // git refuses to remove the worktree it's run from; switch tabs first.
    if (!w.is_current) {
      items.push({ label: "Remove…", danger: true, run: () => void removeWorktreeAction(w) });
      if (w.branch) {
        items.push({
          label: "Remove Worktree and Delete Branch…",
          danger: true,
          run: () => void removeWorktreeAction(w, true),
        });
      }
    }
  }
  items.push({ separator: true });
  items.push({ label: "Copy Path", run: () => void copyText(w.path, `Copied ${w.path}`) });
  showContextMenu(x, y, items);
}

// Click another worktree's WIP row in the graph. Its changes can be staged and
// committed only from its own tab, so offer to open that.
export async function openWorktreeWip(row: WipRow): Promise<void> {
  const wt = row.worktree;
  if (!wt) return;
  const files = `${row.changes} changed file${row.changes === 1 ? "" : "s"}`;
  const question = `The worktree ${wt.name} has ${files}, in ${wt.path}.\n\nThey can be staged and committed from its own tab. Open it now?`;
  if (await confirmDialog(question)) await loadRepo(wt.path);
}

async function revealWorktree(w: Worktree): Promise<void> {
  try {
    await revealPath(w.path);
    setStatus(`Revealed ${w.path}`);
  } catch (err) {
    readFailed("Couldn't reveal the worktree", err);
  }
}

// The worktree that has `branch` checked out, if any.
export function worktreeOf(branch: string): Worktree | undefined {
  return state.worktrees.find((w) => w.branch === branch);
}

// The default folder for a new worktree of `branch` (see siblingWorktreePath).
export function defaultWorktreePath(branch: string): string {
  return siblingWorktreePath(state.worktrees.find((w) => w.is_main)?.path ?? state.repoPath, branch);
}

// The branch menu's "Check Out in New Worktree…" item: a path prompt,
// pre-filled with the default location.
export function checkoutInNewWorktreeItem(b: BranchRef): MenuItem {
  return {
    label: "Check Out in New Worktree…",
    prompt: {
      placeholder: "Folder for the new worktree",
      value: defaultWorktreePath(b.name),
      onSubmit: (path) => void addWorktreeAction(path, { kind: "branch", name: b.name }),
    },
  };
}

// Create a worktree, refresh the Worktrees section, and offer to open it.
export async function addWorktreeAction(path: string, target: WorktreeTarget): Promise<void> {
  setStatus(`Creating worktree at ${path}…`);
  let full: string;
  try {
    full = await addWorktree(path, target);
  } catch (err) {
    opFailed("Couldn't create the worktree", err);
    return;
  }
  await loadSidebar();
  reportDone(`Created worktree ${full}`);
  if (await confirmDialog(`Worktree created at ${full}.\n\nOpen it now?`)) await loadRepo(full);
}

// Remove a linked worktree. git refuses one with modified or untracked files;
// then a second, explicit confirmation forces it, discarding those changes.
// `deleteBranch`: then delete the branch it had checked out too — the branch
// delete's own flow, so an unmerged one still asks before a force delete.
export async function removeWorktreeAction(w: Worktree, deleteBranch = false): Promise<void> {
  const name = worktreeName(w);
  const branch = deleteBranch ? w.branch : null;
  const keeps = branch ? ` The branch ${branch} will be deleted too.` : w.branch ? ` The branch ${w.branch} is kept.` : "";
  const question = branch ? `Remove the worktree ${name} and delete the branch ${branch}?` : `Remove the worktree ${name}?`;
  if (!(await confirmDialog(`${question}\n\n${w.path} will be deleted.${keeps}`))) {
    setStatus("Remove cancelled.");
    return;
  }
  setStatus(`Removing worktree ${name}…`);
  try {
    await removeWorktree(w.path, false);
  } catch (err) {
    if (!/--force/.test(String(err))) {
      opFailed(`Couldn't remove ${name}`, err);
      return;
    }
    const force = await confirmDialog(
      `${name} has modified or untracked files.\n\nRemove it anyway? Those changes will be lost.`,
    );
    if (!force) {
      setStatus("Remove cancelled.");
      return;
    }
    try {
      await removeWorktree(w.path, true);
    } catch (err2) {
      opFailed(`Couldn't remove ${name}`, err2);
      return;
    }
  }
  // A tab still open on the deleted folder would only fail from here on.
  if (state.repos.some((r) => r.path === w.path)) await closeRepoTab(w.path);
  // No longer checked out anywhere, so git will now let it go. A refusal or a
  // cancelled force delete has reported itself; the worktree is gone either way.
  const deleted = branch !== null && (await deleteLocalBranch(branch));
  await loadSidebar();
  if (deleted) reportDone(`Removed worktree ${name} and deleted ${branch}`);
  else if (branch === null) reportDone(`Removed worktree ${name}`);
}

export function pruneWorktreesAction(): Promise<void> {
  return runWorktreeOp("Pruning worktrees", pruneWorktrees, "No stale worktrees to prune.");
}

async function runWorktreeOp(label: string, op: () => Promise<string>, emptyNote?: string): Promise<void> {
  setStatus(`${label}…`);
  try {
    const out = (await op()).trim();
    await loadSidebar();
    reportDone(out || emptyNote || `${label} done.`);
  } catch (err) {
    opFailed(`${label} failed`, err);
  }
}
