// Whole-repository actions: the action bar's Undo / Redo / Pull / Push / Stash /
// Pop / Refresh, plus creating a branch, Clean up, and stage / unstage all.

import {
  applyPatchFile,
  confirmDialog,
  createBranch,
  deleteBranches,
  fetchAll,
  goneBranches,
  pull,
  push,
  pushForce,
  undo,
  redo,
  stageAll,
  stash,
  stashPop,
  unstageAll,
} from "./api";
import type { PullMode, StashOptions } from "./types";
import { state, ui } from "./app-state";
import { opFailed, reportDone, setStatus } from "./report";
import { markRemoteFetched } from "./fetch-age";
import { loadPullDefault, type PullDefault } from "./prefs";
import { setActionsBusy } from "./toolbar";
import { openStashDialog } from "./views/stash-dialog";
import {
  loadChanges,
  loadSidebar,
  operationInFlight,
  opFailedMaybeConflict,
  refreshHistory,
  renderSidebarNow,
  showView,
} from "./shell";

export async function undoAction(): Promise<void> {
  // The buttons disable on actionsBusy; the shortcut and Quick Launch reach
  // here directly, so guard again — an undo mid-pull or mid-stage is exactly
  // the kind of thing the busy flag exists to prevent.
  if (!state.repoPath || !ui.undoLabels.undo || operationInFlight()) return;
  const label = ui.undoLabels.undo;
  setActionsBusy(true, "#undo-btn");
  setStatus(`Undoing ${label}…`);
  try {
    ui.undoLabels = await undo();
    await Promise.all([refreshHistory(), loadSidebar()]);
    if (state.view === "changes") await loadChanges();
    reportDone(`Undid ${label}.`);
  } catch (err) {
    opFailed("Undo failed", err);
  } finally {
    setActionsBusy(false);
  }
}

export async function redoAction(): Promise<void> {
  if (!state.repoPath || !ui.undoLabels.redo || operationInFlight()) return;
  const label = ui.undoLabels.redo;
  setActionsBusy(true, "#redo-btn");
  setStatus(`Redoing ${label}…`);
  try {
    ui.undoLabels = await redo();
    await Promise.all([refreshHistory(), loadSidebar()]);
    if (state.view === "changes") await loadChanges();
    reportDone(`Redid ${label}.`);
  } catch (err) {
    opFailed("Redo failed", err);
  } finally {
    setActionsBusy(false);
  }
}

// Quick Launch's "Apply Patch…": pick a patch file and apply it to the working
// tree, staged — three-way where it doesn't apply cleanly, which can leave
// conflicts to resolve.
export async function applyPatchAction(): Promise<void> {
  if (!state.repoPath) return;
  try {
    const path = await applyPatchFile();
    if (path === null) {
      setStatus("Apply cancelled.");
      return;
    }
    await loadSidebar();
    if (state.view === "changes") await loadChanges();
    reportDone(`Applied ${path.split("/").pop()} — the changes are staged in Local Changes.`);
  } catch (err) {
    if (state.view === "changes") await loadChanges();
    await opFailedMaybeConflict(
      "Apply Patch failed",
      "The patch doesn't apply to these files as they are now — it may have been made from " +
        `other versions of them. Anything git could merge with conflicts is left to resolve.\n\n${String(err)}`,
    );
  }
}

async function pullAction(mode: PullMode): Promise<void> {
  if (!state.repoPath) return;
  setActionsBusy(true, "#pull-btn");
  setStatus("Pulling…");
  try {
    const out = await pull(mode);
    await Promise.all([refreshHistory(), loadSidebar()]);
    reportDone(out || "Pull complete.");
  } catch (err) {
    await opFailedMaybeConflict("Pull failed", err);
  } finally {
    setActionsBusy(false);
  }
}

// Run one of the four pull-menu methods, whichever it is.
export async function runPullMethod(mode: PullDefault): Promise<void> {
  if (mode === "FetchAll") await refreshAllAction();
  else await pullAction(mode);
}

// The plain Pull button: run whatever method is currently the default.
export async function runPullDefault(): Promise<void> {
  await runPullMethod(loadPullDefault());
}

// Git's own wording for "the remote has commits this branch doesn't" — the
// same rejection whether or not we've fetched recently (fetch first) or have
// (non-fast-forward). Confirmed against a real rejected push, not guessed;
// see gitp-core's remote.rs test of the same name in spirit.
function isNonFastForwardRejection(message: string): boolean {
  return message.includes("[rejected]") && (message.includes("fetch first") || message.includes("non-fast-forward"));
}

export async function pushAction(): Promise<void> {
  if (!state.repoPath) return;
  setActionsBusy(true, "#push-btn");
  setStatus("Pushing…");
  try {
    const out = await push();
    await loadSidebar();
    reportDone(out || "Push complete.");
  } catch (err) {
    const message = String(err);
    if (isNonFastForwardRejection(message)) {
      opFailed("Push rejected — your branch is behind", err, [
        { label: "Pull", run: () => void runPullDefault() },
        { label: "Force Push (--force-with-lease)", danger: true, run: () => void pushForceAction() },
      ]);
    } else {
      opFailed("Push failed", err);
    }
  } finally {
    setActionsBusy(false);
  }
}

