// What Quick Launch (Cmd/Ctrl+K) offers: the commands, and the pickers for their
// targets. The palette itself is views/quick-launch.ts.

import {
  browseForRepo,
  cherryPick,
  createBranchAt,
  fastForwardBranch,
  fetchAndUpdateBranch,
  fetchBranch,
  fetchCommitTree,
  fetchRemote,
  fetchFileHistory,
  mergeBranch,
  pushBranch,
  rebaseOnto,
  revertCommit,
  setUpstream,
  unsetUpstream,
  applyStash,
  renameStash,
  revealPath,
} from "./api";
import { showContextMenu } from "./views/context-menu";
import { openStashApplyModal } from "./views/stash-apply";
import { openFetchDialog } from "./views/fetch-dialog";
import {
  closeQuickLaunch,
  isQuickLaunchOpen,
  showQuickLaunch,
  type QuickItem,
  type QuickStage,
} from "./views/quick-launch";
import type { BranchRef, ResetMode, StashRef, WorktreeTarget } from "./types";
import { state, ui } from "./app-state";
import { cancelNetworkAction, canCancelNetwork, readFailed, setStatus } from "./report";
import { forgetRecentRepo, loadRecentRepos, PULL_DEFAULT_LABEL, PULL_DEFAULTS } from "./prefs";
import { bisectStep, closeRepoTab, loadRepo, selectCommit, showReflog, showView, switchRepo } from "./shell";
import {
  applyPatchAction,
  cleanUpAction,
  createBranchAction,
  popAction,
  pushAction,
  pushForceAction,
  redoAction,
  refreshAllAction,
  runPullMethod,
  stageAllAction,
  stashAction,
  undoAction,
  unstageAllAction,
} from "./repo-actions";
import {
  checkoutBranchAction,
  checkoutRemoteAction,
  compareRefsAction,
  createPullRequestAction,
  deleteBranchAction,
  deleteStashAction,
  renameBranchAction,
  runBranchOp,
  runStashOp,
  saveStashPatchAction,
} from "./ref-actions";
import {
  checkoutCommitAction,
  confirmThenRun,
  copySha,
  openInteractiveRebase,
  quickRebase,
  rebaseToHere,
  resetAction,
  runCommitOp,
  startBisect,
  tagAction,
} from "./commit-actions";
import { toggleTerminal } from "./terminal-panel";
import { addWorktreeAction, defaultWorktreePath, pruneWorktreesAction, worktreeOf } from "./worktree-actions";
import { syncSubmodulesAction, updateSubmodulesAction } from "./submodule-actions";

// --- Quick Launch -----------------------------------------------------------

// Everything gitp can do, reachable from one keystroke.
//
// Commands come in three shapes. Most just `run`. Ones that need a target set
// `next`, which returns a second stage whose list is the picker for it (a
// branch, a stash, a file) — see quick-launch.ts. A few open an existing
// dialog, which is simply what their `run` does.
//
// Anything requiring an open repository is left out when none is, rather than
// listed and failing on Enter.

export function openQuickLaunch(): void {
  if (isQuickLaunchOpen()) return closeQuickLaunch();
  showQuickLaunch({
    placeholder: state.repoPath ? "Command" : "Open a repository",
    sections: [
      { title: "Recent Repositories", items: recentRepoItems() },
      { title: "Commands", items: state.repoPath ? repoCommands() : openOnlyCommands() },
    ],
  });
}

// `~/…` rather than the absolute path, the way every git client shows it.
//
// Matched structurally rather than against a known home directory, which the
// webview has no way to ask for; a path under some *other* user's home would be
// shortened too, but that only ever affects how it reads, never where it opens.
function tildePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+\//, "~/");
}

function recentRepoItems(opts: { skipActive?: boolean } = {}): QuickItem[] {
  return loadRecentRepos()
    .filter((path) => !(opts.skipActive && path === state.repoPath))
    .map((path) => ({
      kind: "repo" as const,
      label: path.split("/").filter(Boolean).pop() ?? path,
      detail: tildePath(path),
      run: () => void openRecentRepo(path),
    }));
}

