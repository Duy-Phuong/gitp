// Operations on commits in the log: the commit right-click menu (single and
// multi-select), the history-rewriting rebase shortcuts, and batch cherry-pick.

import {
  WORKDIR_REV,
  bisectStart,
  checkoutCommit,
  cherryPick,
  confirmDialog,
  createBranchAt,
  createTagAt,
  createBackupBranch,
  fetchRebaseTodo,
  fetchStatusSummary,
  interactiveRebase,
  resetTo,
  restoreFilesFromCommit,
  revertCommit,
} from "./api";
import { $ } from "./dom";
import { logRowHeight, renderLog } from "./views/log";
import { showCommitMenu } from "./views/commit-menu";
import { showContextMenu, type MenuItem } from "./views/context-menu";
import { openRebaseModal, type RebaseOptions } from "./views/rebase";
import type { CommitRow, RebaseAction, RebaseStep, ReflogEntry, ResetMode } from "./types";
import { state, ui } from "./app-state";
import { opFailed, readFailed, reportDone, setStatus } from "./report";
import { copyText } from "./clipboard";
import { combinedDiffEnds, showComparison } from "./compare";
import { refLabelsAt } from "./commit-refs";
import {
  bisectStep,
  clearCommitSelection,
  loadMoreCommits,
  loadSidebar,
  onCommitMultiSelect,
  refreshConflictStatus,
  refreshHistory,
  refreshRebaseStatus,
  runBisectOp,
  selectCommit,
  showView,
} from "./shell";

// Load the commits that would be replayed, then open the interactive-rebase
// editor. Runs the resulting plan against the current branch. `onto` is the
// base the branch is replayed on — a branch name (branch menu) or a commit's
// parent for "rebase to here".
export async function openInteractiveRebase(onto: string, ontoLabel: string): Promise<void> {
  const current = state.refs.head ?? "HEAD";
  setStatus(`Preparing rebase of ${current} onto ${ontoLabel}…`);
  try {
    const commits = await fetchRebaseTodo(onto);
    if (commits.length === 0) {
      setStatus(`Nothing to rebase — ${current} has no commits ahead of ${ontoLabel}.`);
      return;
    }
    openRebaseModal(ontoLabel, current, commits, (steps, opts) => {
      void runRebasePlan(onto, ontoLabel, steps, opts);
    });
  } catch (err) {
    readFailed("Rebase preparation failed", err);
  }
}

// Execute a planned rebase: optional backup branch, run it (optionally moving
// dependent refs), then refresh and surface whether it completed or paused.
async function runRebasePlan(
  onto: string,
  ontoLabel: string,
  steps: RebaseStep[],
  opts: RebaseOptions,
): Promise<void> {
  const current = state.refs.head ?? "HEAD";
  setStatus(`Rebasing ${current} onto ${ontoLabel}…`);
  try {
    if (opts.backup) {
      const base = current.replace(/[^\w.-]+/g, "-");
      await createBackupBranch(`${base}-backup-${Date.now()}`);
    }
    const out = (await interactiveRebase(onto, steps, opts.updateRefs)).trim();
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    await refreshRebaseStatus();
    if (!state.rebase?.in_progress) reportDone(out || `Rebased ${current} onto ${ontoLabel}.`);
  } catch (err) {
    await refreshRebaseStatus();
    // A rebase that can't even start (e.g. uncommitted local changes) reports a
    // multi-line reason — surface it in a dialog, not just the status line.
    opFailed("Rebase failed", err);
  }
}

// Interactive rebase of the current branch so `commit` and everything after it
// are in the todo — i.e. replay onto the commit's first parent ("to here").
export async function rebaseToHere(commit: CommitRow): Promise<void> {
  await openInteractiveRebase(`${commit.id}~1`, `parent of ${commit.short_id}`);
}

