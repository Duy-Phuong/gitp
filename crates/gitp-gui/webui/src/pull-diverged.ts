// A pull that stopped because the branch and its remote both have commits the
// other lacks, with no pull.rebase or pull.ff set to say what to do: git's own
// words, as git 2.54 prints them.
export function isDivergedPull(message: string): boolean {
  return /reconcile divergent branches/i.test(message);
}

// What the failure dialog says above git's own text.
export const DIVERGED_PULL_HELP =
  "Your branch has commits its remote doesn't, and the remote has commits your branch doesn't. " +
  "Rebase puts your commits on top of the remote's; Merge joins the two with a merge commit.\n\n" +
  "To choose once for this repository: git config pull.rebase true (rebase) or false (merge).";
