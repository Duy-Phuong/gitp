// Branches, tags, stashes and remote branches in the sidebar: their right-click
// menus and the operations behind them.

import {
  checkoutBranch,
  checkoutRemoteBranch,
  deleteRemoteTag,
  deleteTag,
  fetchTagDetail,
  pushTag,
  remoteTagExists,
  confirmDialog,
  createBranchAt,
  createPullRequest,
  createTagAt,
  deleteBranch,
  deleteBranches,
  deleteRemoteBranch,
  remoteBranchExists,
  fastForwardBranch,
  fastForwardBranchTo,
  fetchAndUpdateBranch,
  fetchBranch,
  mergeBranch,
  pushBranch,
  pushBranchTo,
  rebaseOnto,
  renameBranch,
  renameRemoteBranch,
  setUpstream,
  unsetUpstream,
  applyStash,
  dropStash,
  renameStash,
  saveStashPatch,
} from "./api";
import { showContextMenu, type MenuItem } from "./views/context-menu";
import { openDeleteBranchModal, openDeleteTagModal } from "./views/delete-branch";
import { openRenameBranchModal } from "./views/rename-branch";
import { openTagDetailsModal } from "./views/tag-details";
import { openStashApplyModal } from "./views/stash-apply";
import type { BranchRef, StashRef } from "./types";
import { state } from "./app-state";
import { opFailed, reportDone, setStatus } from "./report";
import { copyText } from "./clipboard";
import {
  clearCommitSelection,
  loadChanges,
  loadRepo,
  loadSidebar,
  opFailedMaybeConflict,
  refreshConflictStatus,
  refreshHistory,
  renderSidebarNow,
  showReflog,
  showView,
} from "./shell";
import { checkoutCommitAction, confirmThenRun, openInteractiveRebase, resetAction } from "./commit-actions";
import { showComparison } from "./compare";
import { checkoutInNewWorktreeItem, worktreeOf } from "./worktree-actions";
import { worktreeName } from "./views/sidebar";
import { allRefsAt } from "./commit-refs";
import { dropActions, isAncestorInRows, type DragRef, type DropRef } from "./ref-drop";

// Double-click a branch: check it out, then reload history + sidebar from the new
// HEAD. Warns first if the working tree has uncommitted changes.
export async function checkoutBranchAction(b: BranchRef): Promise<void> {
  if (b.is_head) return;
  if (state.localChanges > 0) {
    const n = state.localChanges;
    const ok = await confirmDialog(
      `You have ${n} uncommitted change${n === 1 ? "" : "s"}.\n\n` +
        `Switch to "${b.name}"? Conflicting changes will block the checkout.`,
    );
    if (!ok) {
      setStatus("Checkout cancelled.");
      return;
    }
  }
  setStatus(`Checking out ${b.name}…`);
  try {
    await withBusyRef(b.name, () => checkoutBranch(b.name));
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    reportDone(`Checked out ${b.name}`);
  } catch (err) {
    // Conflicting local changes ("would be overwritten by checkout") come back
    // as multi-line git output — show the full reason, not just a status line.
    // A branch another worktree has checked out can't be checked out here too;
    // that worktree is one click away instead.
    const wt = worktreeOf(b.name);
    opFailed(
      `Couldn't switch to ${b.name}`,
      err,
      wt && !wt.is_current ? { label: "Open Worktree", run: () => void loadRepo(wt.path) } : undefined,
    );
  }
}

// --- Branch right-click menu ------------------------------------------------

