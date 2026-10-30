// Opening the Workspaces screen (views/workspaces.ts) and what it needs from
// the rest of the app: opening repos as tabs, and reloading the active repo
// after a bulk fetch or pull reached it.

import { openRepo } from "./api";
import { state } from "./app-state";
import { loadPullDefault } from "./prefs";
import { readFailed, setStatus } from "./report";
import { applyWorkspace, loadSidebar, refreshHistory, showView } from "./shell";
import type { PullMode } from "./types";
import { openWorkspacesDialog } from "./views/workspaces";

export function openWorkspacesAction(): void {
  openWorkspacesDialog({
    activeRepo: () => state.repoPath,
    openRepos,
    refreshActive: async () => {
      await Promise.all([refreshHistory({ keepSelection: true }), loadSidebar()]);
    },
    pullMode,
    setStatus,
  });
}

// The Pull button's method. Fetch All isn't a pull, so then it's plain
// `git pull`, which follows each repo's own pull.rebase / pull.ff.
function pullMode(): PullMode {
  const mode = loadPullDefault();
  return mode === "FetchAll" ? "FastForward" : mode;
}

// Open each as a tab (or switch to it if it already is one), then load the
// last one's history — once, rather than once per repo as loadRepo would.
async function openRepos(paths: string[]): Promise<void> {
  let opened = 0;
  for (const path of paths) {
    try {
      applyWorkspace(await openRepo(path));
      opened++;
    } catch (err) {
      readFailed(`Failed to open ${path}`, err);
    }
  }
  if (opened === 0) return;
  showView("history");
  await Promise.all([refreshHistory(), loadSidebar()]);
  setStatus(`Opened ${opened} ${opened === 1 ? "repository" : "repositories"} · ${state.total} commits in ${state.repoPath}`);
}
