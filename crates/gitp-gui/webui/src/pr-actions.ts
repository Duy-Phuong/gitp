// GitHub pull requests through the user's own `gh` login: loading the
// sidebar's Pull Requests section, opening a new pull request, the pull
// request view's actions (check out, comment, reply, review, comment on a
// line, merge), and signing gh in and out.
//
// Everything posted goes to GitHub under the user's name, so each post is
// confirmed first and its result reported after.

import {
  checkoutPullRequest,
  checkoutPullRequestInWorktree,
  commentOnLine,
  commentOnPullRequest,
  cancelReviewDrafts,
  cancelThreadTurn,
  clearThreadConversation,
  confirmDialog,
  createPullRequestOnGitHub,
  fetchPullRequestFiles,
  fetchPullRequestViewed,
  setPullRequestFileViewed,
  fetchPullRequestSignature,
  fetchGitHubCommitFiles,
  generateReviewDrafts,
  ghAccount,
  ghLoginCancel,
  ghLoginStart,
  ghLoginWait,
  ghLogout,
  ghRepo,
  openReviewPage,
  explainReviewFinding,
  reviewPageUrl,
  reviewFiles,
  githubRepoSettings,
  isCancelled,
  listPullRequests,
  mergePullRequest,
  openGithubUrl,
  pickReviewFile,
  pruneThreadConversations,
  pullRequestDraft,
  pushBranch,
  readReviewFile,
  replyToReviewComment,
  resolveReviewThread,
  revealFolder,
  revealPath,
  reviewPullRequest,
  reviewWithComments,
  threadConversation,
  threadChoose,
  applySuggestions,
  threadFix,
  threadTurn,
  markReplyPosted,
  dropReply,
  branchAheadLog,
  reviewDraftFix,
  storedReviewLoad,
} from "./api";
import { pushAndReplyListing, type ReplyToPost } from "./pr-push-reply";
import { pausePollingFor, startPolling } from "./poller";
import { isRateLimit, listChanged, PR_LIST_POLL_MS, RATE_LIMIT_PAUSE_MS } from "./pr-refresh";
import { state, ui } from "./app-state";
import { readPullRequest } from "./read-ahead";
import { noticeBranchForCi } from "./ci-badge";
import { storePullRequestList, storedPullRequestList } from "./pr-store";
import { copyText } from "./clipboard";
import { opFailed, readFailed, reportDone, setStatus } from "./report";
import {
  loadRepo,
  loadSidebar,
  openPullRequestTab,
  refreshHistory,
  renderSidebarNow,
  jumpToCommit,
  showPullRequest,
  showView,
} from "./shell";
import { defaultWorktreePath, worktreeOf } from "./worktree-actions";
import { hunkAround, openFindingsNote } from "./branch-reviews";
import { parseReviewFile, reviewedHeadIn } from "./review-drafts";
import { cancelDraft, draftPullRequest, loadDraftCommand } from "./claude-drafts";
import { prDraftAction } from "./pr-draft-action";
import { EXPLAIN_FINDING_COMMAND, loadReviewCommand, loadThreadCommand, SKILL_REVIEW_COMMAND, withClaudeChoice } from "./prefs";
import { finishTurn, lastUserText, preparedReply, runningTurns, setConversation, startTurn, threadState, threadsChanged } from "./pr-threads";
import { showContextMenu, showPrompt } from "./views/context-menu";
import { openFormDialog } from "./views/form-dialog";
import { showErrorDialog } from "./views/message-dialog";
import { toast } from "./views/toast";
import {
  addDrafts,
  applyStored,
  flushSaves,
  isOpen,
  mergeDrafts,
  type Draft,
  prReview,
  rememberedFile,
  reviewedHead,
  reviewsChanged,
  setReviewedHead,
  setReviewFile,
  unposted,
} from "./pr-reviews";
import { openSignInDialog } from "./views/github-sign-in";
import type { PullRequestCallbacks } from "./views/pull-request";
import { openReviewViewer } from "./views/review-viewer";
import { baseBranches, canFixDrafts, defaultMergeMethod, githubRemoteName, listingOf, mergeAdvice, mergeChoices, otherListings, reviewThreads, type Thread } from "./pull-requests";
import type { AheadCommit, BranchRef, GhAccount, MergeMethod, PrFilter, PullRequest, PullRequestDetail, ReviewVerdict, ThreadConversation, TurnKind } from "./types";

// --- The sidebar section ----------------------------------------------------

// Load the Pull Requests section for the active repo: whether it is on GitHub,
// who gh is signed in as (asked once, or again with `recheckAccount`), and the
// open pull requests under the current filter.
export async function loadPullRequests(recheckAccount = false): Promise<void> {
  const path = state.repoPath;
  const filter = state.prs.filter;
  state.prs.repoPath = path;
  const stale = () => state.repoPath !== path || state.prs.filter !== filter;
  const repo = path ? await ghRepo().catch(() => null) : null;
  if (stale()) return;
  state.prs.repo = repo;
  state.prs.error = null;
  noticeBranchForCi();
  if (!repo) {
    pollList(false);
    state.prs.list = null;
    renderSidebarNow();
    return;
  }
  state.prs.loading = true;
  // The list last seen for this repository shows while it is read again.
  if (!state.prs.list) state.prs.list = storedPullRequestList(path, listingOf(filter));
  renderSidebarNow();
  // Asked for while gh's account is checked (the first time only), not after.
  const listing = listPullRequests(listingOf(filter));
  listing.catch(() => {
    // Read below, when gh is signed in.
  });
  const saving = reviewFiles().catch(() => []);
  if (!state.prs.account || recheckAccount) state.prs.account = await accountOrError();
  if (stale()) return;
  const account = state.prs.account;
  if (!account.installed || !account.signed_in) state.prs.list = null;
  else {
    try {
      const [list, saved] = await Promise.all([listing, saving]);
      if (stale()) return;
      state.prs.list = list;
      storePullRequestList(path, listingOf(filter), list);
      state.prs.reviewFiles = saved;
      void readOtherListsAhead(path, filter);
      // The open pull request's review page icon follows the list.
      ui.prView?.redraw();
    } catch (err) {
      if (stale()) return;
      state.prs.error = String(err);
    }
  }
  state.prs.loading = false;
  renderSidebarNow();
  pollList(account.installed && account.signed_in);
}