// Build and open the actions menu for a right-clicked branch.
export function onBranchMenu(b: BranchRef, x: number, y: number): void {
  const current = state.refs.head;
  const items: MenuItem[] = [];
  // Every operation in this menu acts on `b`, so they all route through one
  // wrapper that spins `b`'s sidebar row for the duration.
  const onBranch = (label: string, op: () => Promise<string>, refreshLog: boolean) =>
    void runBranchOp(label, op, refreshLog, b.name);

  if (!b.is_head) items.push({ label: "Checkout", run: () => void checkoutBranchAction(b) });
  if (!b.is_head) items.push(compareWithHeadItem(b.name));
  // A branch can be checked out in only one worktree: where another has it,
  // offer that worktree instead of a second checkout.
  const wt = worktreeOf(b.name);
  if (wt && !wt.is_current) items.push({ label: `Open Worktree '${worktreeName(wt)}'`, run: () => void loadRepo(wt.path) });
  else if (!b.is_head) items.push(checkoutInNewWorktreeItem(b));
  items.push({ separator: true });
  items.push({
    label: "New Branch here…",
    prompt: {
      placeholder: "New branch name",
      onSubmit: (name) => onBranch(`Creating ${name}`, () => createBranchAt(name, b.target), true),
    },
  });
  items.push({
    label: "New Tag here…",
    prompt: {
      placeholder: "New tag name",
      onSubmit: (name) => onBranch(`Tagging ${b.name} as ${name}`, () => createTagAt(name, b.target), false),
    },
  });

  if (!b.is_head && current) {
    items.push({ separator: true });
    items.push({
      label: `Merge into ${current}`,
      run: () => onBranch(`Merging ${b.name} into ${current}`, () => mergeBranch(b.name), true),
    });
    items.push({
      label: `Rebase ${current} onto ${b.name}`,
      run: () =>
        void confirmThenRun(
          `Rebase ${current} onto ${b.name}? This rewrites commits on ${current}.`,
          `Rebasing ${current} onto ${b.name}`,
          () => rebaseOnto(b.name),
        ),
    });
    items.push({
      label: `Interactively Rebase ${current} onto ${b.name}…`,
      run: () => void openInteractiveRebase(b.name, b.name),
    });
  }

  items.push({ separator: true });
  items.push({ label: "Fetch", run: () => onBranch(`Fetching updates for ${b.name}`, () => fetchBranch(b.name), false) });
  items.push({
    label: "Fetch and Update (fast-forward)",
    run: () => onBranch(`Fetching and updating ${b.name}`, () => fetchAndUpdateBranch(b.name), true),
  });
  items.push({ label: "Push to origin", run: () => onBranch(`Pushing ${b.name}`, () => pushBranch(b.name), false) });
  if (b.behind > 0) {
    items.push({
      label: "Fast-forward to upstream",
      run: () => onBranch(`Fast-forwarding ${b.name}`, () => fastForwardBranch(b.name), true),
    });
  }
  items.push({ label: "Create Pull Request on origin", run: () => void createPullRequestAction(b) });

  items.push({ separator: true });
  items.push({
    label: "Set Upstream…",
    prompt: {
      placeholder: "Upstream (e.g. origin/main)",
      onSubmit: (up) => onBranch(`Setting upstream of ${b.name}`, () => setUpstream(b.name, up), false),
    },
  });
  items.push({ label: "Unset Upstream", run: () => onBranch(`Unsetting upstream of ${b.name}`, () => unsetUpstream(b.name), false) });

  items.push({ separator: true });
  items.push({ label: "Rename…", run: () => void renameBranchAction(b) });
  if (!b.is_head) items.push({ label: "Delete…", danger: true, run: () => void deleteBranchAction(b) });

  items.push({ separator: true });
  items.push({ label: "Show Reflog", run: () => showReflog(`refs/heads/${b.name}`) });
  items.push({ label: "Copy Branch Name", run: () => void copyText(b.name, `Copied ${b.name}`) });

  showContextMenu(x, y, items);
}

// --- Drag and drop ------------------------------------------------------------