// A one-commit interactive rebase that applies `action` to `commit` alone
// (reword / edit / squash-into-parent / fixup-into-parent / drop). The plan
// replays from the commit's parent; squash/fixup need the parent included too,
// so those replay from the grandparent with the parent kept as a pick.
export async function quickRebase(commit: CommitRow, action: RebaseAction, message?: string): Promise<void> {
  const meldsIntoParent = action === "squash" || action === "fixup";
  const onto = meldsIntoParent ? `${commit.id}~2` : `${commit.id}~1`;
  const ontoLabel = meldsIntoParent ? `grandparent of ${commit.short_id}` : `parent of ${commit.short_id}`;
  setStatus(`Preparing ${action} of ${commit.short_id}…`);
  try {
    const commits = await fetchRebaseTodo(onto);
    if (commits.length === 0) {
      setStatus(`Nothing to rebase for ${commit.short_id}.`);
      return;
    }
    const steps: RebaseStep[] = commits.map((c) => ({
      sha: c.sha,
      action: c.sha === commit.id ? action : "pick",
      message: c.sha === commit.id && action === "reword" ? (message ?? c.subject) : null,
    }));
    await runRebasePlan(onto, ontoLabel, steps, { updateRefs: false, backup: false });
  } catch (err) {
    opFailed(`Could not ${action} commit`, err);
  }
}

// --- Bulk commit actions (multi-select in the log) --------------------------

// The multi-selected commits, oldest first — state.rows is newest-first, and
// every bulk action below needs to replay/apply history in chronological
// order.
function selectedCommitsOldestFirst(): CommitRow[] {
  const ids = state.commitSelection;
  return state.rows.filter((r) => ids.has(r.id)).reverse();
}

async function copySelectedShasAction(commits: CommitRow[]): Promise<void> {
  await copyText(commits.map((c) => c.id).join("\n"), `Copied ${commits.length} SHA${commits.length === 1 ? "" : "s"}.`);
}

// Drop every selected commit via an interactive rebase from the oldest one's
// parent to HEAD — valid for any selection, contiguous or not.
async function dropSelectedCommits(commits: CommitRow[]): Promise<void> {
  const oldest = commits[0];
  const onto = `${oldest.id}~1`;
  const ids = new Set(commits.map((c) => c.id));
  setStatus(`Preparing to drop ${commits.length} commits…`);
  try {
    const todo = await fetchRebaseTodo(onto);
    const steps: RebaseStep[] = todo.map((c) => ({ sha: c.sha, action: ids.has(c.sha) ? "drop" : "pick", message: null }));
    await runRebasePlan(onto, `parent of ${oldest.short_id}`, steps, { updateRefs: false, backup: false });
  } catch (err) {
    opFailed("Could not drop commits", err);
  }
}

// Squash every selected commit into one, via the same rebase-plan mechanism:
// the oldest selected commit stays `pick` (the target) and every other
// selected one becomes `squash`, melding forward into it in order. That only
// produces one combined commit if the selection is a contiguous run in the
// rebase todo — a scattered selection would instead squash each into
// whatever unrelated commit happens to precede it, so it's rejected instead.
async function squashSelectedCommits(commits: CommitRow[]): Promise<void> {
  const oldest = commits[0];
  const onto = `${oldest.id}~1`;
  const ids = new Set(commits.map((c) => c.id));
  setStatus(`Preparing to squash ${commits.length} commits…`);
  try {
    const todo = await fetchRebaseTodo(onto);
    const selectedIdxs = todo.map((c, i) => (ids.has(c.sha) ? i : -1)).filter((i) => i >= 0);
    if (selectedIdxs.length !== ids.size) {
      opFailed(
        "Could not squash commits",
        "Some selected commits aren't on a straight line from here to HEAD (e.g. on a different branch), so they can't be rebased together.",
      );
      return;
    }
    const [first, last] = [Math.min(...selectedIdxs), Math.max(...selectedIdxs)];
    if (last - first + 1 !== selectedIdxs.length) {
      opFailed(
        "Could not squash commits",
        "The selected commits aren't consecutive in history. Squash only combines an unbroken run of commits into one — select a contiguous range and try again.",
      );
      return;
    }
    const steps: RebaseStep[] = todo.map((c, i) => ({
      sha: c.sha,
      action: !ids.has(c.sha) ? "pick" : i === first ? "pick" : "squash",
      message: null,
    }));
    await runRebasePlan(onto, `parent of ${oldest.short_id}`, steps, { updateRefs: false, backup: false });
  } catch (err) {
    opFailed("Could not squash commits", err);
  }
}

