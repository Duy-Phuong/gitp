// State shared across the app: the State record the views render from, and the
// long-lived view handles and toolbar flags.
//
// The handles live on one `ui` object rather than as separate `let`s because
// an imported binding can't be reassigned by the module that imports it.

import type { LogHandle } from "./views/log";
import type { DetailHandle } from "./views/detail";
import type { ChangesHandle } from "./views/changes";
import type { ConflictHandle } from "./views/conflict";
import type { ReflogHandle } from "./views/reflog";
import type { GraphPrefs } from "./prefs";
import type { ActivityHandle } from "./views/activity";
import type { PullRequestHandle } from "./views/pull-request";
import type { WelcomeHandle } from "./views/welcome";
import type { PrSectionState } from "./views/sidebar";
import type {
  BisectStatus,
  CommitRow,
  ConflictStatus,
  RebaseStatus,
  Refs,
  RemoteInfo,
  RepoTab,
  UndoState,
  Submodule,
  Worktree,
  WorktreeSummary,
  GitFlowConfig,
  LfsStatus,
} from "./types";

export type View = "history" | "changes" | "config" | "conflict" | "reflog" | "activity" | "pr";

export const EMPTY_REFS: Refs = { head: null, branches: [], remotes: [], tags: [], stashes: [], recent: [] };

// Commits loaded per page. The first page makes the repo openable instantly;
// more are appended as the user scrolls (see loadMoreCommits).
export const PAGE_SIZE = 1000;

interface State {
  repoPath: string;
  repos: RepoTab[];
  rows: CommitRow[];
  total: number;
  // HEAD's commit as of the last log page — where the graph's WIP row hangs.
  headId: string | null;
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
  // The active repo's graph settings: pinned branch, hidden and soloed refs.
  graph: GraphPrefs;
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
  // Each worktree's changed-file count and ahead/behind, fetched after the
  // rest of the sidebar (see refreshWorktreeSummaries).
  worktreeSummaries: WorktreeSummary[];
  // The repo's submodules, refreshed with the sidebar.
  submodules: Submodule[];
  // The repo's Git Flow settings (null: not initialised) and Git LFS status
  // (null: not known yet), refreshed with the sidebar.
  gitflow: GitFlowConfig | null;
  lfs: LfsStatus | null;
  // The repo's configured remotes, refreshed with the sidebar — including ones
  // never fetched, which have no remote branches in `refs` to show them by.
  remoteList: RemoteInfo[];
  // The sidebar's Pull Requests section (see pr-actions.ts).
  prs: PrSectionState;
}

export const state: State = {
  repoPath: "",
  repos: [],
  rows: [],
  total: 0,
  headId: null,
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
  graph: { pinned: null, hidden: [], solo: [] },
  commitSelection: new Set(),
  branchSelection: new Set(),
  branchSelectionAnchor: null,
  busyRefs: new Set(),
  worktrees: [],
  worktreeSummaries: [],
  submodules: [],
  gitflow: null,
  lfs: null,
  remoteList: [],
  prs: { repoPath: "", repo: null, account: null, filter: "all", list: null, loading: false, error: null, open: null, query: "" },
  rebase: null,
  conflict: null,
  bisect: null,
};

// The terminal panel (terminal-panel.ts): a strip of shell tabs per repo.
export interface TerminalPanel {
  // The tab on screen.
  fit: () => void;
  focus: () => void;
  clear: () => void;
  // Every tab, the ones in the background included.
  syncTheme: () => void;
  // Every tab too; the one on screen is refitted to the new cell size.
  syncFont: () => void;
  // Put `path`'s tabs on screen — the active repo changed.
  showRepo: (path: string) => void;
  // Kill `path`'s shells — its repo tab was closed.
  closeRepo: (path: string) => void;
}

export const ui = {
  terminal: null as TerminalPanel | null,
  detailView: null as DetailHandle | null,
  changesView: null as ChangesHandle | null,
  conflictView: null as ConflictHandle | null,
  reflogView: null as ReflogHandle | null,
  activityView: null as ActivityHandle | null,
  prView: null as PullRequestHandle | null,
  welcomeView: null as WelcomeHandle | null,
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
  // The repo an interactive cherry-pick plan paused in on a conflict (its
  // remaining steps are kept by the backend); "" when none is waiting.
  pickPlanRepo: "",
};