// The list refreshing on its own, every 60 s while a signed-in GitHub repo is
// open: read again quietly, drawn only when a row changed.
let stopListPoll: (() => void) | null = null;

function pollList(on: boolean): void {
  stopListPoll?.();
  stopListPoll = on ? startPolling("pr-list", PR_LIST_POLL_MS, pollPullRequestList) : null;
}

async function pollPullRequestList(): Promise<void> {
  const path = state.repoPath;
  const filter = state.prs.filter;
  const stale = () => state.repoPath !== path || state.prs.filter !== filter || state.prs.loading;
  if (!path || !state.prs.repo || state.prs.repoPath !== path || stale()) return;
  try {
    const list = await listPullRequests(listingOf(filter));
    if (stale() || !listChanged(state.prs.list, list)) return;
    state.prs.list = list;
    storePullRequestList(path, listingOf(filter), list);
    state.prs.error = null;
    renderSidebarNow();
  } catch (err) {
    if (isRateLimit(err)) pausePollingFor(RATE_LIMIT_PAUSE_MS);
  }
}

// Read again which pull requests have a saved review: one just finished.
async function refreshReviewFiles(): Promise<void> {
  const path = state.repoPath;
  const saved = await reviewFiles().catch(() => null);
  if (!saved || state.repoPath !== path) return;
  state.prs.reviewFiles = saved;
  renderSidebarNow();
  ui.prView?.redraw();
}

// The saved review of pull request `number` in the open repo, if any.
function savedReview(number: number): string | null {
  return state.prs.reviewFiles.find((f) => f.number === number)?.path ?? null;
}

// gh's account, or — when even asking failed — a signed-out one saying why.
async function accountOrError(): Promise<GhAccount> {
  try {
    return await ghAccount();
  } catch (err) {
    return { installed: true, signed_in: false, login: null, scopes: [], message: String(err) };
  }
}

// The action bar's PRs button: the Pull Requests view, its list read when
// the sidebar hasn't yet.
export function showPullRequestList(): void {
  showView("prlist");
  if (!state.prs.list && !state.prs.loading) void loadPullRequests();
  ui.prListView?.focusSearch();
}

export function setPrFilter(filter: PrFilter): void {
  if (filter === state.prs.filter) return;
  state.prs.filter = filter;
  // Its list as last read (or read ahead) shows at once, while it is read again.
  state.prs.list = state.repoPath ? storedPullRequestList(state.repoPath, listingOf(filter)) : null;
  renderSidebarNow();
  void loadPullRequests();
}

// The repositories whose other filters' lists were read ahead this session.
const listsReadAhead = new Set<string>();

// Read the other filters' lists once per repository, one after another, after
// its first list: switching filter then shows a list at once, not "Loading…".
async function readOtherListsAhead(path: string, filter: PrFilter): Promise<void> {
  if (listsReadAhead.has(path)) return;
  listsReadAhead.add(path);
  for (const listing of otherListings(filter)) {
    if (state.repoPath !== path) return;
    try {
      storePullRequestList(path, listing, await listPullRequests(listing));
    } catch {
      // Offline or rate-limited: a switch reads its list then.
      return;
    }
  }
}

// Quick Launch's "Pull Requests: Reviewed" and the like: the section open,
// under `filter`, scrolled into view.
export function showPrFilter(filter: PrFilter): void {
  state.sbCollapsed.delete("sec:prs");
  setPrFilter(filter);
  renderSidebarNow();
  document.querySelector(".sb-pr-filters")?.scrollIntoView({ block: "nearest" });
}

export function refreshPullRequests(): void {
  void loadPullRequests(true);
}

// Right-click a pull request in the sidebar.
export function onPrMenu(pr: PullRequest, x: number, y: number): void {
  showContextMenu(x, y, [
    { label: "Open", run: () => showPullRequest(pr.number) },
    { label: "Check Out", run: () => void checkoutPullRequestAction(pr.number) },
    {
      label: "Check Out in New Worktree…",
      prompt: {
        placeholder: "Folder for the new worktree",
        value: defaultWorktreePath(pr.head),
        onSubmit: (path) => void checkoutPullRequestInWorktreeAction(pr.number, path),
      },
    },
    { separator: true },
    { label: "Open on GitHub", run: () => void openUrl(pr.url) },
    { label: "Copy Link", run: () => void copyText(pr.url, `Copied ${pr.url}`) },
    { label: "Copy Branch Name", run: () => void copyText(pr.head, `Copied ${pr.head}`) },
  ]);
}

// --- Checking out -----------------------------------------------------------

// `gh pr checkout`: a local branch on the pull request's head, checked out
// here. git refuses when local changes would be overwritten, and says so.
export async function checkoutPullRequestAction(number: number): Promise<void> {
  setStatus(`Checking out pull request #${number}…`);
  try {
    const out = (await checkoutPullRequest(number)).trim();
    showView("history");
    await Promise.all([refreshHistory(), loadSidebar()]);
    reportDone(out || `Checked out pull request #${number}`);
  } catch (err) {
    opFailed(`Couldn't check out pull request #${number}`, err);
  }
}

// A new worktree on the pull request's branch, then the offer to open it —
// the same as Check Out in New Worktree for a branch.
export async function checkoutPullRequestInWorktreeAction(number: number, path: string): Promise<void> {
  setStatus(`Checking out pull request #${number} in ${path}…`);
  let full: string;
  try {
    full = await checkoutPullRequestInWorktree(number, path);
  } catch (err) {
    opFailed(`Couldn't check out pull request #${number} in a new worktree`, err);
    return;
  }
  await loadSidebar();
  reportDone(`Checked out pull request #${number} in ${full}`);
  if (await confirmDialog(`Worktree created at ${full}.\n\nOpen it now?`)) await loadRepo(full);
}

// --- Posting ----------------------------------------------------------------

