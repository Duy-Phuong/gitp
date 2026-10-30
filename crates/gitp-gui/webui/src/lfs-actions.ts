// Git LFS: the status bar indicator's menu and the operations behind it —
// track / untrack a pattern, LFS fetch / pull, and Initialize. Without git-lfs
// installed each one fails with the backend's "Git LFS is not installed".

import { lfsFetch, lfsInstall, lfsPull, lfsTrack, lfsUntrack } from "./api";
import { showContextMenu, type MenuItem } from "./views/context-menu";
import { state } from "./app-state";
import { opFailed, reportDone, setStatus } from "./report";
import { loadSidebar } from "./shell";

// Click the status bar's LFS indicator.
export function onLfsMenu(x: number, y: number): void {
  const lfs = state.lfs;
  const items: MenuItem[] = [];
  if (lfs && !lfs.installed) items.push({ heading: "git-lfs is not installed" });
  items.push({
    label: "Track Pattern…",
    prompt: { placeholder: "Pattern, e.g. *.psd", onSubmit: (p) => void lfsTrackAction(p) },
  });
  if (lfs?.patterns.length) {
    items.push({
      label: "Untrack Pattern",
      submenu: lfs.patterns.map((p) => ({ label: p, run: () => void lfsUntrackAction(p) })),
    });
  }
  items.push(
    { separator: true },
    { label: "LFS Fetch", run: () => void lfsFetchAction() },
    { label: "LFS Pull", run: () => void lfsPullAction() },
    { separator: true },
    { label: "Initialize LFS", run: () => void lfsInstallAction() },
  );
  showContextMenu(x, y, items);
}

export function lfsTrackAction(pattern: string): Promise<void> {
  return runLfsOp(`Tracking ${pattern} with LFS`, () => lfsTrack(pattern));
}

export function lfsUntrackAction(pattern: string): Promise<void> {
  return runLfsOp(`Untracking ${pattern}`, () => lfsUntrack(pattern));
}

// Download the LFS objects the checked-out commit needs, without touching the
// working tree. A network operation: progress in the status bar, and Cancel.
export function lfsFetchAction(): Promise<void> {
  return runLfsOp("Fetching LFS objects", lfsFetch, "LFS objects are up to date.");
}

// Fetch, then replace the pointer files in the working tree with the content.
export function lfsPullAction(): Promise<void> {
  return runLfsOp("Pulling LFS objects", lfsPull, "LFS files are up to date.");
}

export function lfsInstallAction(): Promise<void> {
  return runLfsOp("Initializing LFS", lfsInstall);
}

// loadSidebar re-reads the LFS status, and hands Local Changes the edited
// .gitattributes or the files a pull replaced.
async function runLfsOp(label: string, op: () => Promise<string>, emptyNote?: string): Promise<void> {
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