// A branch dragged onto another (in the log or the sidebar): a menu at the drop
// point of what that can do — merge, rebase, reset, fast-forward, push. Each
// item is the same action its right-click menu runs.
export function onRefDrop(srcRef: DragRef, dstRef: DragRef, x: number, y: number): void {
  const src = resolveDragRef(srcRef);
  const dst = resolveDragRef(dstRef);
  if (!src || !dst) return;
  const current = state.refs.head;
  const actions = dropActions(src, dst, current, (a, d) => isAncestorInRows(state.rows, a, d));
  if (!actions.length) {
    setStatus(`Nothing to do with ${src.name} on ${dst.name}.`);
    return;
  }
  const items: MenuItem[] = [];
  for (const action of actions) {
    switch (action) {
      case "merge":
        items.push({
          label: `Merge ${src.name} into ${dst.name}`,
          run: () => void runBranchOp(`Merging ${src.name} into ${dst.name}`, () => mergeBranch(src.name), true, dst.name),
        });
        break;
      case "rebase":
        items.push({
          label: `Rebase ${src.name} onto ${dst.name}`,
          run: () =>
            void confirmThenRun(
              `Rebase ${src.name} onto ${dst.name}? This rewrites commits on ${src.name}.`,
              `Rebasing ${src.name} onto ${dst.name}`,
              () => rebaseOnto(dst.name),
            ),
        });
        break;
      case "interactive-rebase":
        items.push({ label: "Interactive Rebase…", run: () => void openInteractiveRebase(dst.name, dst.name) });
        break;
      case "reset":
        items.push({ heading: `Reset ${src.name} to ${dst.name}` });
        items.push({ label: "Soft (keep changes staged)…", run: () => void resetAction(dst.target, dst.name, "Soft") });
        items.push({ label: "Mixed (keep changes unstaged)…", run: () => void resetAction(dst.target, dst.name, "Mixed") });
        items.push({ label: "Hard (discard changes)…", danger: true, run: () => void resetAction(dst.target, dst.name, "Hard") });
        break;
      case "fast-forward":
        items.push({
          label: `Fast-forward ${dst.name} to ${src.name}`,
          run: () => void runBranchOp(`Fast-forwarding ${dst.name} to ${src.name}`, () => fastForwardBranchTo(dst.name, src.name), true, dst.name),
        });
        break;
      case "push": {
        const remote = state.refs.remotes.find((r) => r.name === dst.name)?.remote ?? "origin";
        const branch = dst.name.slice(remote.length + 1);
        items.push({
          label: `Push ${src.name} to ${dst.name}`,
          run: () => void runBranchOp(`Pushing ${src.name} to ${dst.name}`, () => pushBranchTo(src.name, remote, branch), false, src.name),
        });
        break;
      }
    }
  }
  showContextMenu(x, y, items);
}

// The branch a drag names, with the commit it points at now — or null if it
// has gone since the row was drawn.
function resolveDragRef(ref: DragRef): DropRef | null {
  const target =
    ref.kind === "local"
      ? state.refs.branches.find((b) => b.name === ref.name)?.target
      : state.refs.remotes.find((r) => r.name === ref.name)?.target;
  return target ? { ...ref, target } : null;
}

export function onBranchBulkMenu(x: number, y: number): void {
  const names = [...state.branchSelection];
  showContextMenu(x, y, [
    {
      label: `Delete ${names.length} Branches…`,
      danger: true,
      run: () => void deleteSelectedBranchesAction(names),
    },
  ]);
}

// Bulk delete, local-only (no per-branch "also delete on remote" — that needs
// an async remote probe per branch, which is a fussier feature on its own).
// Never deletes the checked-out branch; never force-deletes an unmerged one —
// both are silently skipped and called out in the summary, rather than
// interrupting a multi-branch op with one confirmation dialog per branch.
async function deleteSelectedBranchesAction(names: string[]): Promise<void> {
  const headName = state.refs.branches.find((b) => b.is_head)?.name;
  const targets = names.filter((n) => n !== headName);
  if (targets.length === 0) {
    setStatus("Nothing to delete — that's the current branch.");
    return;
  }
  const ok = await confirmDialog(
    `Delete ${targets.length} branch${targets.length === 1 ? "" : "es"} locally?\n\n${targets.join("\n")}`,
  );
  if (!ok) {
    setStatus("Delete cancelled.");
    return;
  }
  setStatus(`Deleting ${targets.length} branches…`);
  for (const name of targets) state.busyRefs.add(name);
  renderSidebarNow();
  // One call: the batch becomes a single undoable action, so Undo restores all
  // of them rather than only whichever happened to go last.
  let failed: string[] = [];
  try {
    ({ failed } = await deleteBranches(targets, false));
  } finally {
    state.busyRefs.clear();
    renderSidebarNow();
  }
  state.branchSelection = new Set();
  await loadSidebar();
  const parts = [`Deleted ${targets.length - failed.length} of ${targets.length} branches.`];
  if (failed.length) parts.push(`Not fully merged, skipped: ${failed.join(", ")}.`);
  if (names.length > targets.length) parts.push("Skipped the current branch.");
  reportDone(parts.join(" "));
}