// Ask before anything goes to GitHub under the user's name.
async function confirmPost(what: string, number: number, body: string): Promise<boolean> {
  const who = state.prs.account?.login ? ` as ${state.prs.account.login}` : "";
  const preview = body.trim().length > 400 ? `${body.trim().slice(0, 400)}…` : body.trim();
  const ok = await confirmDialog(`Post ${what} on pull request #${number} to GitHub${who}?${preview ? `\n\n${preview}` : ""}`);
  if (!ok) setStatus("Not posted.");
  return ok;
}

// Post, report what GitHub made of it, and say whether it went through.
async function post(what: string, number: number, body: string, run: () => Promise<string>): Promise<boolean> {
  if (!(await confirmPost(what, number, body))) return false;
  setStatus(`Posting ${what} on #${number}…`);
  try {
    const said = (await run()).trim();
    reportDone(said ? `Posted ${what} on #${number}: ${said}` : `Posted ${what} on #${number}.`);
    return true;
  } catch (err) {
    opFailed(`Couldn't post ${what} on #${number}`, err);
    return false;
  }
}

const VERDICTS: { verdict: ReviewVerdict; label: string; what: string }[] = [
  { verdict: "approve", label: "Approve", what: "an approval" },
  { verdict: "request_changes", label: "Request Changes", what: "a review requesting changes" },
  { verdict: "comment", label: "Comment", what: "a review comment" },
];

// The view's Review button: pick a verdict, write the review, post it.
function reviewMenu(number: number, x: number, y: number): void {
  showContextMenu(
    x,
    y,
    VERDICTS.map(({ verdict, label, what }) => ({
      label: `${label}…`,
      run: () =>
        openFormDialog(
          {
            title: `${label} #${number}`,
            sub: verdict === "approve" ? "A message is optional." : "GitHub needs a message for this review.",
            fields: [{ label: "Message", multiline: true, required: verdict !== "approve", placeholder: "Markdown" }],
            submitLabel: label,
          },
          ([body]) =>
            void post(what, number, body, () => reviewPullRequest(number, verdict, body)).then((ok) => {
              if (ok) ui.prView?.reload();
            }),
        ),
    })),
  );
}

async function openUrl(url: string): Promise<void> {
  try {
    await openGithubUrl(url);
  } catch (err) {
    readFailed("Couldn't open the page", err);
  }
}

// --- Opening and merging -----------------------------------------------------

// "Create Pull Request…" on a branch of a GitHub repository: a form filled
// from its commits, into the repository's default branch, then — after
// pushing the branch to `remote` when GitHub hasn't all of it — the pull
// request opened with gh, and shown.
export async function createPullRequestDialog(b: BranchRef, remote: string): Promise<void> {
  const repo = state.prs.repo!;
  setStatus(`Preparing a pull request for ${b.name}…`);
  let settings;
  try {
    settings = await githubRepoSettings();
  } catch (err) {
    opFailed(`Couldn't read ${repo} on GitHub`, err);
    return;
  }
  const fallback = settings.default_branch || "main";
  const draft = await pullRequestDraft(b.name, fallback).catch(() => ({ title: b.name, body: "" }));
  const baseRemote = githubRemoteName(state.remoteList, repo) ?? remote;
  const bases = baseBranches(
    state.refs.remotes.map((r) => r.name),
    baseRemote,
    fallback,
  );
  const unpushed = !b.has_upstream || b.ahead > 0;
  // The branch's own review, if it had one: findings still open are worth a word.
  await flushSaves();
  const reviewed = await storedReviewLoad(state.repoPath, { branch: b.name }).catch(() => null);
  const note = openFindingsNote(reviewed?.drafts.filter((d) => d.status === "pending" || d.status === "approved").length ?? 0);
  setStatus("");
  const path = state.repoPath;
  const claude = prDraftAction({
    prefilled: draft,
    fields: { base: 0, title: 1, body: 2 },
    draft: (base) => draftPullRequest(path, b.name, base, withClaudeChoice(loadDraftCommand("pr-draft"))),
    cancel: () => void cancelDraft(path, "pull_request"),
    confirm: confirmDialog,
  });
  openFormDialog(
    {
      title: `Create Pull Request from ${b.name}`,
      sub: `${unpushed ? `On ${repo}. ${b.name} is pushed to ${remote} first.` : `On ${repo}.`}${note ? ` ${note}` : ""}`,
      fields: [
        { label: "Into", choices: bases.map((n) => ({ value: n, label: n })), value: fallback },
        { label: "Title", value: draft.title, required: true },
        { label: "Description", value: draft.body, multiline: true, placeholder: "Markdown", action: claude.action },
        {
          label: "As",
          choices: [
            { value: "ready", label: "Ready for review" },
            { value: "draft", label: "Draft" },
          ],
        },
      ],
      submitLabel: "Create Pull Request",
      onClose: claude.close,
    },
    ([base, title, body, kind]) => void createPullRequestNow(b, remote, base, title, body, kind === "draft", unpushed),
  );
}

async function createPullRequestNow(
  b: BranchRef,
  remote: string,
  base: string,
  title: string,
  body: string,
  draft: boolean,
  unpushed: boolean,
): Promise<void> {
  if (unpushed) {
    setStatus(`Pushing ${b.name} to ${remote}…`);
    try {
      await pushBranch(b.name, remote);
    } catch (err) {
      if (!isCancelled(err)) opFailed(`Couldn't push ${b.name}, so no pull request was opened`, err);
      return;
    }
    void loadSidebar();
  }
  setStatus(`Opening a pull request from ${b.name} into ${base}…`);
  let number;
  try {
    number = await createPullRequestOnGitHub({ branch: b.name, remote, base, title, body, draft });
  } catch (err) {
    opFailed(`Couldn't open a pull request from ${b.name}`, err);
    return;
  }
  reportDone(`Opened ${draft ? "draft " : ""}pull request #${number}: ${title}`);
  void loadPullRequests();
  showPullRequest(number);
}

