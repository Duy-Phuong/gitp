// The branch Review panel's actions: open it, read its data, run the review
// skill or command on the branch in the background, fix a draft in the
// branch's worktree, change the base, forget the review. The panel itself is
// views/branch-review.ts; the state, branch-reviews.ts and pr-reviews.ts.

import { branchCancelReview, branchGenerateReview, branchReviewLoad, confirmDialog, isCancelled, reviewDefaultBase, reviewDraftFix } from "./api";
import { state, ui } from "./app-state";
import { branchState, hunkAround, loadReviewBase, placeDraft, saveReviewBase } from "./branch-reviews";
import { applyStored, flushSaves, mergeDrafts, reviewFor, reviewsChanged, type Draft } from "./pr-reviews";
import { BRANCH_SKILL_REVIEW_COMMAND, loadReviewCommand, loadThreadCommand, withClaudeChoice } from "./prefs";
import { readFailed, reportDone, setStatus } from "./report";
import { parseReviewFile } from "./review-drafts";
import { jumpToCommit, loadSidebar, showBranchReview } from "./shell";
import type { BranchReviewCallbacks } from "./views/branch-review";
import { showErrorDialog } from "./views/message-dialog";
import { toast } from "./views/toast";

const redraw = () => ui.branchReviewView?.redraw();

// Open the panel on `branch`, and start a review when `run` says which.
export function openBranchReview(branch: string, run?: "skill" | "command"): void {
  showBranchReview(branch);
  if (run) void runBranchReview(state.repoPath, branch, run === "skill");
}

// The base the panel diffs against: the one picked in Against, else the
// repository's default (origin/HEAD's branch, else main, else master).
async function baseOf(repo: string, branch: string): Promise<string> {
  const s = branchState(repo, branch);
  if (!s.base) s.base = loadReviewBase(repo, branch) ?? (await reviewDefaultBase(repo));
  return s.base;
}

// Read the panel's data again: the diff, the saved review (after anything
// typed is saved, so the disk copy is current), the worktree.
export async function loadBranchReview(repo: string, branch: string): Promise<void> {
  const s = branchState(repo, branch);
  s.loading = true;
  redraw();
  try {
    const base = await baseOf(repo, branch);
    await flushSaves();
    const data = await branchReviewLoad(repo, branch, base);
    s.data = data;
    s.base = data.base;
    s.error = null;
    if (data.review) applyStored(repo, { branch }, data.review);
  } catch (err) {
    s.error = String(err);
  } finally {
    s.loading = false;
    reviewsChanged();
  }
}

// Run the review skill or command on `branch` in the background; its
// findings merge into the branch's drafts (what was decided or fixed stays).
async function runBranchReview(repo: string, branch: string, skill: boolean): Promise<void> {
  const s = branchState(repo, branch);
  if (s.running) return setStatus(`A review of ${branch} is already running.`);
  if (s.fixing !== null) return setStatus(`A fix is running on ${branch}: review again once it's done.`);
  s.running = true;
  s.error = null;
  redraw();
  setStatus(`Reviewing ${branch} in the background — keep working; the Review panel shows when it's done.`);
  try {
    const base = await baseOf(repo, branch);
    // The saved drafts first, so the merge keeps their decisions.
    if (!s.data) await loadBranchReview(repo, branch);
    const command = skill ? BRANCH_SKILL_REVIEW_COMMAND : loadReviewCommand();
    const out = await branchGenerateReview(repo, branch, base, withClaudeChoice(command), skill ? "Review with Skill" : "Review Command");
    const found = parseReviewFile(out.text);
    const r = reviewFor(repo, { branch });
    r.drafts = mergeDrafts(r.drafts, found);
    r.head = out.head;
    r.base = out.base;
    reviewsChanged();
    await flushSaves();
    if (found.length === 0) {
      const said = `The review of ${branch} found nothing to comment on`;
      setStatus(`${said}.`);
      toast(said, { kind: "info", onDetails: () => showErrorDialog(`Review of ${branch}`, out.text.trim().slice(0, 600)) });
    } else {
      reportDone(`Review of ${branch} ready: ${found.length} finding${found.length === 1 ? "" : "s"}.`);
    }
  } catch (err) {
    if (isCancelled(err)) setStatus(`Review of ${branch} cancelled.`);
    else {
      const title = `Couldn't review ${branch}`;
      s.error = String(err);
      setStatus(`${title}: ${s.error}`);
      toast(title, { kind: "error", onDetails: () => showErrorDialog(title, String(err)) });
    }
  } finally {
    s.running = false;
    await loadBranchReview(repo, branch);
  }
}

// Fix draft `d` in the branch's worktree, in the background: one commit, the
// draft marked fixed. The line and hunk sent are the current ones.
async function fixBranchDraft(repo: string, branch: string, d: Draft): Promise<void> {
  const s = branchState(repo, branch);
  if (s.fixing !== null || s.running || !s.data) return;
  const at = placeDraft(d, s.data.moves);
  if (at.moved) return;
  const where = `${at.path}:${at.line}`;
  s.fixing = d.id;
  redraw();
  setStatus(`Fixing ${where} in ${branch}'s worktree in the background — keep working; the draft shows when it's done.`);
  try {
    await flushSaves();
    const stored = await reviewDraftFix(
      repo,
      { branch },
      d.id,
      {
        path: at.path,
        line: at.line,
        side: at.side,
        body: d.body,
        severity: d.severity,
        diff_hunk: hunkAround(s.data.files, at.path, at.line, at.side),
        branch,
        base: s.base,
      },
      withClaudeChoice(loadThreadCommand("fix")),
    );
    applyStored(repo, { branch }, stored);
    const commit = stored.drafts.find((x) => x.id === d.id)?.fix?.commit.slice(0, 7);
    reportDone(`Fixed ${where} on ${branch}${commit ? ` in ${commit}` : ""}.`);
    void loadSidebar();
  } catch (err) {
    if (isCancelled(err)) setStatus(`Fix of ${where} cancelled; the worktree is back where it was.`);
    else {
      const title = `Couldn't fix ${where} on ${branch}`;
      setStatus(`${title}: ${String(err)}`);
      toast(title, { kind: "error", onDetails: () => showErrorDialog(title, String(err)) });
    }
  } finally {
    s.fixing = null;
    await loadBranchReview(repo, branch);
  }
}

export const branchReviewCallbacks: BranchReviewCallbacks = {
  repoPath: () => state.repoPath,
  bases: () => [...state.refs.branches.map((b) => b.name), ...state.refs.remotes.map((r) => r.name).filter((n) => !n.endsWith("/HEAD"))],
  load: (branch) => void loadBranchReview(state.repoPath, branch),
  run: (branch, _base, skill) => void runBranchReview(state.repoPath, branch, skill),
  cancel: (branch) => void branchCancelReview(state.repoPath, branch).catch((err) => readFailed("Couldn't stop the review", err)),
  fix: (branch, d) => void fixBranchDraft(state.repoPath, branch, d),
  openCommit: (sha) => void jumpToCommit(sha, sha.slice(0, 7)),
  clear: (branch) =>
    void (async () => {
      if (!(await confirmDialog(`Forget the review of ${branch}, its fixed marks included? The commits stay.`))) return;
      const r = reviewFor(state.repoPath, { branch });
      r.drafts = [];
      r.head = undefined;
      r.base = undefined;
      reviewsChanged();
      await flushSaves();
    })(),
  changeBase: (branch, base) => {
    saveReviewBase(state.repoPath, branch, base);
    branchState(state.repoPath, branch).base = base;
    void loadBranchReview(state.repoPath, branch);
  },
};