// Right-click a stash: apply (with a delete-after checkbox), rename, save the
// diff as a patch, or drop.
export function onStashMenu(s: StashRef, x: number, y: number): void {
  const items: MenuItem[] = [
    {
      label: "Apply…",
      run: () =>
        openStashApplyModal(s, (drop) => {
          const verb = drop ? "Popping" : "Applying";
          void runStashOp(`${verb} stash@{${s.index}}`, () => applyStash(s.index, drop));
        }),
    },
    {
      label: "Rename…",
      prompt: {
        placeholder: "Stash message",
        value: s.message,
        onSubmit: (message) => void runStashOp(`Renaming stash@{${s.index}}`, () => renameStash(s.index, message)),
      },
    },
    { label: "Save as Patch…", run: () => void saveStashPatchAction(s) },
    { separator: true },
    { label: "Delete…", danger: true, run: () => void deleteStashAction(s) },
  ];
  showContextMenu(x, y, items);
}

// Click a "+N" ref badge in the log: every branch and tag on that commit, the
// ones pointing at it first. A branch checks out on click, a remote branch
// checks out as a tracking branch, and a tag opens its own menu.
//
// Each section is capped, so a commit on hundreds of branches still gets a menu
// that fits on screen.
const MORE_REFS_CAP = 20;

export function onMoreRefsMenu(id: string, x: number, y: number): void {
  const { tips, containing } = allRefsAt(id);
  const byName = new Map(state.refs.branches.map((b) => [b.name, b]));
  const branchItem = (name: string): MenuItem => {
    const b = byName.get(name);
    if (b?.is_head) return { label: `✓ ${name}` };
    return { label: name, run: () => (b ? void checkoutBranchAction(b) : undefined) };
  };
  const capped = (list: MenuItem[]): MenuItem[] =>
    list.length > MORE_REFS_CAP
      ? [...list.slice(0, MORE_REFS_CAP), { label: `…and ${list.length - MORE_REFS_CAP} more` }]
      : list;

  const here: MenuItem[] = [];
  for (const t of tips) {
    if (t.kind === "tag") {
      here.push({ label: `Tag ${t.name}…`, run: () => onTagMenu(t.name, id, x, y) });
      continue;
    }
    if (t.local) here.push(branchItem(t.name));
    for (const r of t.remotes) here.push({ label: r, run: () => void checkoutRemoteAction(r) });
  }
  const items: MenuItem[] = [];
  if (here.length) items.push({ heading: "At this commit" }, ...capped(here));
  if (containing.length) {
    if (items.length) items.push({ separator: true });
    items.push({ heading: "On branches" }, ...capped(containing.map(branchItem)));
  }
  if (!items.length) items.push({ label: "No refs on this commit" });
  showContextMenu(x, y, items);
}

