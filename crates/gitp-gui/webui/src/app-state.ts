// State shared across the app: the State record the views render from, and the
// long-lived view handles and toolbar flags.
//
// The handles live on one `ui` object rather than as separate `let`s because
// an imported binding can't be reassigned by the module that imports it.

import type { LogHandle } from "./views/log";
import type { DetailHandle } from "./views/detail";
import type { ChangesHandle } from "./views/changes";
import type { ConflictHandle } from "./views/conflict";
import type { TerminalHandle } from "./views/terminal";
import type { ReflogHandle } from "./views/reflog";
import type { BisectStatus, CommitRow, ConflictStatus, RebaseStatus, Refs, RepoTab, UndoState, Worktree } from "./types";

export type View = "history" | "changes" | "config" | "conflict" | "reflog";

export const EMPTY_REFS: Refs = { head: null, branches: [], remotes: [], tags: [], stashes: [], recent: [] };

// Commits loaded per page. The first page makes the repo openable instantly;
// more are appended as the user scrolls (see loadMoreCommits).
export const PAGE_SIZE = 1000;

interface State {
  repoPath: string;
  repos: RepoTab[];
  rows: CommitRow[];
  total: number;
  selectedId: string | null;
  view: View;
  refs: Refs;
  localChanges: number;
  sbFilter: string;
  sbCollapsed: Set<string>;
  rebase: RebaseStatus | null;
  conflict: ConflictStatus | null;
  bisect: BisectStatus | null;
  // History graph shows all branches (true) or just the current branch (false).
  allBranches: boolean;
  // Cmd/Shift-click multi-selection, for bulk actions — see log.ts / sidebar.ts.
  // Separate from `selectedId` (the one commit the detail pane follows).
  commitSelection: Set<string>;
  // Local-branch names only; bulk actions (delete) don't apply to remotes/tags.
  branchSelection: Set<string>;
  // The last plain/Cmd-clicked branch — the Shift-click range anchor.
  branchSelectionAnchor: string | null;
  // Refs with an operation in flight — see withBusyRef.
  busyRefs: Set<string>;
  // The repo's worktrees (main first), refreshed with the sidebar.
  worktrees: Worktree[];
}

export const state: State = {
  repoPath: "",
  repos: [],
  rows: [],
  total: 0,
  selectedId: null,
  view: "history",
  refs: EMPTY_REFS,
  localChanges: 0,
  sbFilter: "",
  // Recent starts collapsed — it's a quick-switch shortcut, not the primary list.
  // Tags and Remotes too: on a real repo they're the two largest sections by far
  // (hundreds of rows each), and expanding them is a deliberate act, not the
  // default view. Keeping them shut is what makes the first paint cheap.
  sbCollapsed: new Set(["sec:recent", "sec:remotes", "sec:tags"]),
  allBranches: true,
  commitSelection: new Set(),
  branchSelection: new Set(),
  branchSelectionAnchor: null,
  busyRefs: new Set(),
  worktrees: [],
  rebase: null,
  conflict: null,
  bisect: null,
};

export const ui = {
  terminal: null as TerminalHandle | null,
  detailView: null as DetailHandle | null,
  changesView: null as ChangesHandle | null,
  conflictView: null as ConflictHandle | null,
  reflogView: null as ReflogHandle | null,
  // The live log's handle, from the most recent renderLog — the log view owns
  // keyboard movement through the rows it has on screen (see LogHandle).
  logView: null as LogHandle | null,
  actionsBusy: false,
  // Labels of the actions Undo/Redo would perform, mirrored from the backend so
  // the buttons enable/disable and show what they'd do.
  undoLabels: { undo: null, redo: null } as UndoState,
  // Commits a batch cherry-pick still has to apply (see commit-actions.ts).
  pendingCherryPicks: [] as CommitRow[],
  // The repo a conflicted batch paused in — the resolver's onDone resumes only
  // a batch that belongs to the repo and session that just finished.
  pendingCherryPicksRepo: "",
};