// The view's Merge button: say why it can't merge, or ask how — the methods
// the repository allows, and whether its branch goes — then merge on GitHub.
async function mergeAction(pr: PullRequestDetail): Promise<void> {
  const advice = mergeAdvice(pr);
  if (advice.blocked) {
    showErrorDialog(`#${pr.number} can't be merged`, advice.blocked);
    return;
  }
  setStatus(`Reading how ${state.prs.repo ?? "the repository"} merges…`);
  let settings;
  try {
    settings = await githubRepoSettings();
  } catch (err) {
    opFailed("Couldn't read the repository on GitHub", err);
    return;
  }
  setStatus("");
  const choices = mergeChoices(settings);
  openFormDialog(
    {
      title: `Merge #${pr.number} into ${pr.base}`,
      sub: [pr.title, advice.warning].filter(Boolean).join(" — "),
      fields: [
        { label: "How", choices, value: defaultMergeMethod(pr.head, choices) },
        {
          label: "Then",
          choices: [
            { value: "delete", label: `Delete ${pr.head} on GitHub` },
            { value: "keep", label: `Keep ${pr.head}` },
          ],
          value: settings.delete_branch_on_merge ? "delete" : "keep",
        },
      ],
      submitLabel: "Merge",
    },
    ([method, then]) => void mergeNow(pr, method as MergeMethod, then === "delete"),
  );
}

async function mergeNow(pr: PullRequestDetail, method: MergeMethod, deleteBranch: boolean): Promise<void> {
  setStatus(`Merging #${pr.number} into ${pr.base}…`);
  try {
    const said = (await mergePullRequest(pr.number, method, deleteBranch)).trim();
    reportDone(said || `Merged #${pr.number} into ${pr.base}.`);
  } catch (err) {
    opFailed(`Couldn't merge #${pr.number}`, err);
    return;
  }
  ui.prView?.reload();
  void loadPullRequests();
  void loadSidebar();
}