async function openRecentRepo(path: string): Promise<void> {
  if (path === state.repoPath) {
    setStatus(`Already in ${path}.`);
    return;
  }
  // Already a tab: switch rather than reopening, which would be a no-op that
  // silently skips loading the log.
  if (state.repos.some((r) => r.path === path)) {
    await switchRepo(path);
    return;
  }
  try {
    await loadRepo(path);
  } catch {
    // loadRepo reports its own failure; drop the entry so a repo that has been
    // moved or deleted stops being offered.
    forgetRecentRepo(path);
  }
}

function openOnlyCommands(): QuickItem[] {
  return [
    { kind: "command", label: "Open Repository…", run: () => void browseAndOpen() },
    { kind: "command", label: "Terminal", run: toggleTerminal },
  ];
}

async function browseAndOpen(): Promise<void> {
  const path = await browseForRepo();
  if (path) await loadRepo(path);
}

// The branches, stashes and files a target picker offers, as palette items.
function branchStage(chip: string, onPick: (b: BranchRef) => void, skipHead = false): QuickStage {
  return {
    chip,
    placeholder: "branch",
    emptyNote: skipHead
      ? "No other local branches — this repository has only the one you're on."
      : "This repository has no local branches.",
    sections: [
      {
        title: "Local Branches",
        items: state.refs.branches
          .filter((b) => !(skipHead && b.is_head))
          .map((b) => ({
            kind: "branch" as const,
            label: b.name,
            detail: b.is_head ? "current" : undefined,
            run: () => onPick(b),
          })),
      },
    ],
  };
}

// Every file tracked at the selected commit (or HEAD) — the whole repository,
// not just what the current commit happens to touch.
async function fileStage(chip: string, mode: "blame" | "history"): Promise<QuickStage> {
  const paths = await fetchCommitTree(fileRev());
  return {
    chip,
    placeholder: "file",
    emptyNote: "This commit has no tracked files.",
    sections: [
      {
        title: "Files",
        items: paths.map((path) => ({
          kind: "file" as const,
          // Filename first, directory as the dimmed detail — a palette is
          // searched by name, and full paths would push every name off-screen.
          label: path.split("/").pop() ?? path,
          detail: path,
          run: () => void openFileIn(path, mode),
        })),
      },
    ],
  };
}

function fileRev(): string {
  return state.selectedId ?? "HEAD";
}

// Show `path` in Blame or History view.
//
// Those views live in the detail pane, which renders a file of the *selected
// commit* — so we first jump to the newest commit that touched this path. That
// isn't a workaround so much as the right answer: "blame this file" means as of
// its last change, not as of whichever commit happened to be selected.
async function openFileIn(path: string, mode: "blame" | "history"): Promise<void> {
  const label = mode === "blame" ? "Blame" : "History";
  setStatus(`Loading ${label.toLowerCase()} of ${path}…`);
  try {
    const history = await fetchFileHistory(fileRev(), path);
    const newest = history[0]?.id;
    if (!newest) {
      setStatus(`No commit reachable from here touches ${path}.`);
      return;
    }
    if (state.view !== "history") showView("history");
    await selectCommit(newest);
    if (ui.detailView?.openFile(path, mode)) setStatus(`${label} of ${path} @ ${newest.slice(0, 7)}`);
    else setStatus(`${path} isn't part of ${newest.slice(0, 7)} — nothing to show.`);
  } catch (err) {
    readFailed(`${label} of ${path} failed`, err);
  }
}