// Right-click a tag. A tag names a commit, so most of these are the commit
// operations aimed at that commit, plus the tag-only ones (details, push,
// delete). Nothing here moves the tag itself — retagging is a delete plus a
// New Tag, which is clearer than a silent `--force`.
export function onTagMenu(name: string, target: string, x: number, y: number): void {
  const current = state.refs.head;
  const short = target.slice(0, 7);
  const items: MenuItem[] = [
    { label: "Checkout Commit…", run: () => void checkoutCommitAction(target, `${name} (${short})`) },
    { label: "Show Tag Details…", run: () => openTagDetailsModal(name, fetchTagDetail(name)) },
    compareWithHeadItem(name),
    { separator: true },
    { label: "Push to 'origin'…", run: () => void runTagOp(`Pushing ${name}`, () => pushTag(name)) },
  ];

  if (current) {
    items.push({ separator: true });
    items.push({
      label: `Merge into '${current}'…`,
      run: () =>
        void runBranchOp(`Merging ${name} into ${current}`, () => mergeBranch(name), true, name),
    });
    items.push({
      label: `Rebase on '${name}'…`,
      run: () =>
        void confirmThenRun(
          `Rebase ${current} onto ${name}? This rewrites commits on ${current}.`,
          `Rebasing ${current} onto ${name}`,
          () => rebaseOnto(name),
        ),
    });
    items.push({
      label: `Interactively Rebase on '${name}'…`,
      run: () => void openInteractiveRebase(name, name),
    });
  }

  items.push({ separator: true });
  items.push({
    label: "New Branch…",
    prompt: {
      placeholder: "New branch name",
      onSubmit: (branch) =>
        void runBranchOp(`Creating ${branch}`, () => createBranchAt(branch, target), true, name),
    },
  });
  items.push({
    label: "New Tag…",
    prompt: {
      placeholder: "New tag name",
      onSubmit: (tag) =>
        void runTagOp(`Tagging ${short} as ${tag}`, () => createTagAt(tag, target)),
    },
  });

  items.push({ separator: true });
  items.push({ label: "Delete…", danger: true, run: () => deleteTagAction(name) });

  items.push({ separator: true });
  items.push({ label: "Copy Tag Name", run: () => void copyText(name, `Copied ${name}`) });

  showContextMenu(x, y, items);
}

// A tag operation: run it, then reload the sidebar so the Tags section reflects
// it. Tags never move HEAD, so the log is left alone.
async function runTagOp(label: string, op: () => Promise<string>): Promise<void> {
  setStatus(`${label}…`);
  try {
    const out = (await op()).trim();
    await loadSidebar();
    reportDone(out || `${label} done.`);
  } catch (err) {
    opFailed(`${label} failed`, err);
  }
}

// Delete a tag, offering to remove it from origin too when it's actually there
// (probed live), the same flow as deleting a branch.
function deleteTagAction(name: string): void {
  const probe = remoteTagExists(name).catch(() => false);
  openDeleteTagModal(name, probe, (deleteRemote) => {
    void runDeleteTag(name, deleteRemote);
  });
}

async function runDeleteTag(name: string, deleteRemote: boolean): Promise<void> {
  setStatus(`Deleting tag ${name}…`);
  try {
    await deleteTag(name);
  } catch (err) {
    opFailed(`Delete tag ${name} failed`, err);
    return;
  }

  let note = `Deleted tag ${name}`;
  if (deleteRemote) {
    try {
      await deleteRemoteTag(name);
      note += " (local and origin)";
    } catch (err) {
      await loadSidebar();
      opFailed(`Deleted local tag ${name}, but deleting it on origin failed`, err);
      return;
    }
  }
  await loadSidebar();
  reportDone(note);
}

// Right-click a remote branch: check it out (as a local tracking branch) or
// copy its name.
export function onRemoteMenu(name: string, target: string, x: number, y: number): void {
  const items: MenuItem[] = [
    { label: "Checkout…", run: () => void checkoutRemoteAction(name) },
    compareWithHeadItem(name),
    { separator: true },
    { label: "Copy Branch Name", run: () => void copyText(name, `Copied ${name}`) },
  ];
  void target;
  showContextMenu(x, y, items);
}

