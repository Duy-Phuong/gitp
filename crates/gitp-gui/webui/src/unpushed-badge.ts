// "↑3 unpushed on main" in the status bar: the default branch's commits its
// remote doesn't have yet, refreshed with the sidebar. A click pushes it.

import { pushBranch, unpushedDefault } from "./api";
import { state } from "./app-state";
import { $ } from "./dom";
import { unpushedLabel, unpushedTitle, type Unpushed } from "./quit-check";
import { runBranchOp } from "./ref-actions";
import { pushAction } from "./repo-actions";

let current: Unpushed | null = null;
let seq = 0;

export function setupUnpushedBadge(): void {
  $("#status-unpushed").addEventListener("click", () => {
    const u = current;
    if (!u) return;
    if (state.refs.head === u.branch) void pushAction();
    else void runBranchOp(`Pushing ${u.branch}`, () => pushBranch(u.branch), false, u.branch);
  });
}

export async function refreshUnpushed(): Promise<void> {
  const mine = ++seq;
  const u: Unpushed | null = state.repoPath ? await unpushedDefault().catch(() => null) : null;
  if (mine !== seq) return;
  current = u;
  const badge = $("#status-unpushed");
  badge.classList.toggle("hidden", !u);
  badge.textContent = u ? unpushedLabel(u) : "";
  badge.title = u ? unpushedTitle(u) : "";
}