// "Show Combined Diff": what a run of consecutive commits changed together,
// in the compare view. The selection goes first — two selected commits would
// otherwise re-compare themselves on the next refresh (newest against oldest,
// leaving out the oldest one's own changes).
async function showCombinedDiff(base: string, head: string, n: number): Promise<void> {
  await clearCommitSelection();
  setStatus(`Combining the changes of ${n} commits…`);
  await showComparison(base, head, false);
}

// "Compare with Working Directory": everything between `rev` and the files on
// disk, committed since or not — two-dot, like `git diff <rev>`. Shown in the
// History view's detail pane, the same way Compare with Current Branch is.
export async function compareWithWorkdirAction(rev: string, label: string): Promise<void> {
  if (state.view !== "history") showView("history", { refreshHistory: false });
  await clearCommitSelection();
  setStatus(`Comparing ${label} with the working directory…`);
  await showComparison(rev, WORKDIR_REV, false);
}

// "Restore File from This Commit": put `paths` back to how they are in `rev`,
// staged in Local Changes. Asks first when that overwrites local changes to
// any of them; Undo brings those back either way.
export async function restoreFilesAction(rev: string, paths: string[]): Promise<void> {
  const short = rev.slice(0, 7);
  const what = paths.length > 1 ? `${paths.length} files` : paths[0];
  try {
    const status = await fetchStatusSummary();
    const changed = new Set([...status.staged, ...status.unstaged].map((f) => f.path));
    const dirty = paths.filter((p) => changed.has(p));
    if (dirty.length) {
      const which = dirty.length === 1 ? `${dirty[0]} has` : `${dirty.length} of these files have`;
      if (!(await confirmDialog(`${which} local changes.\n\nReplace with the version from ${short}?`))) {
        setStatus("Restore cancelled.");
        return;
      }
    }
    setStatus(`Restoring ${what} from ${short}…`);
    await restoreFilesFromCommit(rev, paths);
    await loadSidebar(); // the Local Changes count and the Undo button
    reportDone(`Restored ${what} from ${short} — staged in Local Changes.`);
  } catch (err) {
    opFailed("Restore failed", err);
  }
}

// Cherry-pick every selected commit, oldest first. A conflict pauses the
// batch on the normal conflict resolver; finishing it resumes with whatever
// is left in `pendingCherryPicks`, aborting cancels the rest (see the
// conflictView onDone hook in init()).

async function cherryPickSelectedCommits(commits: CommitRow[]): Promise<void> {
  ui.pendingCherryPicks = commits;
  await runNextCherryPick();
}

export async function runNextCherryPick(): Promise<void> {
  const next = ui.pendingCherryPicks.shift();
  if (!next) return;
  setStatus(
    `Cherry-picking ${next.short_id}${ui.pendingCherryPicks.length ? ` (${ui.pendingCherryPicks.length} more queued)` : ""}…`,
  );
  try {
    const out = (await cherryPick(next.id)).trim();
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    if (ui.pendingCherryPicks.length) {
      reportDone(out || `Cherry-picked ${next.short_id}.`);
      await runNextCherryPick();
    } else {
      reportDone(out || `Cherry-picked ${next.short_id}.`);
    }
  } catch (err) {
    // A conflict leaves the cherry-pick in progress — hand off to the
    // resolver, which resumes (or cancels) the rest of the queue on its own.
    await Promise.all([refreshConflictStatus(), refreshRebaseStatus()]);
    if (state.conflict?.conflicted.length) {
      ui.pendingCherryPicksRepo = state.repoPath;
      showView("conflict");
      setStatus(`${next.short_id} conflicted — resolve it to continue the batch.`);
    } else {
      ui.pendingCherryPicks = [];
      opFailed("Cherry-pick failed", err);
    }
  }
}

// --- Commit right-click menu ------------------------------------------------

// Open the context menu for a right-clicked commit, wiring each item to the
// action that runs the git command and refreshes the view.
function onCommitBulkContextMenu(x: number, y: number): void {
  const commits = selectedCommitsOldestFirst();
  const n = commits.length;
  const combined = combinedDiffEnds(commits);
  const items: MenuItem[] = [
    ...(combined ? [{ label: "Show Combined Diff", run: () => void showCombinedDiff(combined.base, combined.head, n) }] : []),
    { label: `Cherry-pick ${n} Commits`, run: () => void cherryPickSelectedCommits(commits) },
    { label: `Copy ${n} SHAs`, run: () => void copySelectedShasAction(commits) },
    { separator: true },
    { label: `Squash ${n} Commits…`, run: () => void squashSelectedCommits(commits) },
    {
      label: `Drop ${n} Commits…`,
      danger: true,
      run: () =>
        void confirmThenRun(`Drop ${n} commits? This rewrites branch history.`, `Dropping ${n} commits`, async () => {
          await dropSelectedCommits(commits);
          return "";
        }),
    },
  ];
  showContextMenu(x, y, items);
}