// Check out a remote branch, creating/switching to a local tracking branch.
// Warns first if the working tree has uncommitted changes (like branch checkout).
export async function checkoutRemoteAction(name: string): Promise<void> {
  if (state.localChanges > 0) {
    const n = state.localChanges;
    const ok = await confirmDialog(
      `You have ${n} uncommitted change${n === 1 ? "" : "s"}.\n\n` +
        `Check out "${name}"? Conflicting changes will block it.`,
    );
    if (!ok) {
      setStatus("Checkout cancelled.");
      return;
    }
  }
  setStatus(`Checking out ${name}…`);
  try {
    const out = (await withBusyRef(name, () => checkoutRemoteBranch(name))).trim();
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    reportDone(out || `Checked out ${name}`);
  } catch (err) {
    opFailed(`Couldn't check out ${name}`, err);
  }
}

// Run a stash op, then refresh the sidebar and — if it's open — the Local
// Changes view (apply/pop mutate the working tree). Shows git's output.
export async function runStashOp(label: string, op: () => Promise<string>): Promise<void> {
  setStatus(`${label}…`);
  try {
    const out = (await op()).trim();
    await loadSidebar();
    if (state.view === "changes") await loadChanges();
    reportDone(out || `${label} done.`);
  } catch (err) {
    await opFailedMaybeConflict(`${label} failed`, err);
  }
}

export async function deleteStashAction(s: StashRef): Promise<void> {
  if (!(await confirmDialog(`Delete stash@{${s.index}}?\n\n${s.message}`))) return;
  await runStashOp(`Deleting stash@{${s.index}}`, () => dropStash(s.index));
}

export async function saveStashPatchAction(s: StashRef): Promise<void> {
  setStatus("Saving patch…");
  try {
    const out = await saveStashPatch(s.index, `stash-${s.index}.patch`);
    if (out === null) {
      setStatus("Save cancelled.");
      return;
    }
    reportDone(out || "Saved patch.");
  } catch (err) {
    opFailed("Save failed", err);
  }
}

// Run a branch op, then refresh the sidebar (and history when the op can move
// HEAD or change commits). Shows git's own output on success.
// Show an operation as in progress on the sidebar row it acts on, for as long
// as it runs.
//
// The status bar already spins for any "…" message, but on a fetch or a
// fast-forward the user's attention is on the branch they just right-clicked,
// not on the footer — and those are exactly the operations slow enough to leave
// someone wondering whether the click registered. Cleared in a `finally` so a
// failed operation can't strand a row spinning forever.
async function withBusyRef<T>(ref: string | undefined, run: () => Promise<T>): Promise<T> {
  if (!ref) return run();
  state.busyRefs.add(ref);
  renderSidebarNow();
  try {
    return await run();
  } finally {
    state.busyRefs.delete(ref);
    renderSidebarNow();
  }
}

/// `ref`: the branch/remote row to spin while this runs, when the operation
/// belongs to one.
export async function runBranchOp(
  label: string,
  op: () => Promise<string>,
  refreshLog: boolean,
  ref?: string,
): Promise<void> {
  setStatus(`${label}…`);
  try {
    const out = (await withBusyRef(ref, op)).trim();
    if (refreshLog) {
      showView("history");
      await Promise.all([refreshHistory(), loadSidebar()]);
    } else {
      await loadSidebar();
    }
    reportDone(out || `${label} done.`);
  } catch (err) {
    // A failed merge that left conflicts in progress gets a Resolve action.
    await refreshConflictStatus();
    const inConflict = state.conflict?.kind === "merge" && state.conflict.conflicted.length > 0;
    opFailed(
      `${label} failed`,
      err,
      inConflict ? { label: "Resolve Conflicts", run: () => showView("conflict") } : undefined,
    );
  }
}

// Rename a branch. A modal collects the new name and, when the branch exists on
// its remote (probed live via git ls-remote), offers to rename it there too.
export function renameBranchAction(b: BranchRef): void {
  const probe = remoteBranchExists(b.name).catch(() => null);
  openRenameBranchModal(b.name, probe, (newName, renameRemote) => {
    void runRename(b, newName, renameRemote);
  });
}