function repoCommands(): QuickItem[] {
  const head = state.refs.head;
  const items: QuickItem[] = [
    {
      kind: "command",
      label: "Blame…",
      next: () => fileStage("Blame", "blame"),
    },
    {
      kind: "command",
      label: "Checkout Branch",
      next: () => branchStage("Checkout Branch", (b) => void checkoutBranchAction(b), true),
    },
    {
      kind: "command",
      label: "Compare…",
      next: () =>
        refStage("Compare", (base) => ({
          next: () => refStage(`Compare ${base} with`, (head) => ({ run: () => void compareRefsAction(base, head) })),
        })),
    },
    {
      kind: "command",
      label: "Create Branch…",
      run: () => promptFor("New branch name", (name) => void createBranchAction(name)),
    },
    {
      kind: "command",
      label: "Create Pull Request on 'origin'",
      next: () => branchStage("Create Pull Request", (b) => void createPullRequestAction(b)),
    },
    {
      kind: "command",
      label: "Create Tag…",
      run: () =>
        promptFor("New tag name", (name) => {
          // Tag the selected commit, or the branch tip when nothing is selected
          // (opening the palette straight after launch, say).
          const rev = state.selectedId ?? headTarget();
          if (!rev) return setStatus("Nothing to tag — no commit is selected.");
          void tagAction(name, rev, rev.slice(0, 7));
        }),
    },
    {
      kind: "command",
      label: "Delete Branch…",
      next: () =>
        branchStage("Delete Branch", (b) => {
          setStatus(`Delete ${b.name}…`);
          deleteBranchAction(b);
        }, true),
    },
    {
      kind: "command",
      label: "Fast-forward",
      next: () =>
        branchStage("Fast-forward", (b) =>
          void runBranchOp(`Fast-forwarding ${b.name}`, () => fastForwardBranch(b.name), true, b.name),
        ),
    },
    { kind: "command", label: "Fetch…", run: openFetchOptions },
    {
      kind: "command",
      label: "File History…",
      next: () => fileStage("File History", "history"),
    },
    { kind: "command", label: "Local Changes", run: () => showView("changes") },
    { kind: "command", label: "Log (All Commits)", run: () => showView("history") },
    {
      kind: "command",
      label: "Pull…",
      next: () => pullStage(),
    },
    { kind: "command", label: "Push", run: () => void pushAction() },
    { kind: "command", label: "Push (force-with-lease)", run: () => void pushForceAction() },
    {
      kind: "command",
      label: "Rebase…",
      next: () =>
        branchStage("Rebase onto", (b) =>
          void confirmThenRun(
            `Rebase ${head} onto ${b.name}? This rewrites commits on ${head}.`,
            `Rebasing ${head} onto ${b.name}`,
            () => rebaseOnto(b.name),
          ),
        true),
    },
    {
      kind: "command",
      label: "Rebase Interactively…",
      next: () => branchStage("Interactive Rebase onto", (b) => void openInteractiveRebase(b.name, b.name), true),
    },
    ...bisectCommands(),
    { kind: "command", label: "Clean up (prune remotes, delete gone branches)", run: () => void cleanUpAction() },
    { kind: "command", label: "Refresh (fetch all remotes)", run: () => void refreshAllAction() },
    {
      kind: "command",
      label: "Rename Branch…",
      next: () =>
        branchStage("Rename Branch", (b) => {
          setStatus(`Rename ${b.name}…`);
          renameBranchAction(b);
        }),
    },
    { kind: "command", label: "Repository Settings…", run: () => showView("config") },
    { kind: "command", label: "Reveal in Finder", run: () => void revealRepo() },
    { kind: "command", label: "Save Stash", run: () => void stashAction() },
    { kind: "command", label: "Show Reflog", run: () => showReflog() },
    { kind: "command", label: "Switch Repository", next: () => repoStage() },
    { kind: "command", label: "Open Repository…", run: () => void browseAndOpen() },
    { kind: "command", label: "Close Repository", run: () => void closeRepoTab(state.repoPath) },
    { kind: "command", label: "Terminal", run: toggleTerminal },
    {
      kind: "command",
      label: "Checkout Remote Branch",
      next: () => remoteStage(),
      },
    {
      kind: "command",
      label: "Fetch Branch…",
      next: () =>
        branchStage("Fetch Branch", (b) =>
          void runBranchOp(`Fetching updates for ${b.name}`, () => fetchBranch(b.name), false, b.name),
        ),
    },
    {
      kind: "command",
      label: "Fetch and Update Branch…",
      next: () =>
        branchStage("Fetch and Update", (b) =>
          void runBranchOp(`Fetching and updating ${b.name}`, () => fetchAndUpdateBranch(b.name), true, b.name),
        ),
    },
    {
      kind: "command",
      label: "Push Branch…",
      next: () =>
        branchStage("Push Branch", (b) =>
          void runBranchOp(`Pushing ${b.name}`, () => pushBranch(b.name), false, b.name),
        ),
    },
    {
      kind: "command",
      label: "Set Upstream…",
      next: () =>
        branchStage("Set Upstream of", (b) =>
          promptFor("Upstream (e.g. origin/main)", (up) =>
            void runBranchOp(`Setting upstream of ${b.name}`, () => setUpstream(b.name, up), false, b.name),
          ),
        ),
    },
    {
      kind: "command",
      label: "Unset Upstream…",
      next: () =>
        branchStage("Unset Upstream of", (b) =>
          void runBranchOp(`Unsetting upstream of ${b.name}`, () => unsetUpstream(b.name), false, b.name),
        ),
    },
    { kind: "command", label: "Add Worktree…", next: () => addWorktreeStage() },
    { kind: "command", label: "Prune Worktrees", run: () => void pruneWorktreesAction() },
    { kind: "command", label: "Apply Patch…", run: () => void applyPatchAction() },
    { kind: "command", label: "Stage All Changes", run: () => void stageAllAction() },
    { kind: "command", label: "Unstage All Changes", run: () => void unstageAllAction() },
    ...commitCommands(),
  ];

  if (!head) {
    // Detached HEAD: merging and rebasing "into the current branch" has no
    // meaning to offer.
    return items.filter((i) => !i.label.startsWith("Rebase") && !i.label.startsWith("Merge"));
  }
  items.push({
    kind: "command",
    label: `Merge into ${head}`,
    next: () =>
      branchStage(`Merge into ${head}`, (b) =>
        void runBranchOp(`Merging ${b.name} into ${head}`, () => mergeBranch(b.name), true, b.name),
      true),
  });
  if (state.refs.stashes.length) {
    items.push(
      { kind: "command", label: "Apply Stash…", next: () => stashStage("Apply Stash", applyStashPicked) },
      { kind: "command", label: "Pop Stash", run: () => void popAction() },
      {
        kind: "command",
        label: "Drop Stash…",
        next: () =>
          stashStage("Drop Stash", (st) => {
            setStatus(`Drop stash@{${st.index}}…`);
            void deleteStashAction(st);
          }),
      },
      {
        kind: "command",
        label: "Rename Stash…",
        next: () =>
          stashStage("Rename Stash", (st) =>
            promptFor("Stash message", (message) =>
              void runStashOp(`Renaming stash@{${st.index}}`, () => renameStash(st.index, message)),
            ),
          ),
      },
      {
        kind: "command",
        label: "Save Stash as Patch…",
        next: () =>
          stashStage("Save as Patch", (st) => {
            setStatus(`Save stash@{${st.index}} as a patch…`);
            void saveStashPatchAction(st);
          }),
      },
    );
  }
  if (state.submodules.length) {
    items.push(
      { kind: "command", label: "Update All Submodules", run: () => void updateSubmodulesAction(null) },
      { kind: "command", label: "Sync Submodule URLs", run: () => void syncSubmodulesAction(null) },
    );
  }
  if (ui.undoLabels.undo) items.push({ kind: "command", label: `Undo ${ui.undoLabels.undo}`, run: () => void undoAction() });
  if (ui.undoLabels.redo) items.push({ kind: "command", label: `Redo ${ui.undoLabels.redo}`, run: () => void redoAction() });
  if (canCancelNetwork()) items.push({ kind: "command", label: "Cancel Fetch / Pull / Push", run: cancelNetworkAction });
  items.sort((a, b) => a.label.localeCompare(b.label));
  return items;
}