export function onCommitContextMenu(row: CommitRow, x: number, y: number): void {
  // log.ts already collapsed the selection to just this row on right-click if
  // it wasn't part of it, so >1 here means the click landed inside a real
  // multi-selection.
  if (state.commitSelection.size > 1) {
    onCommitBulkContextMenu(x, y);
    return;
  }
  const rev = row.id;
  const short = row.short_id;
  showCommitMenu(x, y, row, {
    currentBranch: state.refs.head ?? "HEAD",
    copySha: () => void copySha(rev),
    compareWithWorkdir: () => void compareWithWorkdirAction(rev, short),
    checkoutCommit: () => void checkoutCommitAction(rev, short),
    newBranch: (name) => void runCommitOp(`Creating ${name}`, () => createBranchAt(name, rev), rev),
    newTag: (name) => void tagAction(name, rev, short),
    cherryPick: () => void runCommitOp(`Cherry-picking ${short}`, () => cherryPick(rev)),
    revert: () => void runCommitOp(`Reverting ${short}`, () => revertCommit(rev)),
    reset: (mode) => void resetAction(rev, short, mode),
    rebaseToHere: () => void rebaseToHere(row),
    rewordCommit: (message) => void quickRebase(row, "reword", message),
    editCommit: () => void quickRebase(row, "edit"),
    squashIntoParent: () => void quickRebase(row, "squash"),
    fixupIntoParent: () => void quickRebase(row, "fixup"),
    dropCommit: () =>
      void confirmThenRun(
        `Drop commit ${short}? This rewrites branch history.`,
        `Dropping ${short}`,
        async () => {
          await quickRebase(row, "drop");
          return "";
        },
      ),
    bisecting: state.bisect !== null,
    bisectMark: (mark) => void bisectStep(mark, rev),
    bisectStart: (mark, other) =>
      void startBisect(mark === "bad" ? rev : other, mark === "good" ? [rev] : [other]),
  });
}

// Start a bisect between a known bad and known good commits; git checks out
// the first commit to test.
export async function startBisect(bad: string, good: string[]): Promise<void> {
  await runBisectOp("Starting bisect", () => bisectStart(bad, good));
}

// Run a HEAD-moving commit op, then reload history + sidebar from the new HEAD.
// Shows git's own output on success (e.g. cherry-pick/revert summaries).
//
// `landRev`: for ops that move HEAD to a SPECIFIC, possibly historical commit
// (detached checkout, "create branch at" an old commit/tag) — select and
// scroll to that exact commit afterwards instead of the default "jump to the
// newest commit", which lands on the wrong row whenever the checked-out
// commit isn't the newest one in the log (e.g. checking out an old release
// tag). Ops that move the current branch's tip (commit/cherry-pick/revert/
// reset/rebase) omit it — their new HEAD genuinely is the newest commit.
export async function runCommitOp(label: string, op: () => Promise<string>, landRev?: string): Promise<void> {
  setStatus(`${label}…`);
  try {
    const out = (await op()).trim();
    showView("history");
    if (landRev) await Promise.all([landOnCommit(landRev), loadSidebar()]);
    else await Promise.all([refreshHistory(), loadSidebar()]);
    reportDone(out || `${label} done.`);
  } catch (err) {
    // A failed op (cherry-pick, revert, rebase, …) may have left a conflict
    // in progress — offer Resolve Conflicts instead of just the raw git
    // error, same as runBranchOp already does for a failed merge.
    await Promise.all([refreshConflictStatus(), refreshRebaseStatus()]);
    const inConflict =
      (state.conflict !== null && state.conflict.conflicted.length > 0) ||
      (state.rebase?.in_progress === true && state.rebase.paused_for === "conflict");
    opFailed(
      `${label} failed`,
      err,
      inConflict ? { label: "Resolve Conflicts", run: () => showView("conflict") } : undefined,
    );
  }
}

