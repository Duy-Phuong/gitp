// Linked worktrees: the sidebar's worktree menu, adding one (from a branch's
// menu, a commit or tag, a branch dropped on the Worktrees section, or Quick
// Launch), moving, removing, locking and pruning.

import {
  addWorktree,
  confirmDialog,
  lockWorktree,
  moveWorktree,
  pruneWorktrees,
  removeWorktree,
  revealPath,
  staleWorktrees,
  unlockWorktree,
  worktreeUnsavedWork,
} from "./api";
import { showContextMenu, type MenuItem } from "./views/context-menu";
import { siblingWorktreePath, worktreeName } from "./views/sidebar";
import type { BranchRef, StaleWorktree, Worktree, WorktreeTarget, WorktreeUnsavedWork } from "./types";
import { state } from "./app-state";
import { opFailed, readFailed, reportDone, setStatus } from "./report";
import { copyText } from "./clipboard";
import { closeRepoTab, loadRepo, loadSidebar } from "./shell";
import { deleteLocalBranch } from "./ref-actions";
import { openTerminalAt } from "./terminal-panel";
import { otherWorktreeWith } from "./branch-worktree";
import { askChoice } from "./views/choice-dialog";
import { openFormDialog } from "./views/form-dialog";
import type { DragRef } from "./ref-drop";
import { describeUnsavedWork, hasUnsavedWork, worktreeAtTarget, worktreeDrop } from "./worktree-rules";

