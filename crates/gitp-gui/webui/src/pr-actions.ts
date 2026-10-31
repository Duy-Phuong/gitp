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
  confirmDialog,
  createPullRequestOnGitHub,
  fetchPullRequest,
  fetchPullRequestFiles,
  generateReviewDrafts,
  ghAccount,
  ghLoginCancel,
  ghLoginStart,
  ghLoginWait,
  ghLogout,
  ghRepo,
  githubRepoSettings,
  isCancelled,
  listPullRequests,
  mergePullRequest,
  openGithubUrl,
  pickReviewFile,
  pullRequestDraft,
  pushBranch,
  readReviewFile,
  replyToReviewComment,
  reviewPullRequest,
  reviewWithComments,
} from "./api";
import { state, ui } from "./app-state";
import { copyText } from "./clipboard";
import { opFailed, readFailed, reportDone, setStatus } from "./report";
import { loadRepo, loadSidebar, refreshHistory, renderSidebarNow, showPullRequest, showView } from "./shell";
import { defaultWorktreePath } from "./worktree-actions";
import { parseReviewFile } from "./review-drafts";
import { loadReviewCommand } from "./prefs";
import { showContextMenu, showPrompt } from "./views/context-menu";
import { openFormDialog } from "./views/form-dialog";
import { showErrorDialog } from "./views/message-dialog";
import { openSignInDialog } from "./views/github-sign-in";
import type { PullRequestCallbacks } from "./views/pull-request";
import { baseBranches, githubRemoteName, mergeAdvice, mergeChoices } from "./pull-requests";
import type { BranchRef, GhAccount, MergeMethod, PrFilter, PullRequest, PullRequestDetail, ReviewVerdict } from "./types";

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
  if (!repo) {
    state.prs.list = null;
    renderSidebarNow();
    return;
  }
  state.prs.loading = true;
  renderSidebarNow();
  if (!state.prs.account || recheckAccount) state.prs.account = await accountOrError();
  if (stale()) return;
  const account = state.prs.account;
  if (account.installed && account.signed_in) {
    try {
      const list = await listPullRequests(filter);
      if (stale()) return;
      state.prs.list = list;
    } catch (err) {
      if (stale()) return;
      state.prs.error = String(err);
    }
  }
  state.prs.loading = false;
  renderSidebarNow();
}

// gh's account, or — when even asking failed — a signed-out one saying why.
async function accountOrError(): Promise<GhAccount> {
  try {
    return await ghAccount();
  } catch (err) {
    return { installed: true, signed_in: false, login: null, scopes: [], message: String(err) };
  }
}

export function setPrFilter(filter: PrFilter): void {
  if (filter === state.prs.filter) return;
  state.prs.filter = filter;
  state.prs.list = null;
  void loadPullRequests();
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
  setStatus("");
  openFormDialog(
    {
      title: `Create Pull Request from ${b.name}`,
      sub: unpushed ? `On ${repo}. ${b.name} is pushed to ${remote} first.` : `On ${repo}.`,
      fields: [
        { label: "Into", choices: bases.map((n) => ({ value: n, label: n })), value: fallback },
        { label: "Title", value: draft.title, required: true },
        { label: "Description", value: draft.body, multiline: true, placeholder: "Markdown" },
        {
          label: "As",
          choices: [
            { value: "ready", label: "Ready for review" },
            { value: "draft", label: "Draft" },
          ],
        },
      ],
      submitLabel: "Create Pull Request",
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
        { label: "How", choices, value: choices[0].value },
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
  fetchDetail: fetchPullRequest,
  fetchFiles: fetchPullRequestFiles,
  checkout: (pr) => void checkoutPullRequestAction(pr.number),
  checkoutInWorktree: (pr, x, y) =>
    showPrompt(x, y, {
      placeholder: "Folder for the new worktree",
      value: defaultWorktreePath(pr.head),
      onSubmit: (path) => void checkoutPullRequestInWorktreeAction(pr.number, path),
    }),
  reviewMenu: (pr, x, y) => reviewMenu(pr.number, x, y),
  merge: mergeAction,
  openUrl: (url) => void openUrl(url),
  comment: (pr, body) => post("a comment", pr.number, body, () => commentOnPullRequest(pr.number, body)),
  reply: (pr, root, body) =>
    post(`a reply to ${root.author}`, pr.number, body, async () => (await replyToReviewComment(pr.number, root.id, body)).url),
  lineComment: (pr, comment) =>
    post(`a comment on ${comment.path}:${comment.line}`, pr.number, comment.body, async () => (await commentOnLine(pr.number, comment)).url),
  loadDrafts: async () => {
    const path = await pickReviewFile();
    if (!path) return null;
    try {
      const drafts = parseReviewFile(await readReviewFile(path));
      if (drafts.length === 0) {
        showErrorDialog(
          "No review comments found",
          `${path} has no finding with a "### path/to/file:line" heading and a comment, and is not a JSON list of {path, line, body}.`,
        );
        return null;
      }
      setStatus(`Loaded ${drafts.length} draft comment${drafts.length === 1 ? "" : "s"} from ${path}.`);
      return drafts;
    } catch (err) {
      readFailed("Couldn't read the review file", err);
      return null;
    }
  },
  generateDrafts: async (pr) => {
    setStatus(`Generating review drafts for #${pr.number}… (Cancel in the status bar stops it)`);
    try {
      const out = await generateReviewDrafts(pr.number, loadReviewCommand());
      const drafts = parseReviewFile(out);
      if (drafts.length === 0) {
        const head = out.trim().length > 600 ? `${out.trim().slice(0, 600)}…` : out.trim();
        showErrorDialog(
          "No draft comments in the review command's output",
          `It printed no "### path/to/file:line" block and no JSON list of {path, line, body}:\n\n${head}`,
        );
        setStatus("The review command found nothing to comment on.");
        return null;
      }
      reportDone(`Generated ${drafts.length} draft comment${drafts.length === 1 ? "" : "s"} for #${pr.number}.`);
      return drafts;
    } catch (err) {
      opFailed(`Couldn't generate review drafts for #${pr.number}`, err);
      return null;
    }
  },
  postReview: (pr, verdict, body, comments) => {
    const what = `a review with ${comments.length} comment${comments.length === 1 ? "" : "s"}`;
    const preview = comments.map((c) => `${c.path}:${c.line} — ${c.body.split("\n")[0]}`).join("\n");
    return post(what, pr.number, body.trim() ? `${body}\n\n${preview}` : preview, () => reviewWithComments(pr.number, verdict, body, comments));
  },
  reportError: readFailed,
};

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