// `open_in_editor`/`reveal` succeed or fail entirely in the OS, so without a
// status line a failed reveal is indistinguishable from a dead menu entry.
async function revealRepo(): Promise<void> {
  try {
    await revealPath(state.repoPath);
    setStatus(`Revealed ${state.repoPath}`);
  } catch (err) {
    readFailed("Couldn't reveal the repository", err);
  }
}

function headTarget(): string | null {
  return state.refs.branches.find((b) => b.is_head)?.target ?? null;
}

// Every branch, remote branch and tag, for picking a ref to compare. `pick`
// says what choosing one does: run, or push the next stage.
function refStage(chip: string, pick: (rev: string) => Pick<QuickItem, "run" | "next">): QuickStage {
  const section = (title: string, names: string[]) => ({
    title,
    items: names.map((name) => ({ kind: "branch" as const, label: name, ...pick(name) })),
  });
  return {
    chip,
    placeholder: "branch or tag",
    emptyNote: "This repository has no branches or tags.",
    sections: [
      section("Local Branches", state.refs.branches.map((b) => b.name)),
      section("Remote Branches", state.refs.remotes.map((r) => r.name)),
      section("Tags", state.refs.tags.map((t) => t.name)),
    ],
  };
}

function repoStage(): QuickStage {
  return {
    chip: "Switch Repository",
    placeholder: "repository",
    emptyNote: "No other repositories opened yet.",
    // Offering the repo you're already in would be a row that does nothing.
    sections: [{ title: "Recent Repositories", items: recentRepoItems({ skipActive: true }) }],
  };
}

