import "./styles.css";
import {
  browseForRepo,
  commitChanges,
  confirmDialog,
  discardHunk,
  discardLines,
  fetchBlame,
  fetchCommitDetail,
  fetchCommitFileDiff,
  fetchCommitTree,
  fetchCompareFileDiff,
  fetchFileHistory,
  fetchFileContent,
  fetchFileDiff,
  fetchStatusSummary,
  fetchReflog,
  fetchActivityLog,
  clearActivityLog,
  isTauri,
  listRepos,
  stage,
  stageAll,
  stageHunk,
  stageLines,
  conflictStatus,
  conflictSides,
  resolveConflict,
  resolveConflictSide,
  abortConflict,
  finishConflict,
  discardFiles,
  stashFiles,
  saveFilesPatch,
  addToGitignore,
  untrackFiles,
  revealPath,
  openInEditor,
  deleteFile,
  unstage,
  unstageAll,
  unstageHunk,
  unstageLines,
  fetchCommitSignature,
  fetchSigningConfig,
  fetchCommitTemplate,
  createBranchAt,
} from "./api";
import { $ } from "./dom";
import { setupDetail } from "./views/detail";
import { setAuthorFilter, setOnGhostCheckout, setOnMoreRefs, setOnOpenWip, setStashHandlers } from "./views/log";
import { showContextMenu, type MenuItem } from "./views/context-menu";
import { authorsOf, authorTerm, withAuthorTerm } from "./log-columns";
import { setupBranchHover } from "./branch-hover";
import { setupChanges } from "./views/changes";
import { setupConflict } from "./views/conflict";
import { setupReflog } from "./views/reflog";
import { setupActivity } from "./views/activity";
import { copyText } from "./clipboard";
import { state, ui, type View } from "./app-state";
import { opFailed, readFailed, reportDone, setStatus, watchNetwork, watchPending } from "./report";
import { setupFetchAgeIndicator } from "./fetch-age";
import { onLfsMenu } from "./lfs-actions";
import {
  applyCodePrefs,
  applyTheme,
  applyZoom,
  currentTheme,
  loadAllBranches,
  loadAutoFetchMinutes,
  loadDetailTab,
  loadPushAfterCommit,
  loadZoom,
  saveAllBranches,
  saveDetailTab,
  savePushAfterCommit,
  updatePullButtonTitle,
} from "./prefs";
import { refsAt } from "./commit-refs";
import { setupConfigTabs } from "./config-panel";
import { setupPaneResizer, setupSidebarResizer, setupTerminalResizer } from "./resizers";
import {
  applyWorkspace,
  jumpToCommit,
  leaveComparison,
  loadRepo,
  loadSidebar,
  refreshHistory,
  refreshUndoLabels,
  refreshWipRow,
  renderSidebarNow,
  restoreWorkspace,
  setRefActions,
  showReflogDetail,
  showStashDetail,
  showView,
  startAutoFetch,
  updateLogView,
} from "./shell";
import {
  popAction,
  pushAction,
  redoAction,
  refreshAllAction,
  runPullDefault,
  openStashDialogAction,
  undoAction,
} from "./repo-actions";
import {
  checkoutBranchAction,
  onBranchBulkMenu,
  onBranchMenu,
  onRemoteMenu,
  onStashMenu,
  onMoreRefsMenu,
  onRefDrop,
  onSectionMenu,
  onTagMenu,
} from "./ref-actions";
import { setOnRefDrop } from "./views/ref-drag";
import {
  onCommitContextMenu,
  onReflogMenu,
  restoreFilesAction,
  revertHunkAction,
  runCommitOp,
  resumeCherryPickPlan,
  runNextCherryPick,
} from "./commit-actions";
import { onWorktreeDrop, onWorktreeMenu } from "./worktree-actions";
import { addRemoteAction, onRemoteFolderMenu, onRemotesMenu } from "./remote-actions";
import { addSubmoduleAction, onSubmoduleMenu, openSubmodule } from "./submodule-actions";
import { createFileAction, editFileAction } from "./editor-actions";
import { setupTerminalPanel, toggleTerminal, warmTerminal } from "./terminal-panel";
import { setupExternalChangeRefresh } from "./external-refresh";
import { openQuickLaunch } from "./quick-launch-commands";
import { cloneRepoAction, initRepoAction } from "./new-repo-actions";
import { openWorkspacesAction } from "./local-workspace-actions";
import { openInDiffTool, openInMergeTool } from "./external-tools";
import { setupLogKeyboardNav, setupShortcuts } from "./keyboard";
import { setupBranchMenu, setupPullMenu, setupSettingsMenu } from "./topbar-menus";
import { setupProfileMenu } from "./profile-menu";
import { showComparison } from "./compare";