// Refresh the log, then select and scroll to `rev` — like clicking that
// commit would — instead of defaulting to the newest one. See runCommitOp's
// `landRev`.
async function landOnCommit(rev: string): Promise<void> {
  await refreshHistory();
  const idx = state.rows.findIndex((r) => r.id === rev);
  state.selectedId = rev;
  ui.logView = renderLog($("#log-pane"), state.rows, state.selectedId, selectCommit, loadMoreCommits, refLabelsAt, onCommitContextMenu, state.commitSelection, onCommitMultiSelect);
  if (idx >= 0) {
    const pane = $("#log-pane");
    pane.scrollTop = Math.max(0, idx * logRowHeight() - pane.clientHeight / 2);
  }
  await selectCommit(rev);
}

// Confirm first (destructive/history-rewriting ops), then run.
export async function confirmThenRun(
  question: string,
  label: string,
  op: () => Promise<string>,
): Promise<void> {
  if (!(await confirmDialog(question))) {
    setStatus(`${label} cancelled.`);
    return;
  }
  await runCommitOp(label, op);
}

// Detached checkout — warns first if the working tree has uncommitted changes,
// mirroring the branch checkout flow.
export async function checkoutCommitAction(rev: string, short: string): Promise<void> {
  if (state.localChanges > 0) {
    const n = state.localChanges;
    const ok = await confirmDialog(
      `You have ${n} uncommitted change${n === 1 ? "" : "s"}.\n\n` +
        `Check out ${short} (detached HEAD)? Conflicting changes will block it.`,
    );
    if (!ok) {
      setStatus("Checkout cancelled.");
      return;
    }
  }
  await runCommitOp(`Checking out ${short}`, () => checkoutCommit(rev), rev);
}

export async function resetAction(rev: string, short: string, mode: ResetMode): Promise<void> {
  const question =
    mode === "Hard"
      ? `Hard reset the current branch to ${short}?\n\n` +
        "Uncommitted changes and any commits after it on this branch will be lost."
      : `${mode} reset the current branch to ${short}?`;
  await confirmThenRun(question, `Resetting (${mode.toLowerCase()}) to ${short}`, () =>
    resetTo(rev, mode),
  );
}

// Tagging doesn't move HEAD, so it only refreshes the sidebar (to show the tag)
// and leaves the current view/scroll alone.
export async function tagAction(name: string, rev: string, short: string): Promise<void> {
  setStatus(`Tagging ${short} as ${name}…`);
  try {
    await createTagAt(name, rev);
    await loadSidebar();
    reportDone(`Tagged ${short} as ${name}`);
  } catch (err) {
    opFailed("Tag failed", err);
  }
}

export async function copySha(rev: string): Promise<void> {
  await copyText(rev, `Copied ${rev.slice(0, 10)} to clipboard`);
}

// --- Reflog entry menu ------------------------------------------------------

// Right-click (or ⋯) on a Reflog entry: the ways back to that commit. Each is
// the log menu's own action, so the confirmations and the undo recording are
// the same. A pruned commit can only have its id copied.
export function onReflogMenu(entry: ReflogEntry, x: number, y: number): void {
  const rev = entry.new_id;
  const short = entry.short_id;
  const copy: MenuItem = { label: "Copy SHA", run: () => void copySha(rev) };
  if (entry.summary === null) {
    showContextMenu(x, y, [copy]);
    return;
  }
  showContextMenu(x, y, [
    { label: "Checkout (detached)", run: () => void checkoutCommitAction(rev, short) },
    {
      label: "Create Branch Here…",
      prompt: {
        placeholder: "New branch name",
        onSubmit: (name) => void runCommitOp(`Creating ${name}`, () => createBranchAt(name, rev), rev),
      },
    },
    { separator: true },
    { label: "Reset to Here: Soft (keep changes staged)", run: () => void resetAction(rev, short, "Soft") },
    { label: "Reset to Here: Mixed (keep changes unstaged)", run: () => void resetAction(rev, short, "Mixed") },
    { label: "Reset to Here: Hard (discard changes)", danger: true, run: () => void resetAction(rev, short, "Hard") },
    { separator: true },
    copy,
  ]);
}