function stashStage(chip: string, onPick: (stash: StashRef) => void): QuickStage {
  return {
    chip,
    placeholder: "stash",
    emptyNote: "This repository has no stashes.",
    sections: [
      {
        title: "Stashes",
        items: state.refs.stashes.map((st) => ({
          kind: "option" as const,
          label: st.message,
          detail: `stash@{${st.index}}`,
          run: () => onPick(st),
        })),
      },
    ],
  };
}

// The same apply/pop choice the stash context menu offers.
//
// Commands that open a dialog say so in the status bar first. Without it a
// dialog that fails to appear for any reason is indistinguishable from a
// command that never ran, which leaves nothing to report but "it did nothing".
function applyStashPicked(st: StashRef): void {
  setStatus(`Apply stash@{${st.index}}…`);
  openStashApplyModal(st, (drop) => {
    const verb = drop ? "Popping" : "Applying";
    void runStashOp(`${verb} stash@{${st.index}}`, () => applyStash(st.index, drop));
  });
}

// What a new worktree checks out: a new branch from HEAD, or a local branch no
// worktree has checked out yet (git refuses the others). Then where it goes.
function addWorktreeStage(): QuickStage {
  const askPath = (branch: string, target: WorktreeTarget) =>
    promptFor("Folder for the new worktree", (path) => void addWorktreeAction(path, target), defaultWorktreePath(branch));
  return {
    chip: "Add Worktree",
    placeholder: "branch",
    sections: [
      {
        title: "New Branch",
        items: [
          {
            kind: "option",
            label: "New Branch from HEAD…",
            run: () =>
              promptFor("New branch name", (name) => askPath(name, { kind: "new_branch", name, start: "HEAD" })),
          },
        ],
      },
      {
        title: "Local Branches",
        items: state.refs.branches
          .filter((b) => !b.is_head && !worktreeOf(b.name))
          .map((b) => ({
            kind: "branch" as const,
            label: b.name,
            run: () => askPath(b.name, { kind: "branch", name: b.name }),
          })),
      },
    ],
  };
}

function remoteStage(): QuickStage {
  return {
    chip: "Checkout Remote Branch",
    placeholder: "remote branch",
    emptyNote: "No remote-tracking branches — fetch a remote first.",
    sections: [
      {
        title: "Remote Branches",
        items: state.refs.remotes.map((r) => ({
          kind: "branch" as const,
          label: r.name,
          run: () => void checkoutRemoteAction(r.name),
        })),
      },
    ],
  };
}

// Operations on the commit the log has selected. Its short SHA goes in every
// label: these rewrite or move history, and "Revert" with no indication of
// *what* is being reverted is the kind of ambiguity a palette must not have.
function commitCommands(): QuickItem[] {
  const rev = state.selectedId;
  if (!rev) return [];
  const row = state.rows.find((r) => r.id === rev);
  const short = row?.short_id ?? rev.slice(0, 7);
  const items: QuickItem[] = [
    { kind: "command", label: `Copy SHA of ${short}`, run: () => void copySha(rev) },
    { kind: "command", label: `Checkout Commit ${short}`, run: () => void checkoutCommitAction(rev, short) },
    {
      kind: "command",
      label: `Cherry-pick ${short}`,
      run: () => void runCommitOp(`Cherry-picking ${short}`, () => cherryPick(rev)),
    },
    {
      kind: "command",
      label: `Revert ${short}`,
      run: () => void runCommitOp(`Reverting ${short}`, () => revertCommit(rev)),
    },
    { kind: "command", label: `Reset to ${short}…`, next: () => resetStage(rev, short) },
    {
      kind: "command",
      label: `New Branch at ${short}…`,
      run: () =>
        promptFor("New branch name", (name) =>
          void runCommitOp(`Creating ${name}`, () => createBranchAt(name, rev), rev),
        ),
    },
  ];
  // The interactive-rebase shortcuts need the full row (they replay the range
  // from this commit), so they're only offered for a commit in the loaded log.
  if (row) {
    items.push(
      {
        kind: "command",
        label: `Reword ${short}…`,
        run: () => promptFor("New commit message", (message) => void quickRebase(row, "reword", message)),
      },
      { kind: "command", label: `Edit ${short}`, run: () => void quickRebase(row, "edit") },
      { kind: "command", label: `Squash ${short} into Parent`, run: () => void quickRebase(row, "squash") },
      { kind: "command", label: `Fixup ${short} into Parent`, run: () => void quickRebase(row, "fixup") },
      {
        kind: "command",
        label: `Drop Commit ${short}`,
        run: () =>
          void confirmThenRun(
            `Drop commit ${short}? This rewrites branch history.`,
            `Dropping ${short}`,
            async () => {
              await quickRebase(row, "drop");
              return "";
            },
          ),
      },
      { kind: "command", label: `Rebase to ${short}`, run: () => void rebaseToHere(row) },
    );
  }
  return items;
}