function wireUi(): void {
  $("#open-btn").addEventListener("click", () => {
    const path = $<HTMLInputElement>("#repo-input").value.trim();
    if (path) void loadRepo(path).then(warmTerminal);
  });
  $("#browse-btn").addEventListener("click", async () => {
    const path = await browseForRepo();
    if (path) void loadRepo(path).then(warmTerminal);
    else if (!isTauri()) setStatus("The folder picker is only available in the desktop app.");
  });
  $("#clone-btn").addEventListener("click", cloneRepoAction);
  $("#init-btn").addEventListener("click", initRepoAction);
  $("#workspaces-btn").addEventListener("click", openWorkspacesAction);
  $<HTMLInputElement>("#repo-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#open-btn").click();
  });
  for (const tab of document.querySelectorAll<HTMLElement>(".tab")) {
    tab.addEventListener("click", () => showView((tab.dataset.tab as View) ?? "history"));
  }
  $("#undo-btn").addEventListener("click", () => void undoAction());
  $("#redo-btn").addEventListener("click", () => void redoAction());
  $("#pull-btn").addEventListener("click", () => void runPullDefault());
  setupPullMenu();
  updatePullButtonTitle();
  $("#push-btn").addEventListener("click", () => void pushAction());
  $("#stash-btn").addEventListener("click", openStashDialogAction);
  $("#pop-btn").addEventListener("click", () => void popAction());
  $("#refresh-btn").addEventListener("click", () => void refreshAllAction());
  setupShortcuts();
  setupBranchMenu();
  $("#quick-launch-btn").addEventListener("click", openQuickLaunch);
  setupTerminalPanel();
  $("#terminal-toggle").addEventListener("click", toggleTerminal);
  $("#terminal-close").addEventListener("click", toggleTerminal);
  $("#terminal-clear").addEventListener("click", () => {
    ui.terminal?.clear();
    ui.terminal?.focus();
  });
  setupTerminalResizer();
  // On the "system" setting nothing calls applyTheme when the OS flips, so the
  // terminal would keep the old palette.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (currentTheme() === "system") ui.terminal?.syncTheme();
  });
  window.addEventListener("resize", () => ui.terminal?.fit());
  setupPaneResizer();
  setupSidebarResizer();
  setupSettingsMenu();
  void setupProfileMenu();
  setupExternalChangeRefresh();
  setupLogKeyboardNav();
  setupFetchAgeIndicator();
  $("#status-lfs").addEventListener("click", (e) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onLfsMenu(r.left, r.top);
  });
  startAutoFetch(loadAutoFetchMinutes());
  setupBranchToggle();
  setupLogSearch();
  setupConfigTabs();
}

// Live commit search: debounced so typing doesn't fire a query per keystroke;
// Escape clears it and returns to the normal paged log.
function setupLogSearch(): void {
  const input = $<HTMLInputElement>("#log-search");
  let timer: number | undefined;
  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void updateLogView(), 150);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) {
      input.value = "";
      void updateLogView();
    }
  });
}

// The Author column's funnel (GitKraken themes): a menu of the authors in the
// loaded log. Picking one puts an author: term in the search box, which hides
// everyone else's commits (see log-columns.ts); picking it again, or All
// Authors, takes the term out.
const AUTHOR_MENU_CAP = 25;

function authorFilterActive(): boolean {
  return authorTerm($<HTMLInputElement>("#log-search").value) !== null;
}