// What the pull request view does, plugged in by main.ts.
export const pullRequestCallbacks: PullRequestCallbacks = {
  fetchDetail: readPullRequest,
  fetchSignature: fetchPullRequestSignature,
  fetchFiles: fetchPullRequestFiles,
  fetchViewed: fetchPullRequestViewed,
  setViewed: setPullRequestFileViewed,
  fetchCommitFiles: fetchGitHubCommitFiles,
  checkout: (pr) => void checkoutPullRequestAction(pr.number),
  checkoutInWorktree: (pr, x, y) =>
    showPrompt(x, y, {
      placeholder: "Folder for the new worktree",
      value: defaultWorktreePath(pr.head),
      onSubmit: (path) => void checkoutPullRequestInWorktreeAction(pr.number, path),
    }),
  reviewMenu: (pr, x, y) => reviewMenu(pr.number, x, y),
  merge: mergeAction,
  openInTab: (pr) => openPullRequestTab(pr.number, pr.title),
  leaveTab: (pr) => showPullRequest(pr.number),
  openUrl: (url) => void openUrl(url),
  comment: (pr, body) => post("a comment", pr.number, body, () => commentOnPullRequest(pr.number, body)),
  resolve: async (pr, thread, resolve) => {
    try {
      await resolveReviewThread(thread.id, resolve);
      reportDone(resolve ? "Conversation resolved." : "Conversation reopened.");
      return true;
    } catch (err) {
      opFailed(`Couldn't ${resolve ? "resolve" : "reopen"} the conversation on #${pr.number}`, err);
      return false;
    }
  },
  reply: async (pr, root, body) => {
    let url = "";
    const ok = await post(`a reply to ${root.author}`, pr.number, body, async () => (url = (await replyToReviewComment(pr.number, root.id, body)).url));
    // A reply Claude had ready is now posted, so Push and reply all skips
    // it. Core says when the thread had none ready; anything else is
    // reported, since the draft would otherwise be posted again.
    if (ok) {
      try {
        await markReplyPosted(state.repoPath, pr.number, root.id, url);
      } catch (err) {
        if (!/no reply ready|no Claude conversation/.test(String(err))) opFailed("Couldn't mark Claude's reply as posted", err);
      }
      const s = threadState(state.repoPath, pr.number, root.id);
      s.loaded = false;
      await loadThreadConversation(state.repoPath, pr.number, root.id);
    }
    return ok;
  },
  lineComment: (pr, comment) =>
    post(`a comment on ${comment.path}:${comment.line}`, pr.number, comment.body, async () => (await commentOnLine(pr.number, comment)).url),
  // The pull request's saved review when there is one — it replaces the
  // drafts, being the review of this pull request — else a file to pick,
  // starting in the review/ folder, added to them.
  loadDrafts: async (pr) => {
    const repo = state.repoPath;
    await refreshReviewFiles();
    const saved = savedReview(pr.number);
    const path = saved ?? (await pickReviewFile(`${repo.replace(/\/$/, "")}/review`));
    if (!path) return false;
    try {
      const text = await readReviewFile(path);
      const all = parseReviewFile(text);
      if (all.length === 0) {
        showErrorDialog(
          "No review comments found",
          `${path} has no finding with a "### path/to/file:line" heading and a comment, and is not a JSON list of {path, line, body}.`,
        );
        return false;
      }
      const head = reviewedHeadIn(text);
      if (head && !reviewedHead(repo, pr.number)) setReviewedHead(repo, pr.number, head);
      const drafts = unposted(repo, pr.number, all);
      if (drafts.length === 0) {
        setStatus(`Nothing new in ${path}: its ${all.length} finding${all.length === 1 ? " is" : "s are"} posted on #${pr.number}.`);
        return false;
      }
      await loadStoredPrReview(repo, pr.number);
      const r = prReview(repo, pr.number);
      // The saved review replaces the drafts, keeping what was decided and fixed.
      if (saved) r.drafts = mergeDrafts(r.drafts, drafts);
      else addDrafts(r, drafts);
      setReviewFile(repo, pr.number, path);
      reviewsChanged();
      setStatus(`Loaded ${drafts.length} draft comment${drafts.length === 1 ? "" : "s"} from ${path}.`);
      return true;
    } catch (err) {
      readFailed("Couldn't read the review file", err);
      return false;
    }
  },
  savedReview: (number) => savedReview(number),
  openReviewPage: (path) => void openReviewPage(path).catch((err) => readFailed("Couldn't open the review page", err)),
  readReview: (pr, path) =>
    openReviewViewer(state.repoPath, pr.number, pr.title, {
      pageUrl: reviewPageUrl,
      explain: (repo, number, finding) => explainReviewFinding(repo, number, finding, withClaudeChoice(EXPLAIN_FINDING_COMMAND)),
      openUrl: (url) => void openGithubUrl(url).catch((err) => readFailed("Couldn't open the page", err)),
      openInBrowser: () => void openReviewPage(path).catch((err) => readFailed("Couldn't open the review page", err)),
    }),
  repoPath: () => state.repoPath,
  branchAhead: (name) => state.refs.branches.find((b) => b.name === name)?.ahead ?? 0,
  generateDrafts: (pr) => void runReview(state.repoPath, pr.number, pr.head_oid),
  generateDraftsWithSkill: (pr) => void runReview(state.repoPath, pr.number, pr.head_oid, SKILL_REVIEW_COMMAND),
  reviewedHead: (number) => reviewedHead(state.repoPath, number),
  cancelReview: (pr) => void cancelReviewDrafts(state.repoPath, pr.number),
  restoreDrafts: (number) => void restoreDrafts(state.repoPath, number),
  showReviewFile: (path) => {
    // reveal_path takes a repo-relative path; a file outside the repo shows its folder.
    const root = `${state.repoPath.replace(/\/$/, "")}/`;
    void (path.startsWith(root) ? revealPath(path.slice(root.length)) : revealFolder(path.replace(/\/[^/]*$/, "")));
  },
  postReview: (pr, verdict, body, comments) => {
    const what = `a review with ${comments.length} comment${comments.length === 1 ? "" : "s"}`;
    const preview = comments.map((c) => `${c.path}:${c.line} — ${c.body.split("\n")[0]}`).join("\n");
    return post(what, pr.number, body.trim() ? `${body}\n\n${preview}` : preview, () => reviewWithComments(pr.number, verdict, body, comments));
  },
  threadTurn: (pr, thread, kind, userText) => void runThreadTurn(state.repoPath, pr, thread, kind, userText),
  fixThread: (pr, thread) => void runFix(state.repoPath, pr, thread),
  applySuggestions: async (pr, suggestions) => {
    const what = suggestions.length === 1 ? "the suggestion" : `${suggestions.length} suggestions`;
    setStatus(`Applying ${what} in ${pr.head}'s worktree…`);
    try {
      const commit = await applySuggestions(state.repoPath, pr.number, pr.head_oid, pr.head, suggestions);
      await Promise.all([refreshHistory(), loadSidebar()]);
      reportDone(`Committed ${what} on ${pr.head} (${commit.slice(0, 7)}); push the branch to share it.`);
    } catch (err) {
      opFailed(`Couldn't apply ${what}`, err);
    }
  },
  chooseOption: async (pr, thread, text) => {
    const repo = state.repoPath;
    try {
      setConversation(repo, pr.number, thread.root.id, await threadChoose(repo, pr.number, thread.root.id, text));
      return true;
    } catch (err) {
      opFailed("Couldn't save the option", err);
      return false;
    }
  },
  pushAndReplyAll: (pr, edited) => pushAndReplyAll(state.repoPath, pr, edited),
  dropReply: async (pr, thread) => {
    const repo = state.repoPath;
    if (!(await confirmDialog(`Drop the reply Claude prepared for ${thread.root.path} of #${pr.number}?`))) return false;
    try {
      await dropReply(repo, pr.number, thread.root.id);
      await loadThreadConversation(repo, pr.number, thread.root.id, true);
      return true;
    } catch (err) {
      opFailed("Couldn't drop the reply", err);
      return false;
    }
  },
  pushReplyInFlight: (pr) => pushReplyInFlight(state.repoPath, pr.number),
  cancelThreadTurn: (pr, thread) =>
    void cancelThreadTurn(state.repoPath, pr.number, thread.root.id).catch((err) => opFailed("Couldn't cancel Claude's turn", err)),
  confirm: (message) => confirmDialog(message),
  draftFix: (pr) => prDraftFix(state.repoPath, pr),
  openCommit: (sha) => void jumpToCommit(sha, sha.slice(0, 7)),
  loadThreadConversation: (pr, thread) => void loadThreadConversation(state.repoPath, pr.number, thread.root.id),
  clearThreadConversation: async (pr, thread) => {
    const repo = state.repoPath;
    if (!(await confirmDialog(`Forget Claude's conversation on ${thread.root.path} of #${pr.number}?`))) return false;
    try {
      await clearThreadConversation(repo, pr.number, thread.root.id);
      setConversation(repo, pr.number, thread.root.id, null);
      threadsChanged();
      return true;
    } catch (err) {
      opFailed("Couldn't forget the conversation", err);
      return false;
    }
  },
  pruneThreadConversations: () => {
    const repo = state.repoPath;
    pruneThreadConversations(repo).then(
      (n) => {
        if (n) setStatus(`Forgot ${n} Claude conversation${n === 1 ? "" : "s"} older than two months.`);
      },
      (err) => readFailed("Couldn't prune the Claude conversations", err),
    );
  },
  reportError: readFailed,
};

// --- Claude on a thread, in the background -----------------------------------