// While bisecting: the banner's Good / Bad / Skip / Reset. Otherwise: start a
// bisect, asking for the bad end (HEAD by default) and then the good one (the
// selected commit by default, when that isn't HEAD itself).
function bisectCommands(): QuickItem[] {
  if (state.bisect) {
    return [
      { kind: "command", label: "Bisect: Mark Good", run: () => void bisectStep("good") },
      { kind: "command", label: "Bisect: Mark Bad", run: () => void bisectStep("bad") },
      { kind: "command", label: "Bisect: Skip", run: () => void bisectStep("skip") },
      { kind: "command", label: "Bisect: Reset", run: () => void bisectStep("reset") },
    ];
  }
  const selected = state.selectedId && state.selectedId !== headTarget() ? state.selectedId : "";
  return [
    {
      kind: "command",
      label: "Start Bisect…",
      run: () =>
        promptFor(
          "Bad commit (where the bug shows)",
          (bad) =>
            promptFor("Good commit (from before the bug)", (good) => void startBisect(bad, [good]), selected.slice(0, 10)),
          "HEAD",
        ),
    },
  ];
}

function resetStage(rev: string, short: string): QuickStage {
  const modes: [ResetMode, string][] = [
    ["Soft", "Soft — keep the working tree and the index"],
    ["Mixed", "Mixed — keep the working tree, reset the index"],
    ["Hard", "Hard — discard all local changes"],
  ];
  return {
    chip: `Reset to ${short}`,
    placeholder: "mode",
    sections: [
      {
        title: "Modes",
        items: modes.map(([mode, label]) => ({
          kind: "option" as const,
          label,
          run: () => void resetAction(rev, short, mode),
        })),
      },
    ],
  };
}

function pullStage(): QuickStage {
  return {
    chip: "Pull",
    placeholder: "method",
    sections: [
      {
        // The same four methods the Pull button's caret menu offers, named the
        // same way, so the palette can't drift from it.
        title: "Methods",
        items: PULL_DEFAULTS.map((mode) => ({
          kind: "option" as const,
          label: PULL_DEFAULT_LABEL[mode],
          run: () => void runPullMethod(mode),
        })),
      },
    ],
  };
}

function openFetchOptions(): void {
  setStatus("Choose what to fetch…");
  // Remote *names* aren't a field of their own — derive them from the
  // remote-tracking branches the sidebar already has.
  const names = [...new Set(state.refs.remotes.map((r) => r.remote))].sort();
  openFetchDialog(names, (remote) => {
    if (remote === null) void refreshAllAction();
    else void runBranchOp(`Fetching ${remote}`, () => fetchRemote(remote), true, remote);
  });
}

// A one-field prompt, reusing the context menu's inline input at the centre of
// the window so a palette command that needs a name doesn't need its own modal.
function promptFor(placeholder: string, onSubmit: (value: string) => void, value?: string): void {
  showContextMenu(window.innerWidth / 2 - 120, window.innerHeight / 3, [
    { label: placeholder, prompt: { placeholder, value, onSubmit } },
  ]);
}