function openAuthorFilterMenu(x: number, y: number): void {
  const input = $<HTMLInputElement>("#log-search");
  const current = authorTerm(input.value)?.toLowerCase() ?? null;
  const apply = (author: string | null) => {
    input.value = withAuthorTerm(input.value, author);
    void updateLogView();
  };
  const items: MenuItem[] = [
    { label: current ? "All Authors" : "✓ All Authors", run: () => apply(null) },
    { separator: true },
    { heading: "Authors in the loaded commits" },
  ];
  for (const a of authorsOf(state.rows).slice(0, AUTHOR_MENU_CAP)) {
    // By email where there is one: a name can be part of someone else's.
    const value = a.email || a.name;
    const on = value.toLowerCase() === current;
    items.push({ label: `${on ? "✓ " : ""}${a.name} (${a.commits})`, run: () => apply(on ? null : value) });
  }
  showContextMenu(x, y, items);
}

// Wire the All-branches / Current segmented toggle above the log. Switching
// reloads the history from the new walk.
function setupBranchToggle(): void {
  const all = $("#branches-all");
  const current = $("#branches-current");
  // Reflect the persisted choice (already loaded into state) in the buttons.
  all.classList.toggle("active", state.allBranches);
  current.classList.toggle("active", !state.allBranches);
  const set = (allBranches: boolean) => {
    if (state.allBranches === allBranches) return;
    state.allBranches = allBranches;
    saveAllBranches(allBranches);
    all.classList.toggle("active", allBranches);
    current.classList.toggle("active", !allBranches);
    void refreshHistory();
  };
  all.addEventListener("click", () => set(true));
  current.addEventListener("click", () => set(false));
}

