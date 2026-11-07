// "CI ✓" in the status bar: the GitHub Actions runs of the checked-out
// branch's newest pushed commit (ci-status.ts). Read again every minute while
// gitp is in front, every 5 minutes behind (a failure then notifies), and at
// once when the repository or branch changes. A click opens the run.

import { branchCi, openGithubUrl } from "./api";
import { state } from "./app-state";
import { ciLabel, ciNote, ciTitle, type BranchCi } from "./ci-status";
import { $ } from "./dom";
import { notifyCi } from "./notifications";
import { startPolling } from "./poller";

const FRONT_MS = 60_000;
const BEHIND_MS = 5 * 60_000;

// The last answer, and for which repository and branch.
let current: { key: string; branch: string; ci: BranchCi } | null = null;
let seen = "";
let seq = 0;

export function setupCiBadge(): void {
  $("#status-ci").addEventListener("click", () => {
    if (current?.ci.url) void openGithubUrl(current.ci.url).catch(() => {});
  });
  startPolling("ci-status", FRONT_MS, refreshCi);
  setInterval(() => {
    if (!document.hasFocus()) void refreshCi();
  }, BEHIND_MS);
}

// After the sidebar or the pull requests load: read at once when the
// repository, its GitHub repository (known once the pull requests load) or
// the branch changed.
export function noticeBranchForCi(): void {
  const key = `${state.repoPath}\n${state.prs.repo ?? ""}\n${state.refs.head ?? ""}`;
  if (key === seen) return;
  seen = key;
  void refreshCi();
}

export async function refreshCi(): Promise<void> {
  const mine = ++seq;
  const branch = state.refs.head;
  const key = `${state.repoPath}\n${branch ?? ""}`;
  // Only a GitHub repository has Actions; a detached HEAD has no branch.
  const ci = state.repoPath && branch && state.prs.repo ? await branchCi(branch).catch(() => null) : null;
  if (mine !== seq) return;
  if (ci && branch) {
    const before = current?.key === key ? current.ci : null;
    const note = ciNote(before, ci, branch);
    if (note) notifyCi(note);
    current = { key, branch, ci };
  } else current = null;
  const badge = $("#status-ci");
  const label = current ? ciLabel(current.ci) : null;
  badge.classList.toggle("hidden", label === null);
  badge.textContent = label ?? "";
  badge.title = current && label ? ciTitle(current.ci, current.branch) : "";
  for (const s of ["success", "failure", "running"]) badge.classList.toggle(s, current?.ci.state === s);
}
