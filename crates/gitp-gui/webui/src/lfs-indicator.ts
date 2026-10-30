// The status bar's "LFS" badge: shown only in a repository that stores files
// with Git LFS, flagged when git-lfs is missing or not set up — the two ways
// such a repository ends up with pointer files where its content should be.
// Clicking it opens the LFS menu (lfs-actions.ts).

import { $ } from "./dom";
import { state } from "./app-state";

export function lfsProblem(lfs: { installed: boolean; initialized: boolean }): string | null {
  if (!lfs.installed) return "Git LFS is not installed, so LFS files can't be downloaded.";
  if (!lfs.initialized) return "Git LFS is not set up here, so checkouts leave pointer files. Choose Initialize LFS.";
  return null;
}

export function renderLfsIndicator(): void {
  const slot = $("#status-lfs");
  const lfs = state.repoPath ? state.lfs : null;
  slot.classList.toggle("hidden", !lfs?.used);
  if (!lfs?.used) return;
  const problem = lfsProblem(lfs);
  slot.classList.toggle("warn", problem !== null);
  slot.textContent = !lfs.installed ? "LFS: not installed" : !lfs.initialized ? "LFS: not set up" : "LFS";
  slot.title = `${problem ?? "This repository stores large files with Git LFS."}\nTracked: ${lfs.patterns.join(", ")}`;
}