async function runRename(b: BranchRef, newName: string, renameRemote: boolean): Promise<void> {
  const oldName = b.name; // capture before any await (mock may mutate the ref)
  if (newName === oldName) return;
  setStatus(`Renaming ${oldName}…`);
  try {
    await withBusyRef(oldName, () => renameBranch(oldName, newName));
  } catch (err) {
    opFailed("Rename failed", err);
    return;
  }
  let note = `Renamed ${oldName} → ${newName}`;
  if (renameRemote) {
    try {
      // The local rename already landed, so the row now carries the new name.
      await withBusyRef(newName, () => renameRemoteBranch(newName));
      note += " (local and remote)";
    } catch (err) {
      await loadSidebar();
      opFailed(`Renamed local ${b.name}, but remote rename failed`, err);
      return;
    }
  }
  await loadSidebar();
  if (state.view === "history") await refreshHistory();
  reportDone(note);
}

// Delete a branch. A modal confirms and, when the branch genuinely exists on
// its remote (probed live via git ls-remote), offers to also delete it there.
// The local delete is safe (-d) and, if git refuses because it isn't merged,
// offers a force delete behind a second, explicit confirmation.
export function deleteBranchAction(b: BranchRef): void {
  const probe = remoteBranchExists(b.name).catch(() => null);
  openDeleteBranchModal(b.name, probe, (deleteRemote) => {
    void runDelete(b, deleteRemote);
  });
}

async function runDelete(b: BranchRef, deleteRemote: boolean): Promise<void> {
  setStatus(`Deleting ${b.name}…`);
  try {
    await withBusyRef(b.name, () => deleteBranch(b.name, false));
  } catch (err) {
    const msg = String(err);
    if (!/not fully merged/i.test(msg)) {
      opFailed("Delete failed", err);
      return;
    }
    const force = await confirmDialog(
      `${b.name} is not fully merged. Force delete? Unmerged commits will be lost.`,
    );
    if (!force) {
      setStatus("Delete cancelled.");
      return;
    }
    try {
      await withBusyRef(b.name, () => deleteBranch(b.name, true));
    } catch (err2) {
      opFailed("Delete failed", err2);
      return;
    }
  }

  let note = `Deleted ${b.name}`;
  if (deleteRemote) {
    try {
      await withBusyRef(b.name, () => deleteRemoteBranch(b.name));
      note += " (local and remote)";
    } catch (err) {
      await loadSidebar();
      opFailed(`Deleted local ${b.name}, but remote delete failed`, err);
      return;
    }
  }
  await loadSidebar();
  reportDone(note);
}

// Open the branch's pull-request page in the browser (URL derived from origin).
export async function createPullRequestAction(b: BranchRef): Promise<void> {
  setStatus(`Opening pull request for ${b.name}…`);
  try {
    const url = await createPullRequest(b.name);
    reportDone(`Opened pull request page: ${url}`);
  } catch (err) {
    opFailed("Create pull request failed", err);
  }
}

// --- Compare ----------------------------------------------------------------

// "Compare with Current Branch": what `ref` has that HEAD doesn't — three-dot,
// from their merge base, the way a pull request of `ref` into the current
// branch would read. The compare header can swap the two or switch to a
// straight two-dot diff.
function compareWithHeadItem(ref: string): MenuItem {
  const current = state.refs.head;
  return {
    label: current ? "Compare with Current Branch" : "Compare with HEAD",
    run: () => void compareRefsAction(current ?? "HEAD", ref),
  };
}

// Show the three-dot comparison of `base` with `head` in the History view's
// detail pane. Not the usual refresh-on-entry (as in jumpToCommit): a history
// change would re-select a commit over the comparison as it lands. A
// two-commit selection in the log would re-compare itself on the next refresh,
// so it's dropped first.
export async function compareRefsAction(base: string, head: string): Promise<void> {
  if (state.view !== "history") showView("history", { refreshHistory: false });
  await clearCommitSelection();
  setStatus(`Comparing ${base}...${head}…`);
  await showComparison(base, head, true);
}