// Run one Claude turn of `kind` on `thread` of `pr`, in the repo at `repo`:
// the thread shows it running and, when it is done, the answer; the sidebar
// marks the pull request meanwhile. A reply draft builds on the last thing
// the user said in the conversation.
async function runThreadTurn(repo: string, pr: PullRequestDetail, thread: Thread, kind: TurnKind, userText: string): Promise<void> {
  const { number } = pr;
  const id = thread.root.id;
  const where = `${thread.root.path}:${thread.root.line ?? thread.root.original_line ?? "?"}`;
  if (!startTurn(repo, number, id, kind)) return;
  const text = kind === "reply-draft" ? lastUserText(threadState(repo, number, id).conversation) : userText;
  setStatus(`Asking Claude about ${where} of #${number} in the background — keep working; the thread shows when it answers.`);
  try {
    const input = { number, head: pr.head_oid, author: pr.author, title: pr.title, comments: [thread.root, ...thread.replies] };
    const conversation = await threadTurn(repo, input, kind, text, withClaudeChoice(loadThreadCommand(kind)));
    finishTurn(repo, number, id, conversation);
    setStatus(`Claude answered on ${where} of #${number}.`);
  } catch (err) {
    if (isCancelled(err)) {
      finishTurn(repo, number, id, { error: "Cancelled." });
      setStatus(`Claude's turn on ${where} of #${number} cancelled.`);
    } else {
      const title = `Claude couldn't answer on ${where} of #${number}`;
      finishTurn(repo, number, id, { error: String(err) });
      setStatus(`${title}: ${String(err)}`);
      toast(title, { kind: "error", onDetails: () => showErrorDialog(title, String(err)) });
    }
    // A failed follow-up kept its question: show it.
    void loadThreadConversation(repo, number, id, true);
  }
}

// Fix the thread as the user's last follow-up chose, in the worktree of the
// pull request's branch, in the background: change, test, one commit, then
// the reply draft. One fix per pull request at a time (the worktree is
// shared); core refuses a dirty or outdated worktree and undoes a failed run.
async function runFix(repo: string, pr: PullRequestDetail, thread: Thread): Promise<void> {
  const { number } = pr;
  const id = thread.root.id;
  const where = `${thread.root.path}:${thread.root.line ?? thread.root.original_line ?? "?"}`;
  if (!startTurn(repo, number, id, "fix")) return;
  setStatus(`Fixing ${where} of #${number} in ${pr.head}'s worktree in the background — keep working; the thread shows when it's done.`);
  try {
    const input = { number, head: pr.head_oid, author: pr.author, title: pr.title, comments: [thread.root, ...thread.replies] };
    const conversation = await threadFix(repo, input, pr.head, withClaudeChoice(loadThreadCommand("fix")), withClaudeChoice(loadThreadCommand("reply-draft")));
    finishTurn(repo, number, id, conversation);
    const commit = [...conversation.turns].reverse().find((t) => t.kind === "fix" && t.commit)?.commit?.slice(0, 7);
    reportDone(`Fixed ${where} of #${number}${commit ? ` in ${commit}` : ""}; the reply is ready.`);
  } catch (err) {
    if (isCancelled(err)) {
      finishTurn(repo, number, id, { error: "Cancelled; the worktree is back where it was." });
      setStatus(`Fix of ${where} of #${number} cancelled.`);
    } else {
      const title = `Couldn't fix ${where} of #${number}`;
      finishTurn(repo, number, id, { error: String(err) });
      setStatus(`${title}: ${String(err)}`);
      toast(title, { kind: "error", onDetails: () => showErrorDialog(title, String(err)) });
    }
    // A fix that committed but whose reply draft failed is still there.
    void loadThreadConversation(repo, number, id, true);
  }
}

// The pull requests a Push and reply all is in flight on (`repo\nnumber`):
// one at a time, so a second click can't post the same replies twice.
const pushReplyRuns = new Set<string>();

export function pushReplyInFlight(repo: string, number: number): boolean {
  return pushReplyRuns.has(`${repo}\n${number}`);
}

// Push the pull request's branch and post every reply Claude has ready,
// after one confirm that lists both. The push goes first; a push that fails
// posts nothing. A reply that fails to post is reported and stays ready.
// `edited`: what the Reply boxes hold, by thread, which wins over the kept
// draft of a thread that has one. Resolves with the threads whose reply was
// posted, or null when nothing was done.
async function pushAndReplyAll(repo: string, pr: PullRequestDetail, edited: Map<number, string>): Promise<number[] | null> {
  const { number } = pr;
  const key = `${repo}\n${number}`;
  if (pushReplyRuns.has(key)) return null;
  if (runningTurns(repo, number) > 0) {
    setStatus(`Claude is still working on #${number}: wait for it before pushing.`);
    return null;
  }
  pushReplyRuns.add(key);
  threadsChanged();
  try {
    return await pushAndReplyAllNow(repo, pr, edited);
  } finally {
    pushReplyRuns.delete(key);
    threadsChanged();
  }
}

async function pushAndReplyAllNow(repo: string, pr: PullRequestDetail, edited: Map<number, string>): Promise<number[] | null> {
  const { number } = pr;
  const roots = reviewThreads(pr.review_comments)
    .map((t) => t.root)
    .filter((root) => !pr.review_threads.find((t) => t.comment_ids.includes(root.id))?.resolved);
  const replies: (ReplyToPost & { id: number })[] = [];
  for (const root of roots) {
    let c: ThreadConversation | null;
    try {
      c = await threadConversation(repo, number, root.id);
    } catch (err) {
      opFailed(`Couldn't read Claude's conversation on ${root.path}`, err);
      continue;
    }
    setConversation(repo, number, root.id, c);
    // Only a thread with a reply ready posts: what its box holds, else the draft.
    const ready = preparedReply(c);
    const body = ready ? edited.get(root.id)?.trim() || ready.text : null;
    if (body) replies.push({ id: root.id, where: `${root.path}:${root.line ?? root.original_line ?? "?"}`, body });
  }
  // What the push sends, asked now: the cached ahead count can lag a fresh
  // fix commit, and a reply that says "fixed in X" must not go out alone.
  let commits: AheadCommit[];
  try {
    commits = await branchAheadLog(pr.head);
  } catch (err) {
    opFailed(`Couldn't tell what a push of ${pr.head} would send`, err);
    return null;
  }
  const branch = state.refs.branches.find((b) => b.name === pr.head);
  if (branch && !branch.has_upstream && replies.length) {
    opFailed(`${pr.head} has no upstream`, "Push it once by hand first, so Push and reply all knows what the pull request has.");
    return null;
  }
  const remote = branch?.upstream_remote ?? githubRemoteName(state.remoteList, state.prs.repo ?? "") ?? "origin";
  if (!commits.length && !replies.length) {
    setStatus(`Nothing to push or post on #${number}.`);
    return null;
  }
  if (!(await confirmDialog(pushAndReplyListing({ branch: pr.head, remote, number, commits, replies })))) {
    setStatus("Not pushed, nothing posted.");
    return null;
  }
  if (commits.length) {
    setStatus(`Pushing ${pr.head} to ${remote}…`);
    try {
      await pushBranch(pr.head, remote);
    } catch (err) {
      opFailed(`Couldn't push ${pr.head}; nothing was posted`, err);
      return null;
    }
  }
  const posted: number[] = [];
  for (const r of replies) {
    setStatus(`Posting the reply on ${r.where} of #${number}…`);
    try {
      const made = await replyToReviewComment(number, r.id, r.body);
      posted.push(r.id);
      await markReplyPosted(repo, number, r.id, made.url).catch((err) => opFailed(`Couldn't mark the reply on ${r.where} as posted`, err));
    } catch (err) {
      opFailed(`Couldn't post the reply on ${r.where} of #${number}; it stays ready`, err);
    }
    const s = threadState(repo, number, r.id);
    s.loaded = false;
    await loadThreadConversation(repo, number, r.id);
  }
  if (!commits.length && !posted.length) {
    setStatus(`Nothing posted on #${number}.`);
    return null;
  }
  const said = [commits.length ? `pushed ${pr.head}` : "", posted.length ? `posted ${posted.length} ${posted.length === 1 ? "reply" : "replies"}` : ""].filter(Boolean).join(" and ");
  reportDone(`${said.charAt(0).toUpperCase()}${said.slice(1)} on #${number}.`);
  ui.prView?.reload();
  return posted;
}