// Right-click a worktree in the sidebar.
export function onWorktreeMenu(w: Worktree, x: number, y: number): void {
  const items: MenuItem[] = [];
  if (!w.is_current && !w.prunable) items.push({ label: "Open", run: () => void loadRepo(w.path) });
  if (!w.prunable) items.push({ label: "Reveal in Finder", run: () => void revealWorktree(w) });
  if (!w.prunable) items.push({ label: "Open Terminal Here", run: () => openTerminalAt(w.path) });
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
    // Moving it would pull the folder out from under this tab the same way.
    if (!w.is_current) {
      items.push(moveWorktreeItem(w));
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

// Before checking out local branch `branch`: when another worktree has it —
// a checkout git would refuse — offer to open that worktree instead, rather
// than asking about local changes first. Resolves true when it did (the
// checkout must not go ahead), false when the checkout can proceed.
export async function offerWorktreeWith(branch: string): Promise<boolean> {
  const wt = otherWorktreeWith(branch, state.worktrees);
  if (!wt) return false;
  const open = await askChoice(
    `“${branch}” is checked out in another worktree`,
    `A branch can be checked out in only one worktree at a time, and ${worktreeName(wt)} (${wt.path}) has it.`,
    [
      { label: "Cancel", answer: false, left: true },
      { label: "Open its worktree", answer: true, primary: true },
    ],
    false,
  );
  if (open) await loadRepo(wt.path);
  else setStatus("Checkout cancelled.");
  return true;
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

// "New Worktree here…" on a commit or tag: where it goes, and optionally a new
// branch for it — without one, a detached HEAD at `rev`. `label` names the
// commit or tag in the title and the default folder.
export function newWorktreeAtAction(rev: string, label: string): void {
  openFormDialog(
    {
      title: `New Worktree at ${label}`,
      fields: [
        { label: "Folder", value: defaultWorktreePath(label), required: true },
        { label: "New branch", placeholder: "Optional; without one the worktree is on a detached HEAD" },
      ],
      submitLabel: "Create Worktree",
    },
    ([path, branch]) => void addWorktreeAction(path, worktreeAtTarget(rev, branch)),
  );
}

// A branch dropped on the Worktrees section header: a worktree for it, at a
// folder the user can change — or, when one already has it checked out, that
// worktree (a branch can be in only one).
export function onWorktreeDrop(src: DragRef): void {
  const remote = src.kind === "remote" ? state.refs.remotes.find((r) => r.name === src.name)?.remote : undefined;
  const drop = worktreeDrop(src, state.refs.branches.map((b) => b.name), state.worktrees, remote);
  if (drop.kind === "open") {
    const wt = drop.worktree;
    if (wt.is_current) {
      setStatus(`${wt.branch} is checked out in this worktree.`);
      return;
    }
    void confirmDialog(`${wt.branch} is already checked out in the worktree ${worktreeName(wt)}.\n\nOpen it?`).then(
      (open) => {
        if (open) void loadRepo(wt.path);
      },
    );
    return;
  }
  openFormDialog(
    {
      title: `New Worktree for ${drop.branch}`,
      sub: drop.target.kind === "new_branch" ? `Creates the local branch ${drop.branch} from ${src.name}.` : undefined,
      fields: [{ label: "Folder", value: defaultWorktreePath(drop.branch), required: true }],
      submitLabel: "Create Worktree",
    },
    ([path]) => void addWorktreeAction(path, drop.target),
  );
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

// "Move…": a folder prompt, pre-filled with where it is now. A locked worktree
// says so up front (with Unlock) rather than after the user picks a folder.
function moveWorktreeItem(w: Worktree): MenuItem {
  const name = worktreeName(w);
  if (w.locked) {
    return {
      label: "Move…",
      run: () =>
        opFailed(
          `Can't move ${name}`,
          `${name} is locked${w.lock_reason ? ` (${w.lock_reason})` : ""}. Unlock it before moving it.`,
          { label: "Unlock", run: () => void runWorktreeOp(`Unlocking ${name}`, () => unlockWorktree(w.path)) },
        ),
    };
  }
  return {
    label: "Move…",
    prompt: { placeholder: "New folder for the worktree", value: w.path, onSubmit: (to) => void moveWorktreeAction(w, to) },
  };
}

// `git worktree move`, then — a tab open on the old folder would only fail
// from here on — reopen that tab at the new one, and come back to this tab.
async function moveWorktreeAction(w: Worktree, to: string): Promise<void> {
  const name = worktreeName(w);
  if (!to || to === w.path) return;
  setStatus(`Moving ${name}…`);
  let full: string;
  try {
    full = await moveWorktree(w.path, to);
  } catch (err) {
    opFailed(`Couldn't move ${name}`, err);
    return;
  }
  if (state.repos.some((r) => r.path === w.path)) {
    const here = state.repoPath;
    await closeRepoTab(w.path);
    await loadRepo(full);
    if (here) await loadRepo(here);
  } else {
    await loadSidebar();
  }
  reportDone(`Moved ${name} to ${full}`);
}

// Before a remove: the worktree's uncommitted files and the commits only its
// branch has, or null when they can't be read (a folder that's gone, say) —
// then git's own refusal of local changes is the safety net.
async function unsavedWorkOf(w: Worktree): Promise<WorktreeUnsavedWork | null> {
  if (w.prunable) return null;
  try {
    return await worktreeUnsavedWork(w.path);
  } catch {
    return null;
  }
}

// Remove a linked worktree. It's checked first for uncommitted changes and
// unpushed commits; if it has any, they're named and the choice is to open the
// worktree and deal with them, cancel, or remove it anyway — the only route to
// a forced remove. A clean one gets the plain confirmation.
// `deleteBranch`: then delete the branch it had checked out too — the branch
// delete's own flow, so an unmerged one still asks before a force delete.
export async function removeWorktreeAction(w: Worktree, deleteBranch = false): Promise<void> {
  const name = worktreeName(w);
  const branch = deleteBranch ? w.branch : null;
  const keeps = branch ? ` The branch ${branch} will be deleted too.` : w.branch ? ` The branch ${w.branch} is kept.` : "";
  const question = branch ? `Remove the worktree ${name} and delete the branch ${branch}?` : `Remove the worktree ${name}?`;
  setStatus(`Checking ${name} for unsaved work…`);
  const work = await unsavedWorkOf(w);
  let force = false;
  if (work && hasUnsavedWork(work)) {
    const answer = await askChoice<"open" | "remove" | "cancel">(
      `${name} has work that isn't saved anywhere else`,
      `${describeUnsavedWork(work, w.branch)}\n\n${question}${keeps}`,
      [
        { label: "Remove Anyway", answer: "remove", left: true },
        { label: "Cancel", answer: "cancel" },
        { label: "Open Worktree", answer: "open", primary: true },
      ],
      "cancel",
      "wt-unsaved",
    );
    if (answer === "open") {
      await loadRepo(w.path);
      return;
    }
    if (answer === "cancel") {
      setStatus("Remove cancelled.");
      return;
    }
    // Uncommitted changes are what git refuses to delete without --force;
    // unpushed commits alone don't stop it.
    force = work.changed.length > 0;
  } else if (!(await confirmDialog(`${question}\n\n${w.path} will be deleted.${keeps}`))) {
    setStatus("Remove cancelled.");
    return;
  }
  setStatus(`Removing worktree ${name}…`);
  try {
    await removeWorktree(w.path, force);
  } catch (err) {
    if (!/--force/.test(String(err))) {
      opFailed(`Couldn't remove ${name}`, err);
      return;
    }
    const anyway = await confirmDialog(
      `${name} has modified or untracked files.\n\nRemove it anyway? Those changes will be lost.`,
    );
    if (!anyway) {
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

// List what a prune would forget, and prune only once that's confirmed.
export async function pruneWorktreesAction(): Promise<void> {
  setStatus("Checking for stale worktrees…");
  let stale: StaleWorktree[];
  try {
    stale = await staleWorktrees();
  } catch (err) {
    opFailed("Couldn't check for stale worktrees", err);
    return;
  }
  if (!stale.length) {
    reportDone("Nothing to prune.");
    return;
  }
  const list = stale.map((x) => `  ${x.name ? `${x.name}: ` : ""}${x.reason}`).join("\n");
  const what = stale.length === 1 ? "this stale worktree" : `these ${stale.length} stale worktrees`;
  if (!(await confirmDialog(`Prune ${what}?\n\n${list}\n\nOnly git's record of each is removed; no folder is deleted.`))) {
    setStatus("Prune cancelled.");
    return;
  }
  await runWorktreeOp("Pruning worktrees", pruneWorktrees, "Nothing to prune.");
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
