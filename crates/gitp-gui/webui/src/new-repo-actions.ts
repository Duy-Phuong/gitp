// Making a repository that isn't open yet — Init Repository, Clone Repository —
// and opening the result as a tab.

import { cloneRepository, initRepository } from "./api";
import { state } from "./app-state";
import { loadDefaultBranch } from "./prefs";
import type { CloneOptions } from "./types";
import { opFailed, reportDone, setStatus } from "./report";
import { loadRepo } from "./shell";
import { warmTerminal } from "./terminal-panel";
import { openCloneDialog, openInitDialog } from "./views/new-repo-dialog";

// New repositories usually go next to the ones already in use, so the dialogs
// start in the active repo's parent folder.
function besideActiveRepo(): string {
  return trimSlashes(state.repoPath).replace(/[^/]*$/, "");
}

// The tab is keyed by the path exactly as opened, so `/a/b/` and `/a/b` would
// be two different repos to the workspace.
function trimSlashes(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function initRepoAction(): void {
  setStatus("Initialize a repository…");
  openInitDialog(besideActiveRepo(), loadDefaultBranch(), (req) =>
    void runInit(trimSlashes(req.path), req.branch, req.gitignore, req.readme),
  );
}

async function runInit(path: string, branch: string | null, gitignore: string | null, readme: boolean): Promise<void> {
  setStatus(`Initializing ${path}…`);
  try {
    await initRepository(path, branch, gitignore, readme);
  } catch (err) {
    opFailed("Init failed", err);
    return;
  }
  await openCreated(path, `Initialized an empty repository in ${path}.`);
}

export function cloneRepoAction(): void {
  setStatus("Clone a repository…");
  openCloneDialog(besideActiveRepo(), (req) => void runClone(req.url, req.dest, req.options));
}

// The status ends in "…" and the call goes through invokeNetwork, so while git
// runs the status bar shows its progress and offers Cancel, as for a fetch.
async function runClone(url: string, dest: string, options: CloneOptions): Promise<void> {
  setStatus(`Cloning ${url}…`);
  try {
    await cloneRepository(url, dest, options);
  } catch (err) {
    opFailed("Clone failed", err);
    return;
  }
  await openCreated(dest, `Cloned ${url} into ${dest}.`);
}

// Open the repository just made as a tab. loadRepo reports its own failure, so
// success is only announced once the tab is really there.
async function openCreated(path: string, done: string): Promise<void> {
  await loadRepo(path);
  if (state.repoPath !== path) return;
  warmTerminal();
  reportDone(done);
}