// Read the thread's saved conversation into its state, once — or again when
// `force`, after a failed turn that may have kept the question.
async function loadThreadConversation(repo: string, number: number, id: number, force = false): Promise<void> {
  const s = threadState(repo, number, id);
  if (s.loaded && !force) return;
  s.loaded = true;
  try {
    const c = await threadConversation(repo, number, id);
    if (c || force) {
      // After a failed turn the error (and Try again) stays on screen.
      setConversation(repo, number, id, c, { keepError: force });
      threadsChanged();
    }
  } catch (err) {
    // Stays loaded: a file that can't be read is reported once, not on
    // every redraw. A turn on the thread reads it again.
    readFailed("Couldn't read Claude's conversation", err);
  }
}

// --- Reviews in the background ---------------------------------------------

// Run the review command over pull request `number` of the repo at `repo`,
// in the background: the sidebar marks the pull request while it runs and
// when its drafts are ready, and the user can do anything else meanwhile —
// another pull request, another repo tab.
async function runReview(repo: string, number: number, head: string, command = loadReviewCommand()): Promise<void> {
  const r = prReview(repo, number);
  if (r.running) {
    setStatus(`A review of #${number} is already running.`);
    return;
  }
  if (prFixing.has(`${repo}\n${number}`)) {
    setStatus(`A fix is running on #${number}: review again once it's done.`);
    return;
  }
  r.running = true;
  r.error = null;
  reviewsChanged();
  setStatus(`Reviewing #${number} in the background — keep working; the pull request shows when it's done.`);
  try {
    const out = await generateReviewDrafts(repo, number, withClaudeChoice(command), command === SKILL_REVIEW_COMMAND ? "Review with Skill" : "Generate Drafts");
    setReviewedHead(repo, number, reviewedHeadIn(out.text) ?? head);
    const all = parseReviewFile(out.text);
    const found = unposted(repo, number, all);
    if (found.length === 0) {
      const said = all.length
        ? `The review of #${number} has nothing new: its ${all.length} finding${all.length === 1 ? " is" : "s are"} posted`
        : `The review of #${number} found nothing to comment on`;
      setStatus(`${said}.`);
      toast(said, {
        kind: "info",
        onDetails: () => showErrorDialog(`Review of #${number}`, clip(out.text)),
      });
    } else {
      // A new review replaces the last one, merged by place and text: what was
      // decided or fixed stays (pr-reviews.ts mergeDrafts).
      await loadStoredPrReview(repo, number);
      r.drafts = mergeDrafts(r.drafts, found);
      setReviewFile(repo, number, out.file);
      void refreshReviewFiles();
      reportDone(`Review of #${number} ready: ${found.length} draft comment${found.length === 1 ? "" : "s"} to approve or discard.`);
    }
  } catch (err) {
    if (isCancelled(err)) {
      setStatus(`Review of #${number} cancelled.`);
    } else {
      const title = `Couldn't review #${number}`;
      r.error = String(err);
      setStatus(`${title}: ${r.error}`);
      // No dialog: it may finish long after the user moved on to something else.
      toast(title, { kind: "error", onDetails: () => showErrorDialog(title, String(err)) });
    }
  } finally {
    r.running = false;
    reviewsChanged();
  }
}

const clip = (text: string) => (text.trim().length > 600 ? `${text.trim().slice(0, 600)}…` : text.trim());

// Read again the drafts of a review made before the app last quit, from the
// file it was saved to — or, opened from the Reviewed filter, its saved review.
async function restoreDrafts(repo: string, number: number): Promise<void> {
  // The drafts kept on disk come first: they carry the decisions and fixes.
  if (await loadStoredPrReview(repo, number)) {
    reviewsChanged();
    return;
  }
  // Before prReview: the first ask makes the review, and then nothing is remembered.
  const remembered = rememberedFile(repo, number);
  const file =
    remembered ??
    (state.prs.filter === "reviewed" && prReview(repo, number).drafts.length === 0 ? savedReview(number) : null);
  if (!file) return;
  const r = prReview(repo, number);
  try {
    const text = await readReviewFile(file);
    const head = reviewedHeadIn(text);
    if (head && !reviewedHead(repo, number)) setReviewedHead(repo, number, head);
    addDrafts(r, unposted(repo, number, parseReviewFile(text)));
    r.file = file;
  } catch {
    // Moved or deleted since: forget it.
    setReviewFile(repo, number, null);
  }
  reviewsChanged();
}

// --- Signing in and out -----------------------------------------------------

const INSTALL_GH = "brew install gh";