export async function pushForceAction(): Promise<void> {
  if (!state.repoPath) return;
  setActionsBusy(true, "#push-btn");
  setStatus("Force pushing…");
  try {
    const out = await pushForce();
    await loadSidebar();
    reportDone(out || "Force push complete.");
  } catch (err) {
    opFailed("Force push failed", err);
  } finally {
    setActionsBusy(false);
  }
}

// The toolbar's Stash button and Quick Launch's "Save Stash": ask for the
// message and options first.
export function openStashDialogAction(): void {
  if (!state.repoPath) return;
  openStashDialog((opts) => void stashAction(opts));
}

export async function stashAction(opts: StashOptions): Promise<void> {
  if (!state.repoPath) return;
  setActionsBusy(true, "#stash-btn");
  setStatus("Stashing…");
  try {
    const out = await stash(opts);
    if (state.view === "changes") await loadChanges();
    await loadSidebar();
    reportDone(out || "Stashed.");
  } catch (err) {
    opFailed("Stash failed", err);
  } finally {
    setActionsBusy(false);
  }
}

export async function popAction(): Promise<void> {
  if (!state.repoPath) return;
  setActionsBusy(true, "#pop-btn");
  setStatus("Popping stash…");
  try {
    const out = await stashPop();
    if (state.view === "changes") await loadChanges();
    await loadSidebar();
    reportDone(out || "Popped stash.");
  } catch (err) {
    await opFailedMaybeConflict("Pop failed", err);
  } finally {
    setActionsBusy(false);
  }
}

// Fetch all remotes, then reload refs/history so every branch's ahead/behind
// (and the Push/Pull badges) reflect the remote — showing what needs a pull.
export async function refreshAllAction(): Promise<void> {
  if (!state.repoPath) return;
  setActionsBusy(true, "#refresh-btn");
  setStatus("Fetching all remotes…");
  try {
    const out = (await fetchAll()).trim();
    markRemoteFetched();
    await Promise.all([loadSidebar(), refreshHistory()]);
    if (state.view === "changes") await loadChanges();
    reportDone(out || "Refreshed.");
  } catch (err) {
    opFailed("Refresh failed", err);
  } finally {
    setActionsBusy(false);
  }
}

export async function createBranchAction(name: string): Promise<void> {
  setStatus(`Creating ${name}…`);
  try {
    await createBranch(name);
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    reportDone(`Created and switched to ${name}`);
  } catch (err) {
    opFailed("Create branch failed", err);
  }
}

// Fetch with pruning, then delete every local branch whose upstream is gone —
// the tidy-up after a batch of pull requests has been merged and their remote
// branches deleted.
//
// The deletion is forced (`git branch -D`), because a branch merged via a
// squash or rebase merge does not look merged to git and `-d` would refuse it.
// That is the whole point of the command, and also why it confirms with the
// full list first: forced deletion of work that only exists locally is not
// recoverable from the branch itself.
export async function cleanUpAction(): Promise<void> {
  if (!state.repoPath) return;
  setActionsBusy(true, "#refresh-btn");
  setStatus("Fetching and pruning…");
  try {
    await fetchAll();
    const gone = await goneBranches();
    if (gone.length === 0) {
      await loadSidebar();
      setStatus("Nothing to clean up — no branches have a deleted upstream.");
      return;
    }
    const ok = await confirmDialog(
      `Delete ${gone.length} local branch${gone.length === 1 ? "" : "es"} whose upstream is gone?\n\n` +
        `${gone.join("\n")}\n\n` +
        `This is a forced delete — any commits on them that were never pushed will be lost.`,
    );
    if (!ok) {
      await loadSidebar();
      setStatus("Clean up cancelled — pruned remotes, kept every branch.");
      return;
    }

    for (const name of gone) state.busyRefs.add(name);
    renderSidebarNow();
    // One call, so the whole batch is a single undoable action — Undo brings
    // back every branch it removed, not just the last.
    let failed: string[] = [];
    try {
      ({ failed } = await deleteBranches(gone, true));
    } finally {
      state.busyRefs.clear();
      renderSidebarNow();
    }

    state.branchSelection = new Set();
    await Promise.all([loadSidebar(), refreshHistory()]);
    const deleted = gone.length - failed.length;
    reportDone(
      failed.length
        ? `Cleaned up ${deleted} of ${gone.length} branches — Undo restores them. Failed: ${failed.join(", ")}.`
        : `Cleaned up ${deleted} branch${deleted === 1 ? "" : "es"} — Undo restores them.`,
    );
  } catch (err) {
    opFailed("Clean up failed", err);
  } finally {
    setActionsBusy(false);
  }
}

// Stage/unstage everything, then show the result — running them from the
// palette while looking at the log would otherwise change nothing on screen.
export async function stageAllAction(): Promise<void> {
  setStatus("Staging all changes…");
  try {
    await stageAll();
    showView("changes");
    await Promise.all([loadChanges(), loadSidebar()]);
    reportDone("Staged all changes.");
  } catch (err) {
    opFailed("Stage all failed", err);
  }
}

export async function unstageAllAction(): Promise<void> {
  setStatus("Unstaging all changes…");
  try {
    await unstageAll();
    showView("changes");
    await Promise.all([loadChanges(), loadSidebar()]);
    reportDone("Unstaged all changes.");
  } catch (err) {
    opFailed("Unstage all failed", err);
  }
}