async function init(): Promise<void> {
  // The shell draws the sidebar and the log; the menus and actions behind their
  // rows live in modules built on top of it, so they are plugged in from here.
  setOnMoreRefs(onMoreRefsMenu);
  setOnOpenWip(() => showView("changes"));
  setAuthorFilter({ active: authorFilterActive, open: openAuthorFilterMenu });
  setOnGhostCheckout((name) => {
    const b = state.refs.branches.find((x) => x.name === name);
    if (b) void checkoutBranchAction(b);
  });
  setupBranchHover();
  setStashHandlers((s) => void showStashDetail(s), onStashMenu);
  setOnRefDrop(onRefDrop);
  setRefActions({
    checkoutBranchAction,
    onBranchMenu,
    onBranchBulkMenu,
    onStashMenu,
    onRemoteMenu,
    onAddRemote: addRemoteAction,
    onRemotesMenu,
    onRemoteFolderMenu,
    onTagMenu,
    onCommitContextMenu,
    onWorktreeMenu,
    onWorktreeDrop,
    onSubmoduleOpen: openSubmodule,
    onSubmoduleMenu,
    onAddSubmodule: addSubmoduleAction,
    createBranchAt: (name, rev) => void runCommitOp(`Creating ${name}`, () => createBranchAt(name, rev), rev),
    onSectionMenu,
  });
  applyTheme(currentTheme());
  void applyZoom(loadZoom());
  applyCodePrefs();
  state.allBranches = loadAllBranches(); // before wireUi so the toggle reflects it
  wireUi();
  ui.detailView = setupDetail($("#detail-pane"), {
    onSelectCommit: (id) => void jumpToCommit(id, id.slice(0, 10)),
    refsAt,
    fetchTree: fetchCommitTree,
    fetchBlame,
    fetchFileHistory,
    fetchFileDiff: (id, file, contextLines, ignoreWhitespace, full) =>
      fetchCommitFileDiff(id, file.path, file.old_path, contextLines, ignoreWhitespace, full),
    fetchCompareFileDiff,
    onCompare: (base, head, threeDot) => void showComparison(base, head, threeDot),
    fetchFileContent,
    openInDiffTool: (target, paths) => void openInDiffTool(target, paths),
    onCloseCompare: () => void leaveComparison(),
    restoreFiles: (id, paths) => void restoreFilesAction(id, paths),
    revertHunk: (id, file, hunkIndex, contextLines) => void revertHunkAction(id, file, hunkIndex, contextLines),
    fetchSignature: fetchCommitSignature,
    initialTab: loadDetailTab(),
    onTabChange: saveDetailTab,
  });
  ui.changesView = setupChanges($("#changes-pane"), {
    fetchStatus: fetchStatusSummary,
    fetchFileDiff,
    fetchFileContent,
    stage,
    unstage,
    stageAll,
    unstageAll,
    stageHunk,
    unstageHunk,
    discardHunk,
    stageLines,
    unstageLines,
    discardLines,
    discardFiles,
    stashFiles,
    saveFilesPatch,
    addToGitignore,
    untrackFiles,
    revealPath,
    openInEditor,
    editInApp: editFileAction,
    createFile: createFileAction,
    deleteFile,
    openInDiffTool: (target, paths) => void openInDiffTool(target, paths),
    repoRoot: () => state.repoPath || null,
    confirm: confirmDialog,
    fetchHead: async () => {
      try {
        return await fetchCommitDetail("HEAD");
      } catch {
        return null;
      }
    },
    commit: commitChanges,
    fetchSigningConfig,
    fetchCommitTemplate,
    pushAfterCommit: loadPushAfterCommit,
    setPushAfterCommit: savePushAfterCommit,
    push: () => void pushAction(),
    // Staging doesn't change refs or history, so just update the badge — no ref
    // walk or log rebuild (that's what made each stage/unstage feel slow).
    onChanged: (count) => {
      // A snapshot-driven refresh already set this and repainted; re-rendering
      // the whole ref tree again for an unchanged count is pure waste.
      if (state.localChanges === count) return;
      state.localChanges = count;
      renderSidebarNow();
      refreshWipRow();
    },
    onCommitted: () => {
      void loadSidebar();
      void refreshHistory();
    },
    setStatus,
    reportDone,
    onActed: () => void refreshUndoLabels(),
    reportError: opFailed,
    openConflicts: () => showView("conflict"),
  });
  ui.conflictView = setupConflict($("#conflict-pane"), {
    fetchStatus: conflictStatus,
    fetchSides: conflictSides,
    resolve: resolveConflict,
    resolveSide: resolveConflictSide,
    openInEditor,
    openInMergeTool: (path) => void openInMergeTool(path),
    abort: abortConflict,
    finish: finishConflict,
    confirm: confirmDialog,
    setStatus,
    reportDone,
    reportError: opFailed,
    onDone: async (msg, aborted) => {
      // An abort mid-batch cancels the rest — resolving that one commit's
      // conflict clearly wasn't wanted, so continuing to apply the remaining
      // queued commits without asking would be surprising.
      if (aborted) {
        ui.pendingCherryPicks = [];
        ui.pickPlanRepo = "";
      }
      // Resume only the batch this session paused: same repo, and the session
      // that just finished was its cherry-pick (not some later merge the
      // leftovers would otherwise be applied on top of). Decided now, because
      // the refresh below sees the session end and clears the queue.
      const queued = ui.pendingCherryPicks;
      const resume =
        !aborted &&
        queued.length > 0 &&
        ui.pendingCherryPicksRepo === state.repoPath &&
        state.conflict?.kind === "cherry-pick";
      // An interactive cherry-pick plan paused here resumes the same way.
      const planRepo = ui.pickPlanRepo;
      const resumePlan = !aborted && planRepo === state.repoPath && state.conflict?.kind === "cherry-pick";
      showView("history");
      try {
        await Promise.all([refreshHistory(), loadSidebar()]);
        reportDone(msg.trim() || "Done.");
      } catch (err) {
        // Never leave a silently blank pane — surface what went wrong.
        opFailed("Finished, but refreshing the view failed", err);
        return;
      }
      if (resume && ui.pendingCherryPicksRepo === state.repoPath) {
        ui.pendingCherryPicks = queued;
        await runNextCherryPick();
      }
      if (resumePlan && planRepo === state.repoPath) {
        ui.pickPlanRepo = "";
        await resumeCherryPickPlan();
      }
    },
  });
  ui.reflogView = setupReflog($("#reflog-col"), {
    fetch: fetchReflog,
    onSelect: (entry) => void showReflogDetail(entry),
    onMenu: onReflogMenu,
    reportError: readFailed,
  });
  ui.activityView = setupActivity($("#activity-view"), {
    fetch: fetchActivityLog,
    clear: clearActivityLog,
    copy: (text) => void copyText(text, "Copied the command and its output."),
    reportError: readFailed,
  });
  if (isTauri()) {
    if (await restoreWorkspace()) {
      warmTerminal();
    } else {
      setStatus("Enter a repository path and press Open.");
      ui.detailView?.showEmpty();
      renderSidebarNow();
    }
  } else {
    applyWorkspace(await listRepos());
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    setStatus("Preview mode (mock data). Open the desktop app for a real repo.");
  }
}

watchPending();
watchNetwork();

void init();
