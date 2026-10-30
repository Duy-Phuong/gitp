// Whether a checkout would land on a branch another worktree has checked out.
// git allows a branch in only one worktree at a time and refuses the second
// checkout, so the checkout actions offer that worktree up front instead of
// first asking what to do with local changes.

import type { Worktree } from "./types";

// The other worktree that has local branch `branch` checked out, if any. One
// whose folder is gone doesn't count: there is nothing there to open.
export function otherWorktreeWith(branch: string, worktrees: Worktree[]): Worktree | undefined {
  return worktrees.find((w) => w.branch === branch && !w.is_current && !w.prunable);
}

// The local branch that checking out remote-tracking `ref` switches to — the
// name without its remote (`origin/feature/x` → `feature/x`), as gitp-core's
// checkout_remote picks it. `remotes` are the configured remotes' names.
export function localBranchForRemote(ref: string, remotes: string[]): string {
  const remote = remotes.find((r) => ref.startsWith(`${r}/`));
  return remote ? ref.slice(remote.length + 1) : ref.slice(ref.indexOf("/") + 1);
}