// Sign gh in to GitHub with its browser device flow: show the code gh prints,
// wait while the user approves it on GitHub, then reload the section. gitp
// never sees the token; gh keeps it.
export async function signInToGitHub(): Promise<void> {
  const account = await accountOrError();
  if (!account.installed) {
    showErrorDialog(
      "The GitHub CLI is not installed",
      `gitp signs in to GitHub and reads pull requests through the GitHub CLI (gh).\n\nInstall it, then sign in again:\n\n    ${INSTALL_GH}`,
      { label: "Copy Command", run: () => void copyText(INSTALL_GH, `Copied ${INSTALL_GH}`) },
    );
    return;
  }
  setStatus("Starting the GitHub sign-in…");
  let device;
  try {
    device = await ghLoginStart();
  } catch (err) {
    opFailed("Couldn't start the GitHub sign-in", err);
    return;
  }
  let cancelled = false;
  const dialog = openSignInDialog(device.code, device.url, {
    openUrl: () => void openUrl(device.url),
    cancel: () => {
      cancelled = true;
      void ghLoginCancel();
    },
  });
  setStatus(`Enter ${device.code} at ${device.url} to sign in.`);
  try {
    const said = await ghLoginWait();
    dialog.close();
    reportDone(said ? `Signed in to GitHub. ${said}` : "Signed in to GitHub.");
  } catch (err) {
    dialog.close();
    if (cancelled || isCancelled(err)) setStatus("GitHub sign-in cancelled.");
    else opFailed("GitHub sign-in failed", err);
    return;
  }
  await loadPullRequests(true);
}

export async function signOutOfGitHub(): Promise<void> {
  const login = state.prs.account?.login ?? null;
  const who = login ? ` (${login})` : "";
  if (!(await confirmDialog(`Sign gh out of GitHub${who}?\n\nThis signs out the GitHub CLI everywhere it is used, not only in gitp.`))) {
    return;
  }
  try {
    const said = await ghLogout(login);
    reportDone(said || "Signed out of GitHub.");
  } catch (err) {
    opFailed("Couldn't sign out of GitHub", err);
  }
  state.prs.list = null;
  await loadPullRequests(true);
}

// The account for Settings, fresh from gh.
export async function githubAccountForSettings(): Promise<GhAccount> {
  const account = await accountOrError();
  state.prs.account = account;
  renderSidebarNow();
  return account;
}

// --- Review drafts kept on disk, and Fix on your own pull request -------------

// The pull requests whose saved drafts were read (or found missing) this run.
const storedLoaded = new Set<string>();

// Read pull request `number`'s drafts from disk once, before anything could
// save over them; true when they were loaded now.
async function loadStoredPrReview(repo: string, number: number): Promise<boolean> {
  const key = `${repo}\n${number}`;
  if (storedLoaded.has(key)) return false;
  storedLoaded.add(key);
  try {
    const stored = await storedReviewLoad(repo, { pr: number });
    // Not prReview before this: asking makes the review, and then the review
    // file remembered from an earlier run is no longer offered.
    if (!stored || prReview(repo, number).drafts.length) return false;
    applyStored(repo, { pr: number }, stored);
    return true;
  } catch (err) {
    readFailed("Couldn't read the saved review drafts", err);
    return false;
  }
}

// The fix running on each pull request (`repo\nnumber` → draft id).
const prFixing = new Map<string, number>();

// Fix on the drafts of a pull request the signed-in user wrote; null on
// anyone else's (the author fixes).
function prDraftFix(repo: string, pr: PullRequestDetail): { reason: (d: Draft) => string | null; run: (d: Draft) => void } | null {
  if (!canFixDrafts(state.prs.account?.login, pr.author)) return null;
  return {
    reason: (d) => {
      if (!isOpen(d)) return d.status === "fixed" ? "Fixed already" : "Discarded";
      if (prFixing.has(`${repo}\n${pr.number}`)) return `A fix is running on ${pr.head}`;
      if (prReview(repo, pr.number).running) return "A review is running on this pull request";
      if (!worktreeOf(pr.head)) return `Check ${pr.head} out first`;
      return null;
    },
    run: (d) => void fixPrDraft(repo, pr, d),
  };
}

// Fix draft `d` of `pr` in the worktree of its branch, in the background:
// one commit there, the draft marked fixed; the commit goes out with Push and
// reply all.
async function fixPrDraft(repo: string, pr: PullRequestDetail, d: Draft): Promise<void> {
  const key = `${repo}\n${pr.number}`;
  if (prFixing.has(key)) return;
  const where = `${d.path}:${d.line}`;
  prFixing.set(key, d.id);
  reviewsChanged();
  setStatus(`Fixing ${where} of #${pr.number} in ${pr.head}'s worktree in the background — keep working; the draft shows when it's done.`);
  try {
    await loadStoredPrReview(repo, pr.number);
    await flushSaves();
    const files = await fetchPullRequestFiles(pr.number).catch(() => []);
    const stored = await reviewDraftFix(
      repo,
      { pr: pr.number },
      d.id,
      {
        path: d.path,
        line: d.line,
        side: d.side,
        body: d.body,
        severity: d.severity,
        diff_hunk: hunkAround(files, d.path, d.line, d.side),
        branch: pr.head,
        base: pr.base,
        pr: pr.number,
        pr_head: pr.head_oid,
      },
      withClaudeChoice(loadThreadCommand("fix")),
    );
    applyStored(repo, { pr: pr.number }, stored);
    const commit = stored.drafts.find((x) => x.id === d.id)?.fix?.commit.slice(0, 7);
    reportDone(`Fixed ${where} of #${pr.number}${commit ? ` in ${commit}` : ""}; push it with Push and reply all.`);
    void loadSidebar();
  } catch (err) {
    if (isCancelled(err)) setStatus(`Fix of ${where} of #${pr.number} cancelled; the worktree is back where it was.`);
    else {
      const title = `Couldn't fix ${where} of #${pr.number}`;
      setStatus(`${title}: ${String(err)}`);
      toast(title, { kind: "error", onDetails: () => showErrorDialog(title, String(err)) });
    }
  } finally {
    prFixing.delete(key);
    reviewsChanged();
  }
}
