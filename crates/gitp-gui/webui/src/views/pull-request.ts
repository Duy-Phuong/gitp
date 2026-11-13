// The pull request view: a GitHub pull request's title, state, branches,
// labels and actions, then three tabs — the conversation (description,
// comments, reviews and line-comment threads in time order, with a box to
// comment), the changed files as diffs — unified or side by side, filtered by
// a search of their names and code, with each line's threads under it (click
// a line to comment on it) — and the checks.
//
// Everything in it came from GitHub and was written by other people, so none
// of it goes through innerHTML: Markdown is rendered by markdown-preview.ts,
// which builds text nodes, and the rest is set as text.

import { clear, el, menuCaret, svg } from "../dom";
import { DRAFT_KEYS } from "../shortcuts";
import { showContextMenu, type MenuItem } from "./context-menu";
import { renderGitHubMarkdown } from "./github-markdown";
import { conversationNode, threadBadges, threadClaudeButtons } from "./thread-claude";
import { fixDisabledReason, fixRunningOn, needsCheck, ordinal, preparedReply, queuedFixes, queuePosition, runningTurns, threadState } from "../pr-threads";
import { storedThread } from "../thread-search";
import { composerArea, previewToggle } from "./composer";
import { iconBtn, renderFile, renderSplitDiff, WRAP_ICON } from "./detail";
import {
  loadDiffWrap,
  loadJiraSite,
  loadPrCollapseComments,
  loadPrDiffSplit,
  loadPrFilesTree,
  saveDiffWrap,
  savePrCollapseComments,
  savePrDiffSplit,
  savePrFilesTree,
} from "../prefs";
import { storePullRequest, storedPullRequest } from "../pr-store";
import { whenPointedAt } from "../read-ahead";
import { prSuggestions, suggestionOf, type Suggestion } from "../suggestions";
import { jiraKeyIn, jiraTicketUrl } from "../jira";
import { renderFileTree } from "./tree";
import { openReviewerPicker } from "./reviewer-picker";
import {
  checksSummary,
  isoSeconds,
  lineKey,
  lineTarget,
  prTimeline,
  quoteReply,
  reviewDecisionLabel,
  reviewerRows,
  type ReviewerState,
  approvalCount,
  hasConflicts,
  reviewThreads,
  reviewVerb,
  searchFiles,
  threadsByLine,
  threadsPerFile,
  type Thread,
} from "../pull-requests";
import { fullTime, relativeTime } from "../timeago";
import { copyText } from "../clipboard";
import { checkAnchor, withOffDiffDrafts } from "../review-drafts";
import { draftCard, fixedByNotes, placeDraftCards, type DraftCardOptions } from "./draft-cards";
import { draftFoldText, threadFoldText } from "../comment-fold";
import {
  clearDrafts,
  hasNewCommits,
  isOpen,
  nothingLeftAfterPost,
  saveSoon,
  markPosted,
  prReview,
  reviewsChanged,
  setReviewedHead,
  type Draft,
  type PrReview,
} from "../pr-reviews";
import type { CommitDetail, FileDiff, LineComment, PrLabel, PrReviewComment, PrReviewThread, PrSignature, PrViewed, PullRequestDetail, ReviewVerdict, TurnKind } from "../types";
import { pausePollingFor, startPolling } from "../poller";
import { isRateLimit, NOTICE_MS, PR_VIEW_POLL_MS, RATE_LIMIT_NOTICE, RATE_LIMIT_PAUSE_MS, refreshNotice, signatureChanged } from "../pr-refresh";

export interface PullRequestCallbacks {
  fetchDetail: (number: number) => Promise<PullRequestDetail>;
  // The cheap signature polled every 30 s while the view is open; no polling
  // without it.
  fetchSignature?: (number: number) => Promise<PrSignature>;
  fetchFiles: (number: number) => Promise<FileDiff[]>;
  // The files marked Viewed on GitHub, and marking one (by the pull
  // request's node id); without them the Files tab has no Viewed boxes.
  fetchViewed?: (number: number) => Promise<PrViewed>;
  setViewed?: (prId: string, path: string, viewed: boolean) => Promise<void>;
  // A commit's changed files, from GitHub.
  fetchCommitFiles: (oid: string) => Promise<FileDiff[]>;
  checkout: (pr: PullRequestDetail) => void;
  // Asks for the folder at (x, y), then checks out there.
  checkoutInWorktree: (pr: PullRequestDetail, x: number, y: number) => void;
  // Approve / Request Changes / Comment, from a menu at (x, y).
  reviewMenu: (pr: PullRequestDetail, x: number, y: number) => void;
  // Asks how, then merges on GitHub and reloads the view.
  merge: (pr: PullRequestDetail) => void;
  // Shows it in a tab of its own, across the whole window, and back.
  openInTab: (pr: PullRequestDetail) => void;
  leaveTab: (pr: PullRequestDetail) => void;
  openUrl: (url: string) => void;
  // Each posts after the user confirms, resolving true once it's on GitHub;
  // the view then reloads the conversation.
  comment: (pr: PullRequestDetail, body: string) => Promise<boolean>;
  reply: (pr: PullRequestDetail, root: PrReviewComment, body: string) => Promise<boolean>;
  // Marks a thread resolved (or open again); true once done.
  resolve: (pr: PullRequestDetail, thread: PrReviewThread, resolve: boolean) => Promise<boolean>;
  lineComment: (pr: PullRequestDetail, comment: LineComment) => Promise<boolean>;
  // Loads the pull request's saved review, or a picked file, into its drafts;
  // false when nothing was loaded (the caller has reported why).
  loadDrafts: (pr: PullRequestDetail) => Promise<boolean>;
  // The pull request's saved review page, if any, and opening it.
  savedReview: (number: number) => string | null;
  openReviewPage: (path: string) => void;
  // Reads it inside gitp, with "Explain more" on each finding.
  readReview: (pr: PullRequestDetail, path: string) => void;
  // The repo the pull requests belong to: their reviews are kept by it.
  repoPath: () => string;
  // How many commits local branch `name` is ahead of its upstream; 0 when
  // unknown.
  branchAhead: (name: string) => number;
  // The head commit the pull request was last reviewed at, if known.
  reviewedHead: (number: number) => string | null;
  // Starts the review command over the diff in the background; its drafts
  // land in the pull request's review (pr-reviews.ts), and the view is told.
  generateDrafts: (pr: PullRequestDetail) => void;
  // The same with the review skill, whatever the Review command preset.
  generateDraftsWithSkill: (pr: PullRequestDetail) => void;
  cancelReview: (pr: PullRequestDetail) => void;
  // Reads again the drafts of a review saved before the app last quit.
  restoreDrafts: (number: number) => void;
  // Shows the review page the drafts came from in the file manager.
  showReviewFile: (path: string) => void;
  // Posts one review with `comments` after the user confirms; true once it is
  // on GitHub.
  postReview: (pr: PullRequestDetail, verdict: ReviewVerdict, body: string, comments: LineComment[]) => Promise<boolean>;
  // Claude on a thread (pr-threads.ts): runs a turn in the background and
  // the view redraws from the thread's state; loads the saved conversation
  // once; forgets it after the user confirms; prunes the old ones.
  threadTurn: (pr: PullRequestDetail, thread: Thread, kind: TurnKind, userText: string) => void;
  // Check all of `threads` in one Claude run (Check N Comments).
  checkAll: (pr: PullRequestDetail, threads: Thread[]) => void;
  // Fix the thread as the chosen option says, in the branch's worktree,
  // commit, and prepare the reply; drop a prepared reply after a confirm.
  fixThread: (pr: PullRequestDetail, thread: Thread) => void;
  // Apply review suggestions in the branch's worktree, as one commit.
  applySuggestions?: (pr: PullRequestDetail, suggestions: Suggestion[]) => Promise<void>;
  // Merge the base in the branch's worktree, let Claude resolve the
  // conflicts and show them for an approve (commit and push) or a discard;
  // true once pushed.
  resolveConflicts?: (pr: PullRequestDetail) => Promise<boolean>;
  // Ask for reviews (again) and take requests back, as logins or org/team;
  // true once done. The people a review can be asked of.
  setReviewers?: (pr: PullRequestDetail, add: string[], remove: string[]) => Promise<boolean>;
  assignableUsers?: () => Promise<string[]>;
  // Save the chosen option on the thread, for Fix to take; false when it
  // couldn't (reported).
  chooseOption: (pr: PullRequestDetail, thread: Thread, text: string) => Promise<boolean>;
  // True once dropped.
  dropReply: (pr: PullRequestDetail, thread: Thread) => Promise<boolean>;
  // Pushes the branch and posts every reply Claude has ready, after one
  // confirm; `edited` is what the Reply boxes hold. The threads whose reply
  // was posted, or null when nothing was done.
  pushAndReplyAll: (pr: PullRequestDetail, edited: Map<number, string>) => Promise<number[] | null>;
  pushReplyInFlight: (pr: PullRequestDetail) => boolean;
  cancelThreadTurn: (pr: PullRequestDetail, thread: Thread) => void;
  loadThreadConversation: (pr: PullRequestDetail, thread: Thread) => void;
  // True once forgotten; false when the user said no or it failed.
  clearThreadConversation: (pr: PullRequestDetail, thread: Thread) => Promise<boolean>;
  pruneThreadConversations: () => void;
  // Fix on the review drafts of a pull request the signed-in user wrote
  // (null on anyone else's): why it is off for a draft, or null; and the run.
  draftFix: (pr: PullRequestDetail) => { reason: (d: Draft) => string | null; run: (d: Draft) => void } | null;
  // Explain more on a draft's finding of the saved review, and how it went.
  explainDraft: (pr: PullRequestDetail, d: Draft) => void;
  draftExplaining: (pr: PullRequestDetail, d: Draft) => { running: boolean; failed: string | null };
  // Shows a commit in History.
  openCommit: (sha: string) => void;
  // Take a waiting fix off the pull request's queue.
  cancelQueuedFix: (pr: PullRequestDetail, thread: number, where: string) => void;
  // A commit's files and diff: a fix's, shown under its turn.
  loadCommit?: (sha: string) => Promise<CommitDetail>;
  // Asks before a draft replaces what the user typed.
  confirm: (message: string) => Promise<boolean>;
  reportError: (title: string, err: unknown) => void;
}

export interface PullRequestHandle {
  // Load and show pull request `number`.
  show: (number: number) => void;
  // The header buttons' actions, for Quick Launch: run the review command, or
  // pick a review file, into the Drafts tab of the pull request on screen.
  generateDrafts: () => void;
  generateDraftsWithSkill: () => void;
  pushAndReplyAll: () => void;
  loadReviewFile: () => void;
  // Read it again from GitHub — after a review posted from the menu, say.
  reload: () => void;
  // The conversation search opened thread `thread` (a root comment id) of the
  // pull request just shown: its block open, scrolled to — or, gone from
  // GitHub, its stored conversation on top of the Conversation tab.
  focusThread: (thread: number) => void;
  // Draw it again from what it holds: a review in the background moved on.
  redraw: () => void;
  // Forget it: the repo it belongs to is no longer the active one.
  reset: () => void;
}

type Tab = "conversation" | "commits" | "files" | "checks" | "drafts";

// How many pull requests shown before are kept, to draw again at once.
const SEEN_MAX = 8;

// A line comment being written in the Files tab: where, the code that was on
// the line when it was clicked, and the text so far.
interface LineDraft {
  path: string;
  side: "LEFT" | "RIGHT";
  line: number;
  content: string;
  text: string;
}

// A page with lines: the saved review page.
const REVIEW_PAGE_ICON = ["M6 3h9l4 4v14H6z", "M14 3v5h5", "M9 12h7", "M9 16h7"];
// An open book: the saved review, read inside gitp.
const READ_REVIEW_ICON = ["M3 5c3-1 6-1 9 1v14c-3-2-6-2-9-1z", "M21 5c-3-1-6-1-9 1v14c3-2 6-2 9-1z"];
// A box with an arrow out of it: the pull request on GitHub.
const PR_LINK_ICON = ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"];
// A ticket: a tag with a hole.
const JIRA_ICON = ["M20.6 13.4l-7.2 7.2a1 1 0 0 1-1.4 0L3 11.6V4a1 1 0 0 1 1-1h7.6l9 9a1 1 0 0 1 0 1.4z", "M7.5 7.5h.01"];
// A circling arrow, as on the top bar's Refresh.
const REFRESH_ICON = "M20 11a8 8 0 10-.6 4M20 4v5h-5";
// Arrows to the corners: the pull request in a tab of its own.
const TAB_ICON = ["M15 3h6v6", "M21 3l-7 7", "M9 21H3v-6", "M3 21l7-7"];
// Arrows from the corners: back to the usual layout.
const LEAVE_TAB_ICON = ["M20 10h-6V4", "M14 10l7-7", "M4 14h6v6", "M10 14l-7 7"];

export function setupPullRequestView(host: HTMLElement, cb: PullRequestCallbacks): PullRequestHandle {
  let number: number | null = null;
  let detail: PullRequestDetail | null = null;
  let files: FileDiff[] | null = null;
  let tab: Tab = "conversation";
  // The Commits tab: the commit whose files are on screen, if one is, and
  // the files of each commit read so far.
  let commitOpen: string | null = null;
  const commitFiles = new Map<string, FileDiff[]>();
  // Those being read: the one opened, its neighbours read ahead, and one
  // the pointer rests on in the list.
  const commitReads = new Map<string, Promise<FileDiff[]>>();
  // Drops an answer for a pull request that is no longer the one on screen.
  let generation = 0;
  // The comment box at the bottom of the conversation, kept across re-renders
  // so a reload doesn't throw away what's being written.
  let draft = "";
  // The Files tab's search, kept across re-renders (a layout switch).
  let filesQuery = "";
  // The Drafts tab's filters: by where a draft stands, and by severity.
  let draftShow: DraftShow = "all";
  let draftSeverity: string | null = null;
  // The draft the Drafts tab's keys act on (its id); the first card shown
  // when none is.
  let draftCursor: number | null = null;

  // The Drafts tab's keys (DRAFT_KEYS in shortcuts.ts), as its cards' own
  // buttons: j / k move between the cards shown, the others press a button
  // of the marked card.
  document.addEventListener("keydown", (e) => {
    if (!draftKeysAllowed(e)) return;
    const cards = [...host.querySelectorAll<HTMLElement>(".pr-draft[data-draft]:not(.inline)")];
    if (!cards.length) return;
    const at = Math.max(0, cards.findIndex((c) => Number(c.dataset.draft) === draftCursor));
    const bound = DRAFT_KEYS.find((k) => k.keys.includes(e.key));
    if (!bound) return;
    const move = bound.move ?? 0;
    if (move) {
      const next = cards[Math.min(cards.length - 1, Math.max(0, draftCursor === null ? 0 : at + move))];
      e.preventDefault();
      pointAt(next);
      next.scrollIntoView({ block: "nearest" });
      return;
    }
    const want = bound.buttons ?? [];
    const card = cards[at];
    const b = [...card.querySelectorAll<HTMLButtonElement>("button")].find((x) => want.includes(x.textContent ?? "") && !x.disabled);
    if (!b) return;
    e.preventDefault();
    draftCursor = Number(card.dataset.draft);
    b.click();
  });

  // Whether a bare key belongs to the Drafts tab now: it is on screen, nothing
  // is layered over it, and no one is typing.
  function draftKeysAllowed(e: KeyboardEvent): boolean {
    if (tab !== "drafts" || !detail || !host.isConnected || host.offsetParent === null) return false;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
    if (document.querySelector(".modal-overlay, .ql-overlay, .commit-menu, .menu:not(.hidden)")) return false;
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.closest("#terminal-host"))) return false;
    return true;
  }

  // Mark `card` as the one the keys act on.
  function pointAt(card: HTMLElement): void {
    for (const c of host.querySelectorAll(".pr-draft.cursor")) c.classList.remove("cursor");
    card.classList.add("cursor");
    draftCursor = Number(card.dataset.draft);
  }
  let split = loadPrDiffSplit();
  // The folder tree beside the diffs: shown or not, which folders are folded,
  // and the file last picked in it.
  let treeShown = loadPrFilesTree();
  // "Collapse comments", and the comments opened one by one while it is on
  // ("t<root id>" for a thread, "d<id>" for a draft), kept across redraws.
  let commentsCollapsed = loadPrCollapseComments();
  const openComments = new Set<string>();
  // The pull requests "Resolve Conflicts with Claude" is running for.
  const resolvingConflicts = new Set<number>();
  const treeCollapsed = new Set<string>();
  let treeSelected: string | null = null;
  // The Files tab's Viewed marks on GitHub, read once per pull request and
  // head (a push takes the marks off the files it changed); null until read.
  let viewed: { number: number; id: string; paths: Set<string> } | null = null;
  let viewedReading: number | null = null;
  // The Files tab drawn last: draws the files up to one, for a jump to it.
  let drawFile: ((path: string) => void) | null = null;
  // The pull request's draft comments, with the verdict and message the
  // review they'll be posted in will carry. Kept by repo and number outside
  // the view, so they wait while another pull request is open.
  const review = (): PrReview => prReview(cb.repoPath(), number ?? 0);
  // Opened with no drafts yet and no tab picked: drafts read back from a saved
  // review a moment later open the Drafts tab.
  let draftsWhenReady = false;
  // Claude on the threads (pr-threads.ts): which conversation blocks are
  // open, by root comment id; what each thread last ran, so a turn that just
  // finished opens its block and a failed one can be tried again; the threads
  // whose Reply with Claude is to land in the Reply box; and whether the old
  // conversations were pruned yet for this repo.
  // The tab drawn last, so a redraw of the same one keeps its scroll.
  let renderedTab: Tab | null = null;
  const openBlocks = new Set<number>();
  const lastKind = new Map<number, TurnKind>();
  // Reply with Claude: how many turns the thread had when it was clicked, so
  // only a draft newer than that lands in the Reply box.
  const pendingReplyDraft = new Map<number, number>();
  let prunedFor: string | null = null;
  // The thread the conversation search opened: scrolled to once drawn; and
  // kept while the pull request is on screen, for one gone from GitHub.
  let focus: number | null = null;
  let searched: number | null = null;
  // What is typed in a thread's Reply box and follow-up box, by root comment
  // id, and which Reply boxes are open: a redraw (a turn ending on any
  // thread) keeps them, as `draft` keeps the bottom composer.
  const replyOpen = new Set<number>();
  const replyText = new Map<number, string>();
  const followupText = new Map<number, string>();
  // The Files tab's open line comment boxes and what they hold, by lineKey,
  // so a redraw opens them again (or, for a line no longer in the diff,
  // keeps the text in a box at the top of its file).
  const lineDrafts = new Map<string, LineDraft>();
  // Refreshing on its own (pr-refresh.ts): the signature last seen, the
  // poll's stop, the notice at the top, and a redraw waiting for a text box
  // to lose focus.
  let signature: PrSignature | null = null;
  let stopPolling: (() => void) | null = null;
  let notice: { text: string; timer: ReturnType<typeof setTimeout> } | null = null;
  let waiting: { run: () => void; gen: number } | null = null;
  // The user's own loads in flight: a poll meanwhile would announce them.
  let loads = 0;
  // Pull requests shown before, newest last: one opened again is drawn at
  // once from what it showed, then read afresh. For the repository on screen.
  const seen = new Map<number, { detail: PullRequestDetail; files: FileDiff[] | null }>();
  // The changed files being read, shared by the read ahead, the Files tab
  // and the Drafts tab, so each pull request's diff is asked for once.
  let filesLoading: { number: number; head: string; promise: Promise<FileDiff[]> } | null = null;

  const message = (text: string) => {
    clear(host);
    host.append(el("div", { class: "pr-view" }, [el("div", { class: "pr-empty", text })]));
  };

  async function load(keepFiles: boolean): Promise<void> {
    if (number === null) return;
    const mine = ++generation;
    if (!detail || detail.number !== number) message(`Loading pull request #${number}…`);
    if (!keepFiles) files = null;
    // The user's own reloads set the signature quietly: no notice for them.
    loads++;
    try {
      const d = await cb.fetchDetail(number);
      if (mine !== generation) return;
      // Files kept from before are another head's when it moved, and so
      // are the Viewed marks GitHub took off the files it changed.
      if (detail?.head_oid !== d.head_oid) {
        files = null;
        viewed = null;
      }
      detail = d;
      signature = d.signature ?? null;
      storePullRequest(cb.repoPath(), d);
      toDraftsIfReady();
      if (tab === "drafts" && !files) void showDrafts(d);
      else render();
      if (!files) readAhead(d);
    } catch (err) {
      if (mine !== generation) return;
      message(`Couldn't load pull request #${number}.`);
      cb.reportError(`Couldn't load pull request #${number}`, err);
    } finally {
      loads--;
    }
  }

  // The changed files of `pr`, read once however many ask.
  function readFiles(pr: PullRequestDetail): Promise<FileDiff[]> {
    if (filesLoading?.number === pr.number && filesLoading.head === pr.head_oid) return filesLoading.promise;
    const promise = cb.fetchFiles(pr.number);
    const loading = { number: pr.number, head: pr.head_oid, promise };
    filesLoading = loading;
    const done = () => {
      if (filesLoading === loading) filesLoading = null;
    };
    promise.then(done, done);
    return promise;
  }

  // Read the changed files while the user reads the conversation: the Files
  // tab then opens with no wait.
  function readAhead(pr: PullRequestDetail): void {
    readFiles(pr).then(
      (loaded) => {
        if (!files && number === pr.number && detail?.head_oid === pr.head_oid) files = loaded;
      },
      () => {
        // The Files tab asks again, and says so when it fails.
      },
    );
  }

  // Keep what the pull request on screen shows, for when it is opened again.
  function remember(): void {
    if (number === null || !detail || detail.number !== number) return;
    seen.delete(number);
    seen.set(number, { detail, files });
    while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value!);
  }

  function render(): void {
    if (!detail) return;
    const pr = detail;
    // A redraw of the same tab keeps the scroll position: a turn ending on a
    // thread must not jump the view to the top. Restored once the tab's
    // content is in place — an empty body can't scroll — and not on a tab
    // switch, which starts at the top.
    const scrolled = renderedTab === tab ? (host.querySelector<HTMLElement>(".pr-body")?.scrollTop ?? 0) : 0;
    renderedTab = tab;
    const restore = (body: HTMLElement) => {
      if (scrolled) body.scrollTop = scrolled;
    };
    clear(host);
    const body = el("div", { class: "pr-body" });
    // A link in a description or comment opens in the browser (see
    // renderGitHubMarkdown).
    body.addEventListener("click", (e) => {
      const link = (e.target as HTMLElement).closest<HTMLElement>(".github-markdown [data-href]");
      if (link?.dataset.href) cb.openUrl(link.dataset.href);
    });
    const tabs = el("div", { class: "pr-tabs" });
    const tabButton = (t: Tab, label: string) => {
      const b = el("button", { class: `pr-tab${tab === t ? " active" : ""}`, text: label });
      b.addEventListener("click", () => {
        tab = t;
        draftsWhenReady = false;
        render();
      });
      return b;
    };
    tabs.append(
      tabButton("conversation", `Conversation (${prTimeline(pr).length})`),
      tabButton("commits", `Commits (${pr.commits.length})`),
      tabButton("files", `Files changed (${pr.changed_files})`),
      tabButton("checks", `Checks (${pr.checks.length})`),
      ...(review().drafts.length
        ? [tabButton("drafts", `Drafts (${review().drafts.filter((d) => draftStanding(d) === "open").length})`)]
        : []),
    );
    host.append(el("div", { class: "pr-view" }, [header(pr), tabs, body]));
    if (tab === "conversation") renderConversation(body, pr);
    else if (tab === "files") void renderFiles(body, pr, scrolled).then(() => restore(body));
    else if (tab === "commits") renderCommits(body, pr);
    else if (tab === "drafts") renderDrafts(body, pr);
    else renderChecks(body, pr);
    restore(body);
    if (focus !== null && tab === "conversation") {
      body.querySelector<HTMLElement>(`[data-thread="${focus}"]`)?.scrollIntoView({ block: "start" });
      focus = null;
    }
    drawNotice();
  }

  // --- Refreshing on its own ------------------------------------------------

  // One poll: the signature, and when it moved, the pull request read again
  // and drawn — once no text box in the view has focus.
  async function poll(): Promise<void> {
    const n = number;
    const mine = generation;
    const stale = () => mine !== generation || loads > 0;
    if (n === null || !cb.fetchSignature || host.closest(".hidden") || stale()) return;
    try {
      const now = await cb.fetchSignature(n);
      if (stale() || !now) return;
      if (!signatureChanged(signature, now)) {
        signature = now;
        return;
      }
      const d = await cb.fetchDetail(n);
      if (stale()) return;
      const old = detail;
      signature = now;
      detail = d;
      if (old && old.head_oid !== d.head_oid) {
        files = null;
        viewed = null;
      }
      const text = old ? refreshNotice(old, d) : "Updated";
      whenIdle(() => {
        redraw();
        showNotice(text);
      });
    } catch (err) {
      if (!isRateLimit(err)) return;
      pausePollingFor(RATE_LIMIT_PAUSE_MS);
      showNotice(RATE_LIMIT_NOTICE, RATE_LIMIT_PAUSE_MS);
    }
  }

  // A text box in the view has focus, or text in it is selected: a redraw
  // now would take it away.
  function busy(): boolean {
    const active = document.activeElement;
    if (active && host.contains(active) && active.matches("textarea, input")) return true;
    const sel = window.getSelection();
    return !!sel && !sel.isCollapsed && !!sel.anchorNode && host.contains(sel.anchorNode);
  }

  // Run `apply` now, or as soon as the view is no longer busy (the latest
  // one only).
  function whenIdle(apply: () => void): void {
    if (!busy()) {
      apply();
      return;
    }
    const pending = waiting === null;
    waiting = { run: apply, gen: generation };
    if (!pending) return;
    // Dropped when a load (another pull request, a reset, the user's own
    // reload) came after it.
    const check = () =>
      setTimeout(() => {
        const w = waiting;
        const current = w !== null && w.gen === generation;
        if (current && busy()) return;
        host.removeEventListener("focusout", check);
        document.removeEventListener("selectionchange", check);
        waiting = null;
        if (current) w.run();
      }, 0);
    host.addEventListener("focusout", check);
    document.addEventListener("selectionchange", check);
  }

  function showNotice(text: string, ms = NOTICE_MS): void {
    if (notice) clearTimeout(notice.timer);
    notice = { text, timer: setTimeout(hideNotice, ms) };
    drawNotice();
  }

  function hideNotice(): void {
    if (notice) clearTimeout(notice.timer);
    notice = null;
    host.querySelector(".pr-refresh-notice")?.remove();
  }

  function drawNotice(): void {
    host.querySelector(".pr-refresh-notice")?.remove();
    const view = host.querySelector(".pr-view");
    if (!notice || !view) return;
    const line = el("div", { class: "pr-refresh-notice", text: notice.text, title: "Click to dismiss" });
    line.addEventListener("click", hideNotice);
    view.prepend(line);
  }

  function header(pr: PullRequestDetail): HTMLElement {
    const state = pr.is_draft && pr.state === "OPEN" ? "draft" : pr.state.toLowerCase();
    const meta = el("div", { class: "pr-meta" }, [
      el("span", { class: `pr-state ${state}`, text: state }),
      el("span", { class: "pr-author", text: pr.author }),
      el("span", { class: "pr-branches", title: `${pr.head} into ${pr.base}` }, [
        el("code", { text: pr.base }),
        " ← ",
        el("code", { text: pr.head }),
      ]),
    ]);
    if (hasConflicts(pr)) {
      meta.append(el("span", { class: "pr-status conflicts", text: "⚠ Conflicts", title: `Has conflicts with ${pr.base}: resolve them before it can be merged` }));
    }
    const approvals = approvalCount(pr.reviews);
    meta.append(
      el("span", {
        class: `pr-status approvals${approvals ? "" : " none"}`,
        text: `✓ ${approvals} approval${approvals === 1 ? "" : "s"}`,
        title: approvals ? `Approved by ${approvals} reviewer${approvals === 1 ? "" : "s"} (their latest review)` : "No approval yet",
      }),
    );
    const decision = reviewDecisionLabel(pr.review_decision);
    if (decision) meta.append(el("span", { class: `pr-badge review-${pr.review_decision!.toLowerCase()}`, text: decision }));
    meta.append(
      el("span", { class: "pr-diffstat", title: `${pr.changed_files} file${pr.changed_files === 1 ? "" : "s"} changed` }, [
        el("span", { class: "pr-add", text: `+${pr.additions}` }),
        el("span", { class: "pr-del", text: `−${pr.deletions}` }),
      ]),
    );
    meta.append(...fixingChip(pr));
    for (const label of pr.labels) meta.append(labelChip(label));

    const button = (text: string, onClick: (e: MouseEvent) => void, title?: string) => {
      const b = el("button", { class: "btn small ghost", text, title });
      b.addEventListener("click", onClick);
      return b;
    };
    const actions = el("div", { class: "pr-actions" }, [
      checkoutMenuButton(pr),
      withCaret(button("Review", (e) => cb.reviewMenu(pr, e.clientX, e.clientY), "Approve, request changes or comment")),
      ...(review().running ? [button("Reviewing… Cancel", () => cb.cancelReview(pr), "The review command is running in the background; click to stop it")] : []),
      draftsMenuButton(pr),
      ...(review().running ? [] : pushAndReplyButton(pr)),
      ...checkAllButton(pr),
      ...applyAllButton(pr, button),
    ]);
    if (pr.state === "OPEN") {
      const merge = button("Merge…", () => cb.merge(pr), `Merge #${pr.number} into ${pr.base} on GitHub`);
      merge.classList.remove("ghost");
      actions.prepend(merge);
    }
    if (cb.resolveConflicts && hasConflicts(pr)) {
      const running = resolvingConflicts.has(pr.number);
      const resolve = button(
        running ? "Resolving Conflicts…" : "Resolve Conflicts with Claude",
        () => {
          resolvingConflicts.add(pr.number);
          render();
          void cb.resolveConflicts!(pr).then((pushed) => {
            resolvingConflicts.delete(pr.number);
            if (detail?.number !== pr.number) return;
            if (pushed) void load(true);
            else render();
          });
        },
        `Merge ${pr.base} into ${pr.head} in its worktree and let Claude resolve the conflicts; you see the changes before anything is committed or pushed`,
      );
      resolve.classList.remove("ghost");
      resolve.classList.add("pr-resolve-conflicts");
      resolve.disabled = running;
      actions.prepend(resolve);
    }
    const refresh = button("", () => void load(false), `Refresh: read #${pr.number} again from GitHub`);
    refresh.classList.add("pr-icon-btn");
    refresh.setAttribute("aria-label", "Refresh");
    refresh.append(actionIcon([REFRESH_ICON]));
    const inTab = button("", () => cb.openInTab(pr), `Open #${pr.number} in a tab of its own, across the whole window`);
    inTab.classList.add("pr-icon-btn", "pr-open-tab");
    inTab.setAttribute("aria-label", "Open in a tab");
    inTab.append(actionIcon(TAB_ICON));
    // Shown in place of the one above while the pull request has its tab.
    const leave = button("", () => cb.leaveTab(pr), "Back to the usual layout, with the sidebar (Esc)");
    leave.classList.add("pr-icon-btn", "pr-leave-tab");
    leave.setAttribute("aria-label", "Leave the full window");
    leave.append(actionIcon(LEAVE_TAB_ICON));
    actions.append(refresh, inTab, leave);
    return el("div", { class: "pr-head" }, [
      el("div", { class: "pr-title-row" }, [
        el("span", { class: "pr-title", text: pr.title }),
        el("span", { class: "pr-number", text: `#${pr.number}` }),
        ...reviewPageLink(pr),
        ...jiraLink(pr),
        titleLink(PR_LINK_ICON, `Open #${pr.number} on GitHub\n${pr.url}`, () => cb.openUrl(pr.url)),
      ]),
      meta,
      ...reviewersRow(pr),
      actions,
    ]);
  }

  // Who reviews: each reviewer by their verdict, the ones asked and not
  // answered yet, with Ask again / Take back, and "+ Add".
  const REVIEWER_LOOK: Record<ReviewerState, { icon: string; words: string }> = {
    requested: { icon: "●", words: "asked, not reviewed yet" },
    APPROVED: { icon: "✓", words: "approved" },
    CHANGES_REQUESTED: { icon: "±", words: "requested changes" },
    COMMENTED: { icon: "💬", words: "commented" },
    DISMISSED: { icon: "⊘", words: "review dismissed" },
  };
  function reviewersRow(pr: PullRequestDetail): HTMLElement[] {
    const rows = reviewerRows(pr);
    const edit = pr.state === "OPEN" ? cb.setReviewers : undefined;
    if (!rows.length && !edit) return [];
    const change = (add: string[], remove: string[]) => {
      if (!edit) return;
      void edit(pr, add, remove).then((done) => {
        if (done) void load(true);
      });
    };
    const chips = rows.map((r) => {
      const look = REVIEWER_LOOK[r.state];
      const chip = el("span", { class: `pr-reviewer ${r.state.toLowerCase()}`, title: `${r.id}: ${look.words}${r.requested && r.state !== "requested" ? " · asked again" : ""}` }, [
        el("span", { class: "pr-reviewer-icon", text: look.icon }),
        el("span", { text: r.team ? r.id : `@${r.id}` }),
      ]);
      if (r.requested && r.state !== "requested") chip.append(el("span", { class: "pr-reviewer-again", text: "●", title: "Asked again" }));
      if (edit && !r.requested && !r.team) {
        const again = el("button", { class: "pr-reviewer-btn", type: "button", text: "↻", title: `Ask @${r.id} to review again` });
        again.addEventListener("click", () => change([r.id], []));
        chip.append(again);
      }
      if (edit && r.requested) {
        const remove = el("button", { class: "pr-reviewer-btn", type: "button", text: "×", title: `Take back the review request of ${r.team ? r.id : `@${r.id}`}` });
        remove.addEventListener("click", () => change([], [r.id]));
        chip.append(remove);
      }
      return chip;
    });
    const row = el("div", { class: "pr-reviewers" }, [el("span", { class: "pr-reviewers-label", text: "Reviewers" }), ...chips]);
    if (!rows.length) row.append(el("span", { class: "pr-reviewers-none", text: "none yet" }));
    if (edit) {
      const add = el("button", { class: "btn small ghost pr-reviewer-add", type: "button", text: "+ Add", title: "Ask someone (or a team, as org/team) for a review" });
      add.addEventListener("click", () =>
        openReviewerPicker(add, cb.assignableUsers ?? (() => Promise.resolve([])), [pr.author, ...rows.filter((r) => r.requested).map((r) => r.id)], (id) =>
          change([id], []),
        ),
      );
      row.append(add);
    }
    return [row];
  }

  // --- Conversation ---------------------------------------------------------

  function renderConversation(body: HTMLElement, pr: PullRequestDetail): void {
    const area = composerArea({ placeholder: "Leave a comment (Markdown)" });
    area.value = draft;
    area.addEventListener("input", () => (draft = area.value));
    const quote = (author: string, text: string) => {
      area.value = `${area.value}${area.value && !area.value.endsWith("\n") ? "\n\n" : ""}${quoteReply(author, text)}`;
      draft = area.value;
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    };

    if (searched !== null && !pr.review_comments.some((c) => c.id === searched)) body.append(goneThreadNode(pr, searched));
    body.append(card(pr.author, pr.created_at, "opened this pull request", pr.body, [], "pr-description"));
    for (const item of prTimeline(pr)) {
      if (item.kind === "comment") {
        const c = item.comment;
        body.append(card(c.author, c.created_at, "commented", c.body, [smallButton("Quote Reply", () => quote(c.author, c.body))], "pr-comment"));
      } else if (item.kind === "review") {
        const r = item.review;
        const actions = r.body.trim() ? [smallButton("Quote Reply", () => quote(r.author, r.body))] : [];
        body.append(card(r.author, r.submitted_at, reviewVerb(r.state), r.body.trim() || null, actions, `pr-review ${r.state.toLowerCase()}`));
      } else {
        body.append(threadNode(pr, item.thread, true));
      }
    }

    const post = el("button", { class: "btn small", text: "Comment" });
    const submit = async () => {
      if (!area.value.trim()) return area.focus();
      post.disabled = true;
      const posted = await cb.comment(pr, area.value);
      post.disabled = false;
      if (posted) {
        draft = "";
        await load(true);
      }
    };
    post.addEventListener("click", () => void submit());
    submitOnCmdEnter(area, submit);
    body.append(el("div", { class: "pr-composer" }, [area, el("div", { class: "pr-composer-actions" }, [previewToggle(area).button, post])]));
  }

  // Where a fix runs on the pull request, if one does on another thread:
  // "path:line", for the other threads' disabled Fix.
  // "🔧 Fixing 1 · 2 queued" while Claude fixes the pull request's threads:
  // its menu goes to each one, and takes a waiting one off the queue.
  function fixingChip(pr: PullRequestDetail): HTMLElement[] {
    const repo = cb.repoPath();
    const running = fixRunningOn(repo, pr.number);
    const waiting = queuedFixes(repo, pr.number);
    if (running === null && waiting.length === 0) return [];
    const whereOf = (id: number) => {
      const root = pr.review_comments.find((c) => c.id === id);
      return root ? `${root.path.split("/").pop()}:${root.line ?? root.original_line ?? "?"}` : "another thread";
    };
    const text = `🔧 ${running === null ? "Starting" : "Fixing 1"}${waiting.length ? ` · ${waiting.length} queued` : ""}`;
    const chip = withCaret(el("button", { class: "pr-status fixing", text, title: "Claude's fixes on this pull request, one at a time: click for the list" }));
    const goTo = (id: number) => {
      focus = id;
      openBlocks.add(id);
      tab = "conversation";
      render();
    };
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      const items: MenuItem[] = [];
      if (running !== null) items.push({ label: `⟳ ${whereOf(running)} — fixing now`, run: () => goTo(running) });
      waiting.forEach((q, i) => items.push({ label: `${i + (running === null ? 1 : 2)}. ${whereOf(q.thread)} — queued`, run: () => goTo(q.thread) }));
      if (waiting.length) {
        items.push({ separator: true });
        for (const q of waiting) items.push({ label: `Cancel ${whereOf(q.thread)}`, run: () => cb.cancelQueuedFix(pr, q.thread, q.where) });
      }
      showContextMenu(e.clientX, e.clientY, items);
    });
    return [chip];
  }

  // A waiting fix's place, what runs and waits before it, and its Cancel.
  function queuedNote(pr: PullRequestDetail, thread: number, at: number): { label: string; note: string; cancel: () => void } {
    const repo = cb.repoPath();
    const running = fixRunningOn(repo, pr.number);
    const whereOf = (id: number) => {
      const root = pr.review_comments.find((c) => c.id === id);
      return root ? `${root.path.split("/").pop()}:${root.line ?? root.original_line ?? "?"}` : "another thread";
    };
    const before = queuedFixes(repo, pr.number)
      .slice(0, at - 1)
      .map((q) => whereOf(q.thread));
    const after = running === null ? "the running fix" : `${whereOf(running)} (fixing now)`;
    const where = whereOf(thread);
    return {
      label: `Queued · ${ordinal(at + (running === null ? 0 : 1))}`,
      note: `Queued — starts after ${[after, ...before].join(", then ")}.`,
      cancel: () => cb.cancelQueuedFix(pr, thread, where),
    };
  }

  function fixElsewhere(pr: PullRequestDetail, thisThread: number): string | null {
    const id = fixRunningOn(cb.repoPath(), pr.number);
    if (id === null || id === thisThread) return null;
    const root = pr.review_comments.find((c) => c.id === id);
    return root ? `${root.path}:${root.line ?? root.original_line ?? "?"}` : "another thread";
  }

  // The stored conversation of a thread the search opened that GitHub no
  // longer has: its stored comments, then Claude's turns read-only, with Clear.
  function goneThreadNode(pr: PullRequestDetail, id: number): HTMLElement {
    const c = threadState(cb.repoPath(), pr.number, id).conversation;
    const node = el("div", { class: "pr-thread pr-thread-gone", "data-thread": id }, [
      el("div", { class: "pr-thread-head" }, [
        ...(c ? [el("code", { text: c.line ? `${c.path}:${c.line}` : c.path })] : []),
        el("span", { class: "pr-badge", text: "thread no longer on GitHub" }),
      ]),
    ]);
    // The thread's comments as the last turn had them: the only copy left.
    for (const x of c?.comments ?? []) node.append(card(x.author, "", "", x.body, [], "pr-thread-comment"));
    if (c) node.append(storedBlock(pr, storedThread(c), () => (searched = null)));
    return node;
  }

  // A thread's stored conversation, read-only: a resolved thread's, or one
  // gone from GitHub. Collapsed unless the search opened it.
  function storedBlock(pr: PullRequestDetail, thread: Thread, onCleared: () => void = () => {}): HTMLElement {
    const id = thread.root.id;
    const ts = threadState(cb.repoPath(), pr.number, id);
    return conversationNode({
      state: { ...ts, running: null, error: null },
      head: pr.head_oid,
      open: openBlocks.has(id),
      lastKind: null,
      readOnly: true,
      loadCommit: cb.loadCommit,
      openCommit: cb.openCommit,
      onFollowup() {},
      onRetry() {},
      onCancel() {},
      onClear: () =>
        void cb.clearThreadConversation(pr, thread).then((cleared) => {
          if (!cleared) return;
          openBlocks.delete(id);
          onCleared();
        }),
      onToggle: () => {
        if (!openBlocks.delete(id)) openBlocks.add(id);
        render();
      },
    });
  }

  // A line-comment thread: where it is, the code it is on, its comments, and
  // a Reply box behind a button. `withCode`: the conversation shows the lines
  // it was made on; the Files tab shows it under them already.
  function threadNode(pr: PullRequestDetail, thread: Thread, withCode: boolean): HTMLElement {
    const { root } = thread;
    const node = el("div", { class: "pr-thread", "data-thread": root.id });
    if (withCode) {
      const where = el("div", { class: "pr-thread-head" }, [el("code", { text: `${root.path}:${root.line ?? root.original_line ?? "?"}` })]);
      if (root.line === null) where.append(el("span", { class: "pr-badge", text: "outdated" }));
      node.append(where);
      const hunk = root.diff_hunk.split("\n").slice(1).slice(-4);
      if (hunk.length) {
        node.append(
          el(
            "pre",
            { class: "pr-thread-hunk" },
            hunk.map((l) => el("div", { class: l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "", text: l })),
          ),
        );
      }
    }
    // Resolved threads are green and start folded to one line; open ones are
    // orange. A thread GitHub said nothing about is neither.
    const state = pr.review_threads.find((t) => t.comment_ids.includes(root.id));
    const resolved = state?.resolved ?? false;
    node.classList.toggle("resolved", resolved);
    node.classList.toggle("unresolved", !!state && !resolved);
    for (const c of [root, ...thread.replies]) {
      // A reviewer's suggestion: applied in the branch's worktree, one commit.
      const s = cb.applySuggestions ? suggestionOf(c, resolved) : null;
      const apply = s ? [smallButton("Apply suggestion", () => void cb.applySuggestions?.(pr, [s]))] : [];
      node.append(card(c.author, c.created_at, "", c.body, apply, "pr-thread-comment"));
    }
    // The Reply box, above the actions row (which the Claude buttons share: a
    // box in the row would be squeezed beside them), with what was typed in
    // it kept across redraws.
    const openReply = (focus = true) => {
      replyOpen.add(root.id);
      const box = replyBox(
        "Reply (Markdown)",
        "Reply",
        async (body) => {
          if (!(await cb.reply(pr, root, body))) return false;
          replyOpen.delete(root.id);
          replyText.delete(root.id);
          await load(true);
          return true;
        },
        () => {
          replyOpen.delete(root.id);
          replyText.delete(root.id);
          box.remove();
          actions.append(open);
        },
        focus,
      );
      const area = box.querySelector("textarea")!;
      // An empty box starts from the reply Claude has ready, whenever it was
      // drafted (another session, before a restart).
      if (!replyText.get(root.id)?.trim()) {
        const ready = preparedReply(threadState(cb.repoPath(), pr.number, root.id).conversation);
        if (ready) replyText.set(root.id, ready.text);
      }
      area.value = replyText.get(root.id) ?? "";
      area.addEventListener("input", () => replyText.set(root.id, area.value));
      actions.before(box);
      open.remove();
    };
    const open = smallButton("Reply…", () => openReply());
    const actions = el("div", { class: "pr-thread-actions" }, [open]);
    const chips: HTMLElement[] = [];
    // Claude on the thread: its conversation block, and the buttons that
    // start a turn — not on a resolved thread, as on GitHub nothing happens
    // there any more.
    if (resolved) {
      cb.loadThreadConversation(pr, thread);
      if (threadState(cb.repoPath(), pr.number, root.id).conversation) node.append(storedBlock(pr, thread));
    } else {
      cb.loadThreadConversation(pr, thread);
      const ts = threadState(cb.repoPath(), pr.number, root.id);
      const turn = (kind: TurnKind, text = "") => {
        lastKind.set(root.id, kind);
        openBlocks.add(root.id);
        cb.threadTurn(pr, thread, kind, text);
      };
      // A dropped reply leaves the Reply box too, so nothing posts it.
      const dropReply = async () => {
        if (!(await cb.dropReply(pr, thread))) return;
        replyText.delete(root.id);
        replyOpen.delete(root.id);
        render();
      };
      // Fix: only with an option chosen; with a fix running elsewhere on the
      // pull request it is queued. It ends in a reply draft, which lands in
      // the Reply box.
      const queuedAt = queuePosition(cb.repoPath(), pr.number, root.id);
      const fix = () => {
        if (queuedAt !== null || fixDisabledReason(ts.conversation, null)) return;
        pendingReplyDraft.set(root.id, ts.conversation?.turns.length ?? 0);
        lastKind.set(root.id, "fix");
        openBlocks.add(root.id);
        cb.fixThread(pr, thread);
      };
      if (ts.conversation || ts.running || ts.error) {
        node.append(
          conversationNode({
            state: ts,
            head: pr.head_oid,
            open: openBlocks.has(root.id),
            lastKind: lastKind.get(root.id) ?? null,
            loadCommit: cb.loadCommit,
            openCommit: cb.openCommit,
            draft: followupText.get(root.id),
            onDraft: (text) => followupText.set(root.id, text),
            onFollowup: (text) => turn("followup", text),
            fix: { disabled: fixDisabledReason(ts.conversation, null), queuesAfter: fixElsewhere(pr, root.id) },
            queued: queuedAt === null ? undefined : queuedNote(pr, root.id, queuedAt),
            queuedBehind: ts.running === "fix" ? queuedFixes(cb.repoPath(), pr.number).length : 0,
            onFix: fix,
            onChooseFix: (text) =>
              void cb.chooseOption(pr, thread, text).then((saved) => {
                if (saved) fix();
              }),
            onDrop: () => void dropReply(),
            onClear: () =>
              void cb.clearThreadConversation(pr, thread).then((cleared) => {
                if (cleared) openBlocks.delete(root.id);
              }),
            onRetry: (kind) => {
              // A fix is never a plain turn: it has a worktree, checks and
              // an undo. A fix whose commit is in but whose reply draft
              // failed needs only the draft again.
              const last = ts.conversation?.turns[ts.conversation.turns.length - 1];
              if (kind === "fix" && last?.kind === "fix" && last.commit) turn("reply-draft");
              else if (kind === "fix") fix();
              else turn(kind);
            },
            onCancel: () => cb.cancelThreadTurn(pr, thread),
            onToggle: () => {
              if (!openBlocks.delete(root.id)) openBlocks.add(root.id);
              render();
            },
          }),
        );
      }
      // A reply draft that arrived since Reply with Claude was clicked lands
      // in the Reply box — after a confirm when the box holds something.
      const turns = ts.conversation?.turns ?? [];
      const last = turns[turns.length - 1];
      const since = pendingReplyDraft.get(root.id);
      if (since !== undefined && !ts.running) {
        if (ts.error) pendingReplyDraft.delete(root.id);
        else if (turns.length > since && last?.kind === "reply-draft" && last.role === "claude") {
          pendingReplyDraft.delete(root.id);
          if (!replyText.get(root.id)?.trim()) replyText.set(root.id, last.text);
          else {
            void cb.confirm("Replace what you typed in the Reply box with Claude's draft?").then((ok) => {
              if (!ok) return;
              replyText.set(root.id, last.text);
              replyOpen.add(root.id);
              render();
            });
          }
        }
      }
      // What Claude has done on the thread, first in the row (below).
      for (const text of threadBadges(ts.conversation)) {
        chips.push(threadChip(text));
        if (text === "reply ready") actions.append(smallButton("Drop", () => void dropReply()));
      }
      for (const b of threadClaudeButtons(false, ts.running)) {
        const button = smallButton(b.label, () => {
          if (b.action === "reply-draft") pendingReplyDraft.set(root.id, ts.conversation?.turns.length ?? 0);
          turn(b.action);
        });
        (button as HTMLButtonElement).disabled = b.disabled;
        button.classList.add("pr-thread-claude-button");
        actions.append(button);
      }
    }
    if (state) {
      actions.prepend(
        ...chips,
        threadStatus(resolved),
        smallButton(resolved ? "Unresolve" : "Resolve", () => {
          void cb.resolve(pr, state, !resolved).then((ok) => {
            if (ok) void load(true);
          });
        }),
      );
    } else actions.prepend(...chips);
    node.append(actions);
    if (replyOpen.has(root.id) || (replyText.get(root.id) ?? "") !== "") openReply(false);
    if (resolved) {
      const where = withCode ? `${root.path}:${root.line ?? root.original_line ?? "?"} · ` : "";
      addFold(node, `t${root.id}`, where + threadFoldText(root.author, root.body, thread.replies.length, false), threadStatus(true));
    }
    return node;
  }

  // "✓ fixed" (blue), "✉ reply ready" (purple) or "↗ posted" (green): what
  // Claude has done on the thread.
  function threadChip(text: string): HTMLElement {
    const looks: Record<string, { cls: string; icon: string }> = {
      fixed: { cls: "fixed", icon: "✓ " },
      "reply ready": { cls: "reply-ready", icon: "✉ " },
      posted: { cls: "posted", icon: "↗ " },
    };
    const look = looks[text] ?? { cls: "", icon: "" };
    return el("span", { class: `pr-thread-chip ${look.cls}`.trim(), text: `${look.icon}${text}` });
  }

  function threadStatus(resolved: boolean): HTMLElement {
    return el("span", { class: `pr-thread-status ${resolved ? "resolved" : "unresolved"}`, text: resolved ? "✓ Resolved" : "Unresolved" });
  }

  // --- Files changed --------------------------------------------------------

  // The changed files, the first screenful at once (down to `scrolled`, for a
  // redraw that keeps its place) and the rest a slice at a time after: a
  // pull request of hundreds of files took seconds to show anything.
  async function renderFiles(body: HTMLElement, pr: PullRequestDetail, scrolled = 0): Promise<void> {
    if (!files) {
      body.append(el("div", { class: "pr-empty", text: "Loading the changed files…" }));
      const mine = generation;
      try {
        const loaded = await readFiles(pr);
        if (mine !== generation || tab !== "files") return;
        files = loaded;
      } catch (err) {
        if (mine !== generation) return;
        clear(body);
        body.append(el("div", { class: "pr-empty", text: "Couldn't load the changed files." }));
        cb.reportError(`Couldn't load the files of #${pr.number}`, err);
        return;
      }
      clear(body);
    }
    if (files.length === 0) {
      body.append(el("div", { class: "pr-empty", text: "No changed files." }));
      return;
    }
    const shown = files;
    const threads = reviewThreads(pr.review_comments);
    const byLine = threadsByLine(threads);
    const counts = threadsPerFile(threads);
    const index = new Map(shown.map((f, i) => [f.path, i]));
    // Each file's diff once drawn; drawn in order, so the first `built`.
    const nodes: HTMLElement[] = [];
    // The search's matches, by file: null for a file it hides.
    let hits: ([number, number][] | null)[] = shown.map(() => []);
    const marked = (i: number, node: HTMLElement) => {
      const found = hits[i];
      node.hidden = found === null;
      for (const row of node.querySelectorAll(".pr-search-hit")) row.classList.remove("pr-search-hit");
      for (const [h, k] of found ?? []) {
        for (const row of node.querySelectorAll(`.hunk[data-hunk="${h}"] [data-line="${k}"]`)) row.classList.add("pr-search-hit");
      }
    };
    const diffs = el("div", { class: "pr-files-diffs" });
    const buildNext = () => {
      const i = nodes.length;
      const node = annotatedFile(pr, shown[i], byLine, counts.get(shown[i].path) ?? 0);
      node.dataset.path = shown[i].path;
      // Its height before the browser lays it out, as a guess from its lines.
      const lines = shown[i].hunks.reduce((n, h) => n + h.lines.length + 1, 0);
      node.dataset.size = String(lines * 14 + 40);
      if (cb.fetchViewed) node.querySelector(".file-head")?.append(viewedBox(shown[i].path));
      paintViewedFile(node);
      nodes.push(node);
      marked(i, node);
      diffs.append(node);
    };
    // Draw every file up to `path`'s, for a jump to it.
    const buildTo = (path: string) => {
      const i = index.get(path);
      while (i !== undefined && nodes.length <= i) buildNext();
    };
    drawFile = buildTo;

    // The folder tree: a click scrolls its file's diff into view. Drawn on its
    // own, so picking a file doesn't rebuild the diffs.
    const byPath = new Map(shown.map((f) => [f.path, f]));
    const tree = el("aside", { class: "pr-files-tree tree-view", "aria-label": "Changed files" });
    const paintTree = () => {
      clear(tree);
      renderFileTree(tree, [...byPath.keys()].sort(), {
        collapsed: treeCollapsed,
        onToggle: (p) => {
          if (treeCollapsed.has(p)) treeCollapsed.delete(p);
          else treeCollapsed.add(p);
          paintTree();
        },
        statusOf: (p) => byPath.get(p)?.status ?? null,
        selectedPath: treeSelected ?? undefined,
        trailing: (p) => {
          const n = counts.get(p) ?? 0;
          return n ? el("span", { class: "pr-tree-comments", text: String(n), title: `${n} comment${n === 1 ? "" : "s"}` }) : null;
        },
        onFileClick: (p) => {
          treeSelected = p;
          paintTree();
          buildTo(p);
          nodes[index.get(p) ?? -1]?.scrollIntoView({ block: "start" });
        },
      });
      // Files the search hid are dimmed in the tree too.
      for (const row of tree.querySelectorAll<HTMLElement>(".tree-file")) {
        row.classList.toggle("dim", hits[index.get(row.title) ?? -1] === null);
      }
    };

    const count = el("span", { class: "pr-files-count" });
    const search = el("input", {
      class: "pr-files-search",
      type: "search",
      placeholder: "Search file names and code",
      "aria-label": "Search file names and code",
    });
    search.value = filesQuery;
    // Hide the files that don't match, and mark the lines that do.
    const applySearch = () => {
      hits = searchFiles(shown, filesQuery);
      nodes.forEach((node, i) => marked(i, node));
      const files = hits.filter((h) => h !== null).length;
      const lines = hits.reduce((n, h) => n + (h?.length ?? 0), 0);
      count.textContent = filesQuery.trim()
        ? `${files} of ${shown.length} file${shown.length === 1 ? "" : "s"} · ${lines} matching line${lines === 1 ? "" : "s"}`
        : "";
      if (treeShown) paintTree();
    };
    search.addEventListener("input", () => {
      filesQuery = search.value;
      applySearch();
    });
    const layout = el("div", { class: "tb-group" }, [
      iconBtn(["M4 6h16", "M4 12h16", "M4 18h16"], "Unified", false, () => setSplit(false), !split),
      iconBtn(["M4 5h16v14H4z", "M12 5v14"], "Split", false, () => setSplit(true), split),
    ]);
    // The same Wrap setting as the commit and Local Changes diffs.
    const wrap = loadDiffWrap();
    const wrapToggle = iconBtn(
      WRAP_ICON,
      split ? "Wrap long lines (the split view always wraps)" : "Wrap long lines",
      split,
      () => {
        saveDiffWrap(!wrap);
        render();
      },
      wrap && !split,
    );
    const treeToggle = iconBtn(
      ["M4 5h16v14H4z", "M9 5v14", "M5.5 9h2", "M5.5 12h2"],
      treeShown ? "Hide the file tree" : "Show the file tree",
      false,
      () => {
        treeShown = !treeShown;
        savePrFilesTree(treeShown);
        render();
      },
      treeShown,
    );
    const columns = el("div", { class: "pr-files-layout" });
    if (treeShown) columns.append(tree);
    // Comment boxes on a file no longer in the diff at all.
    const gone = [...lineDrafts].filter(([, d]) => !byPath.has(d.path)).map(([key, d]) => orphanComposer(key, d));
    diffs.classList.toggle("wrap-lines", wrap && !split);
    diffs.append(...gone);
    diffs.classList.toggle("comments-collapsed", commentsCollapsed);
    columns.append(diffs);
    // Switching it only folds or opens the comments: no redraw, so the scroll
    // and anything typed stay.
    const collapseBox = el("input", { type: "checkbox" });
    collapseBox.checked = commentsCollapsed;
    collapseBox.addEventListener("change", () => {
      commentsCollapsed = collapseBox.checked;
      savePrCollapseComments(commentsCollapsed);
      openComments.clear();
      for (const n of diffs.querySelectorAll(".pr-comment-folds.open")) n.classList.remove("open");
      diffs.classList.toggle("comments-collapsed", commentsCollapsed);
    });
    const collapse = el(
      "label",
      { class: "pr-files-collapse", title: "Fold each comment and draft under the code to one line; click a line to open it" },
      [collapseBox, el("span", { text: "Collapse comments" })],
    );
    body.append(
      el("div", { class: "pr-files-bar" }, [
        el("div", { class: "tb-group" }, [treeToggle]),
        layout,
        el("div", { class: "tb-group" }, [wrapToggle]),
        collapse,
        search,
        count,
        el("span", { class: "pr-files-viewed-count" }),
        el("span", { class: "pr-files-hint", text: "Click a line to comment on it." }),
      ]),
      columns,
    );
    applySearch();
    readViewed(pr);
    // Enough to fill the view (or reach where a redraw was scrolled to) now,
    // the rest in slices that leave the window free to scroll and click.
    const filled = () => body.scrollHeight >= scrolled + body.clientHeight * 2;
    while (nodes.length < shown.length && (nodes.length === 0 || !filled())) buildNext();
    const more = () => {
      if (!diffs.isConnected || nodes.length >= shown.length) return;
      const until = performance.now() + 12;
      while (nodes.length < shown.length && performance.now() < until) buildNext();
      setTimeout(more, 0);
    };
    setTimeout(more, 0);
  }

  // --- Viewed ---------------------------------------------------------------

  // Read which files are marked Viewed on GitHub, once per pull request.
  function readViewed(pr: PullRequestDetail): void {
    if (!cb.fetchViewed || viewed?.number === pr.number || viewedReading === pr.number) return paintViewedCount();
    viewedReading = pr.number;
    cb.fetchViewed(pr.number).then(
      (v) => {
        viewedReading = null;
        if (number !== pr.number) return;
        viewed = { number: pr.number, id: v.id, paths: new Set(v.viewed) };
        paintViewed();
      },
      () => {
        // The boxes stay off: GitHub couldn't say.
        viewedReading = null;
      },
    );
  }

  // A file's "Viewed" box: ticked, it folds the file and marks it on GitHub.
  function viewedBox(path: string): HTMLElement {
    const box = el("input", { type: "checkbox" });
    box.disabled = true;
    box.addEventListener("change", () => void markViewed(path, box.checked));
    const label = el("label", { class: "pr-file-viewed", title: "Viewed: fold this file, and mark it so on GitHub" }, [box, el("span", { text: "Viewed" })]);
    label.addEventListener("click", (e) => e.stopPropagation());
    return label;
  }

  async function markViewed(path: string, on: boolean): Promise<void> {
    const v = viewed;
    if (!v || v.number !== number) return;
    const set = (to: boolean) => {
      if (to) v.paths.add(path);
      else v.paths.delete(path);
      paintViewed();
    };
    set(on);
    try {
      await cb.setViewed?.(v.id, path, on);
    } catch (err) {
      set(!on);
      cb.reportError(`Couldn't mark ${path} as ${on ? "viewed" : "not viewed"} on GitHub`, err);
    }
  }

  // One file of the Files tab, folded or not as its mark says.
  function paintViewedFile(node: HTMLElement): void {
    const v = viewed && viewed.number === number ? viewed : null;
    const on = !!v && v.paths.has(node.dataset.path ?? "");
    node.classList.toggle("viewed", on);
    // Its height until the browser lays it out (see .pr-files-diffs).
    node.style.containIntrinsicSize = `auto ${on ? 40 : Number(node.dataset.size ?? 40)}px`;
    const box = node.querySelector<HTMLInputElement>(".pr-file-viewed input");
    if (box) {
      box.checked = on;
      box.disabled = !v;
    }
  }

  function paintViewedCount(): void {
    const count = host.querySelector(".pr-files-viewed-count");
    const v = viewed && viewed.number === number ? viewed : null;
    if (count) count.textContent = v && files ? `${files.filter((f) => v.paths.has(f.path)).length} of ${files.length} viewed` : "";
  }

  function paintViewed(): void {
    for (const node of host.querySelectorAll<HTMLElement>(".pr-files-diffs > [data-path]")) paintViewedFile(node);
    paintViewedCount();
  }

  function setSplit(on: boolean): void {
    if (split === on) return;
    split = on;
    savePrDiffSplit(on);
    render();
  }

  // A file's diff, unified or side by side as elsewhere, with its threads
  // under their lines, how many there are in its header, and a comment box on
  // any line clicked.
  function annotatedFile(pr: PullRequestDetail, file: FileDiff, threads: Map<string, Thread[]>, comments: number): HTMLElement {
    const node = split ? renderSplitDiff(file) : renderFile(file);
    if (comments) {
      const label = `${comments} comment${comments === 1 ? "" : "s"}`;
      node.querySelector(".file-head")?.append(el("span", { class: "pr-file-comments", text: label, title: `${label} on this file` }));
    }
    const lineOf = (row: Element) => {
      const hunk = Number(row.closest<HTMLElement>(".hunk")?.dataset.hunk);
      const at = Number((row as HTMLElement).dataset.line);
      return file.hunks[hunk]?.lines[at];
    };
    // What a thread or comment box goes under: the line, or in the split view
    // the row holding both of its sides.
    const anchorOf = (row: Element): Element => row.closest(".split-row") ?? row;
    // A split row shows an unchanged line twice; its threads go under it once.
    const placed = new Set<string>();
    // Each line's row (or split row), for the comment boxes opened again.
    const anchors = new Map<string, { anchor: Element; content: string }>();
    for (const row of node.querySelectorAll<HTMLElement>(".diff-line, .split-cell[data-line]")) {
      const line = lineOf(row);
      const target = line && lineTarget(line);
      if (!target) continue;
      row.classList.add("pr-commentable");
      const key = lineKey(file.path, target.side, target.line);
      if (placed.has(key)) continue;
      placed.add(key);
      anchors.set(key, { anchor: anchorOf(row), content: line.content });
      // Below the threads the row's other side has put there already.
      let after = anchorOf(row);
      while (after.nextElementSibling?.classList.contains("pr-thread")) after = after.nextElementSibling;
      for (const t of threads.get(key) ?? []) {
        const n = threadNode(pr, t, false);
        // A resolved thread folded itself already.
        const resolved = pr.review_threads.find((s) => s.comment_ids.includes(t.root.id))?.resolved ?? false;
        if (!resolved) addFold(n, `t${t.root.id}`, threadFoldText(t.root.author, t.root.body, t.replies.length, false));
        after.after(n);
        after = n;
      }
    }
    // The review's drafts on this file, under their lines.
    const mine = review().drafts.filter((d) => d.path === file.path && d.line > 0);
    placeDraftCards(node, file, mine.map((d) => ({ d, line: d.line, side: d.side })), (d) => {
      const c = prDraftCard(pr, d, "inline", "ok");
      addFold(c, `d${d.id}`, draftFoldText(d.severity, d.body));
      return c;
    });
    // The comment boxes open before the redraw, under their lines again;
    // one whose line left the diff at the top of the file.
    for (const [key, d] of lineDrafts) {
      if (d.path !== file.path) continue;
      // The same line number holding other code (a push moved it) is not
      // the line the comment was for.
      const at = anchors.get(key);
      if (at && at.content === d.content) at.anchor.after(lineComposer(pr, file.path, d, false));
      else (node.querySelector(".file-head") ?? node).after(orphanComposer(key, d));
    }
    if (file.truncated) {
      node.append(el("div", { class: "diff-truncated", text: "This diff is too long to show in full here; open it on GitHub for the rest." }));
    }
    node.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest(".diff-line.pr-commentable, .split-cell.pr-commentable");
      // A drag that selected text is a copy, not a click on the line.
      if (!row || !window.getSelection()?.isCollapsed) return;
      const anchor = anchorOf(row);
      const next = anchor.nextElementSibling;
      if (next?.classList.contains("pr-line-composer")) {
        next.querySelector("textarea")?.focus();
        return;
      }
      const line = lineOf(row);
      const target = line && lineTarget(line);
      if (!target) return;
      const d: LineDraft = { path: file.path, side: target.side, line: target.line, content: line.content, text: "" };
      lineDrafts.set(lineKey(d.path, d.side, d.line), d);
      anchor.after(lineComposer(pr, file.path, d, true));
    });
    return node;
  }

  // Give a thread or draft card under the code its folded line: shown while
  // "Collapse comments" is on, where a click opens or folds just this one.
  // `badge`: the fold is always there, not only under "Collapse comments",
  // with the badge on its line (a resolved thread).
  function addFold(node: HTMLElement, id: string, text: string, badge?: HTMLElement): void {
    node.classList.add("pr-comment-folds");
    node.classList.toggle("fold-always", !!badge);
    node.classList.toggle("open", openComments.has(id));
    const fold = el("button", { class: "pr-comment-fold", type: "button", title: "Open or fold this comment" }, [
      el("span", { class: "pr-comment-fold-icon", text: "›" }),
      ...(badge ? [badge] : []),
      el("span", { class: "pr-comment-fold-text", text }),
    ]);
    fold.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !node.classList.contains("open");
      node.classList.toggle("open", open);
      if (open) openComments.add(id);
      else openComments.delete(id);
    });
    node.prepend(fold);
  }

  // The comment box under a line, kept in `lineDrafts` until it is posted or
  // cancelled.
  function lineComposer(pr: PullRequestDetail, path: string, d: LineDraft, focus: boolean): HTMLElement {
    const key = lineKey(path, d.side, d.line);
    const where = `${path}:${d.line}${d.side === "LEFT" ? " (removed line)" : ""}`;
    const box = replyBox(`Comment on ${where} (Markdown)`, "Add Comment", async (text) => {
      const ok = await cb.lineComment(pr, { path, line: d.line, side: d.side, commit_id: pr.head_oid, body: text });
      if (ok) {
        lineDrafts.delete(key);
        await load(true);
      }
      return ok;
    }, () => {
      lineDrafts.delete(key);
      box.remove();
    }, focus);
    box.classList.add("pr-line-composer");
    const area = box.querySelector("textarea")!;
    area.value = d.text;
    area.addEventListener("input", () => (d.text = area.value));
    return box;
  }

  // What was typed for a line a push took out of the diff: kept to copy,
  // until Discard.
  function orphanComposer(key: string, d: LineDraft): HTMLElement {
    const area = composerArea({});
    area.value = d.text;
    area.addEventListener("input", () => (d.text = area.value));
    const discard = el("button", { class: "btn small ghost", text: "Discard" });
    const box = el("div", { class: "pr-composer pr-line-orphan" }, [
      el("div", { class: "pr-line-orphan-head", text: `Comment on a line no longer in the diff (${d.path}:${d.line}${d.side === "LEFT" ? ", removed line" : ""})` }),
      area,
      el("div", { class: "pr-composer-actions" }, [discard]),
    ]);
    discard.addEventListener("click", () => {
      lineDrafts.delete(key);
      box.remove();
    });
    box.addEventListener("click", (e) => e.stopPropagation());
    return box;
  }

  // Check Out, with a menu: a local branch, or one in a new worktree.
  function checkoutMenuButton(pr: PullRequestDetail): HTMLElement {
    const b = withCaret(el("button", { class: "btn small ghost", text: "Check Out", title: `Check out ${pr.head} here or in a new worktree` }));
    b.addEventListener("click", (e) => {
      const { clientX: x, clientY: y } = e;
      showContextMenu(x, y, [
        { label: "Check Out", run: () => cb.checkout(pr) },
        { label: "Check Out in New Worktree…", run: () => cb.checkoutInWorktree(pr, x, y) },
      ]);
    });
    return b;
  }

  // Draft Review, with a menu: the review command, the /review-pr-phuong skill, or a
  // review file, into the Drafts tab. A green dot, and the menu says why,
  // when commits arrived since the last review: time to review again.
  function draftsMenuButton(pr: PullRequestDetail): HTMLElement {
    const reviewed = cb.reviewedHead(pr.number);
    const fresh = hasNewCommits(reviewed, pr.head_oid);
    const news = fresh ? `New commits since the last review (${reviewed!.slice(0, 8)} → ${pr.head_oid.slice(0, 8)})` : null;
    const b = withCaret(el("button", {
      class: `btn small ghost${fresh ? " pr-has-news" : ""}`,
      text: "Draft Review",
      title: news ? `${news}: run a review again` : "Run a review, or load a review file, for draft comments to approve or discard before posting",
    }));
    b.addEventListener("click", (e) => {
      const items: MenuItem[] = news ? [{ heading: news }] : [];
      if (!review().running) {
        items.push(
          { label: "Run Review Command", run: () => cb.generateDrafts(pr) },
          { label: "Run Review Skill", run: () => cb.generateDraftsWithSkill(pr) },
          { separator: true },
        );
      }
      items.push({ label: "Load Review File…", run: () => void loadDrafts(pr) });
      showContextMenu(e.clientX, e.clientY, items);
    });
    return b;
  }

  // "Apply N Suggestions": every suggestion of the open threads, one commit.
  function applyAllButton(pr: PullRequestDetail, button: (text: string, onClick: () => void, title?: string) => HTMLButtonElement): HTMLButtonElement[] {
    const all = cb.applySuggestions ? prSuggestions(pr) : [];
    if (all.length < 2) return [];
    return [button(`Apply ${all.length} Suggestions`, () => void cb.applySuggestions?.(pr, all), "Apply every reviewer's suggestion of the open threads in the branch's worktree, as one commit")];
  }

  // Check N Comments: a Check on every open thread not checked at the pull
  // request's head yet, all at once in the background.
  function checkAllButton(pr: PullRequestDetail): HTMLElement[] {
    const repo = cb.repoPath();
    const open = reviewThreads(pr.review_comments).filter((t) => !pr.review_threads.find((s) => s.comment_ids.includes(t.root.id))?.resolved);
    // Their saved conversations, so a thread checked already isn't counted.
    for (const t of open) cb.loadThreadConversation(pr, t);
    const unchecked = open.filter((t) => needsCheck(threadState(repo, pr.number, t.root.id), pr.head_oid));
    if (!unchecked.length) return [];
    const n = unchecked.length;
    const b = el("button", {
      class: "btn small ghost",
      text: `Check ${n} ${n === 1 ? "Comment" : "Comments"}`,
      title: `Ask Claude to check the ${n === 1 ? "open comment" : `${n} open comments`} not checked at ${pr.head_oid.slice(0, 7)} yet, ${n === 1 ? "" : "all in one run, "}in the background`,
    });
    b.addEventListener("click", () => {
      for (const thread of unchecked) {
        lastKind.set(thread.root.id, "check");
        openBlocks.add(thread.root.id);
      }
      cb.checkAll(pr, unchecked);
    });
    return [b];
  }

  // Push and reply all: once a reply is ready or the branch is ahead of its
  // upstream; off while Claude works on the pull request.
  function pushAndReplyButton(pr: PullRequestDetail): HTMLElement[] {
    // Replies ready on the threads still open: a resolved one posts nothing.
    const ready = reviewThreads(pr.review_comments).filter(
      (t) =>
        !pr.review_threads.find((s) => s.comment_ids.includes(t.root.id))?.resolved &&
        preparedReply(threadState(cb.repoPath(), pr.number, t.root.id).conversation),
    ).length;
    const ahead = cb.branchAhead(pr.head);
    if (!ready && !ahead) return [];
    const b = el("button", {
      class: "btn small ghost",
      text: "Push and reply all",
      title: `${ahead ? `Push ${pr.head} (${ahead} ahead)` : "Nothing to push"}; ${ready ? `post ${ready} ${ready === 1 ? "reply" : "replies"} Claude has ready` : "no reply ready"} — after one confirm that lists both`,
    });
    const working = runningTurns(cb.repoPath(), pr.number);
    b.disabled = working > 0 || cb.pushReplyInFlight(pr);
    if (cb.pushReplyInFlight(pr)) b.textContent = "Pushing and replying…";
    // Off: say why, or it reads as broken.
    else if (working > 0) b.title = `Claude is working on ${working} thread${working === 1 ? "" : "s"} of #${pr.number}: wait for ${working === 1 ? "it" : "them"} to end, then push and reply`;
    b.addEventListener("click", () => void pushAndReplyAll(pr));
    return [b];
  }

  async function pushAndReplyAll(pr: PullRequestDetail): Promise<void> {
    if (cb.pushReplyInFlight(pr)) return;
    const edited = new Map<number, string>();
    for (const [id, text] of replyText) if (text.trim()) edited.set(id, text);
    const posted = await cb.pushAndReplyAll(pr, edited);
    if (!posted) return;
    // Only the posted replies' boxes close: a failed one keeps its edit.
    for (const id of posted) {
      replyText.delete(id);
      replyOpen.delete(id);
    }
    render();
  }

  // Drafts read back from a saved review just after the pull request opened
  // with none: show them, when no tab was picked meanwhile.
  function toDraftsIfReady(): void {
    if (draftsWhenReady && review().drafts.some(isOpen)) {
      tab = "drafts";
      draftsWhenReady = false;
    }
  }

  // The saved review page as an icon beside the title, when there is one.
  function reviewPageLink(pr: PullRequestDetail): HTMLElement[] {
    const page = cb.savedReview(pr.number);
    if (!page) return [];
    return [
      titleLink(REVIEW_PAGE_ICON, `Open the saved review\n${page}`, () => cb.openReviewPage(page)),
      titleLink(READ_REVIEW_ICON, "Read the saved review here, with Explain more", () => cb.readReview(pr, page)),
    ];
  }

  // A small icon button beside the title.
  function actionIcon(paths: string[]): SVGElement {
    const icon = svg("svg", { viewBox: "0 0 24 24", class: "tb-icon", "aria-hidden": "true" });
    for (const d of paths) icon.append(svg("path", { d }));
    return icon;
  }

  // The Jira ticket named in the branch (else the title), when Settings has a site.
  function jiraLink(pr: PullRequestDetail): HTMLElement[] {
    const key = jiraKeyIn(pr.head, pr.title);
    const url = jiraTicketUrl(loadJiraSite(), key);
    return url ? [titleLink(JIRA_ICON, `Open ${key} in Jira\n${url}`, () => cb.openUrl(url))] : [];
  }

  function titleLink(icon: string[], title: string, onClick: () => void): HTMLElement {
    const b = iconBtn(icon, title, false, onClick);
    b.classList.add("pr-title-link");
    return b;
  }

  // --- Draft comments -------------------------------------------------------

  // Read a review file's findings into the Drafts tab. The changed files are
  // loaded too, so each draft can say whether its line is in the diff.
  async function loadDrafts(pr: PullRequestDetail): Promise<void> {
    if (!(await cb.loadDrafts(pr)) || number !== pr.number) return;
    tab = "drafts";
    await showDrafts(pr);
  }

  // Load the changed files too, so each draft can say whether its line is in
  // the diff, then draw.
  async function showDrafts(pr: PullRequestDetail): Promise<void> {
    if (!files) {
      try {
        files = await readFiles(pr);
      } catch {
        // Without the diff the anchors go unchecked; GitHub will still refuse a
        // bad one when posting.
      }
    }
    if (number === pr.number) render();
  }

  // Each draft: where it goes, its severity, the text (editable), and Approve
  // or Discard. Above them the review the approved ones will be posted as.
  function renderDrafts(body: HTMLElement, pr: PullRequestDetail): void {
    const r = review();
    const drafts = r.drafts;
    const live = drafts.filter(isOpen);
    if (live.length === 0 && drafts.length === 0) {
      body.append(el("div", { class: "pr-empty", text: "No draft comments. Load a review file to get some." }));
      return;
    }
    // A comment on the whole pull request needs no diff to place.
    const anchorOf = (d: Draft) => (files || !d.path ? checkAnchor(d, files ?? []) : "ok");
    const postable = drafts.filter((d) => d.status === "approved" && anchorOf(d) === "ok");
    // GitHub refuses a line comment outside the diff: these go in the review
    // message instead, each linked to its line.
    const offDiff = drafts.filter((d) => d.status === "approved" && anchorOf(d) !== "ok");

    const verdict = el("select", { class: "pr-drafts-verdict", "aria-label": "Review verdict" });
    for (const [value, label] of [
      ["comment", "Comment"],
      ["approve", "Approve"],
      ["request_changes", "Request changes"],
    ] as const) {
      const o = el("option", { value, text: label });
      o.selected = r.verdict === value;
      verdict.append(o);
    }
    verdict.addEventListener("change", () => (r.verdict = verdict.value as ReviewVerdict));
    const message = composerArea({
      class: "pr-drafts-message",
      placeholder: "Review message (Markdown) — optional for Comment and Approve",
    });
    message.value = r.body;
    message.addEventListener("input", () => (r.body = message.value));

    const n = postable.length + offDiff.length;
    const postBtn = el("button", { class: "btn small", text: `Post ${n} approved` });
    postBtn.disabled = n === 0;
    postBtn.addEventListener("click", () => {
      postBtn.disabled = true;
      void cb
        .postReview(
          pr,
          r.verdict,
          withOffDiffDrafts(r.body, offDiff, pr.url, pr.head_oid),
          postable.map((d) => ({ path: d.path, line: d.line, side: d.side, commit_id: pr.head_oid, body: d.body })),
        )
        .then(async (ok) => {
          if (!ok) {
            postBtn.disabled = false;
            return;
          }
          markPosted(cb.repoPath(), pr.number, [...postable, ...offDiff]);
          setReviewedHead(cb.repoPath(), pr.number, pr.head_oid);
          const posted = new Set([...postable, ...offDiff].map((d) => d.id));
          r.drafts = r.drafts.filter((d) => !posted.has(d.id));
          r.body = "";
          if (nothingLeftAfterPost(r.drafts)) {
            clearDrafts(cb.repoPath(), pr.number);
            tab = "conversation";
          }
          reviewsChanged();
          await load(true);
        });
    });
    const setAll = (status: Draft["status"]) => {
      // A fixed draft keeps its mark.
      for (const d of drafts) if (isOpen(d) || (status === "pending" && d.status === "discarded" && !d.fix)) d.status = status;
      reviewsChanged();
    };
    const toDecide = drafts.filter((d) => draftStanding(d) === "open").length;
    const summary = `${toDecide} open draft${toDecide === 1 ? "" : "s"} · ${drafts.filter((d) => d.status === "approved").length} approved${offDiff.length ? ` · ${offDiff.length} in the review message (line not in this diff)` : ""}`;
    body.append(
      el("div", { class: "pr-drafts-bar" }, [
        el("span", { class: "pr-drafts-summary", text: summary }),
        smallButton("Approve All", () => setAll("approved")),
        smallButton("Clear", () => {
          clearDrafts(cb.repoPath(), pr.number);
          tab = "conversation";
          reviewsChanged();
        }),
        ...(r.file ? [smallButton("Show Review File", () => cb.showReviewFile(r.file!))] : []),
        el("span", { class: "spacer" }),
        previewToggle(message).button,
        verdict,
        postBtn,
      ]),
      message,
    );
    body.append(draftsOverview(drafts));
    const cards = drafts.filter(shown).map((d) => {
      const c = prDraftCard(pr, d, "list", anchorOf(d));
      if (d.id === draftCursor) c.classList.add("cursor");
      c.addEventListener("click", () => pointAt(c));
      return c;
    });
    body.append(...cards);
  }

  // Whether the Drafts tab's filters show `d`.
  function shown(d: Draft): boolean {
    return (draftShow === "all" || draftStanding(d) === draftShow) && (draftSeverity === null || d.severity === draftSeverity);
  }

  // Above the cards: filters by standing and severity, then one line per
  // draft shown — its severity, place, standing and first words — that
  // scrolls to its card.
  function draftsOverview(drafts: Draft[]): HTMLElement {
    const chip = (label: string, on: boolean, pick: () => void) => {
      const b = el("button", { class: `pr-drafts-chip${on ? " on" : ""}`, text: label });
      b.addEventListener("click", () => {
        pick();
        render();
      });
      return b;
    };
    const count = (s: DraftShow) => drafts.filter((d) => s === "all" || draftStanding(d) === s).length;
    const filters = el("div", { class: "pr-drafts-filters" }, [
      ...(["all", "open", "fixed", "discarded"] as const).map((s) => chip(`${s[0].toUpperCase()}${s.slice(1)} ${count(s)}`, draftShow === s, () => (draftShow = s))),
    ]);
    const severities = [...new Set(drafts.map((d) => d.severity).filter((x): x is string => !!x))];
    if (severities.length > 1) {
      filters.append(
        el("span", { class: "pr-drafts-filters-sep" }),
        chip("Any severity", draftSeverity === null, () => (draftSeverity = null)),
        ...severities.map((sev) => chip(sev, draftSeverity === sev, () => (draftSeverity = sev))),
      );
    }
    const list = el("div", { class: "pr-drafts-index" });
    for (const d of drafts.filter(shown)) {
      const standing = draftStanding(d);
      const row = el("button", { class: `pr-drafts-index-row ${standing}`, title: "Go to this draft" }, [
        el("span", { class: `pr-draft-sev ${(d.severity ?? "").replace(/\W+/g, "-")}`, text: d.severity ?? "—" }),
        el("span", { class: "pr-drafts-index-where", text: d.path ? `${d.path.slice(d.path.lastIndexOf("/") + 1)}:${d.line}` : (d.topic ?? "Whole change") }),
        el("span", { class: `pr-drafts-index-state ${standing}`, text: d.status === "approved" ? "approved" : standing }),
        el("span", { class: "pr-drafts-index-text", text: d.body.split("\n").find((l) => l.trim()) ?? "" }),
      ]);
      row.addEventListener("click", () => {
        const card = host.querySelector<HTMLElement>(`.pr-draft[data-draft="${d.id}"]:not(.inline)`);
        if (!card) return;
        pointAt(card);
        card.scrollIntoView({ block: "start", behavior: "smooth" });
      });
      list.append(row);
    }
    if (!list.childElementCount) list.append(el("div", { class: "pr-empty", text: "No draft matches these filters." }));
    filters.append(
      el("span", {
        class: "pr-drafts-keys",
        text: "j/k move · a approve · d discard · f fix · e explain · o show",
        title: "Keys of the Drafts tab, on the marked card (click a card to mark it). All of them: Settings → Keymap, or ⌘/",
      }),
    );
    return el("div", { class: "pr-drafts-overview" }, [filters, list]);
  }

  // A draft's card in the Drafts tab or under its line in the Files tab.
  function prDraftCard(pr: PullRequestDetail, d: Draft, where: "list" | "inline", anchor: ReturnType<typeof checkAnchor>): HTMLElement {
    const fixer = cb.draftFix(pr);
    const note =
      anchor === "general"
        ? "on the whole pull request — posts in the review message"
        : anchor === "no-file"
          ? "file not in this pull request — posts in the review message"
          : anchor === "no-line"
            ? "line not in this diff — posts in the review message"
            : null;
    const o: DraftCardOptions = {
      where,
      note,
      fix: fixer && d.path ? { reason: fixer.reason(d), run: () => fixer.run(d) } : null,
      showInDiff: where === "list" && anchor === "ok" && d.path ? () => showInDiff(d) : null,
      openCommit: cb.openCommit,
      changed: (redraw) => (redraw ? reviewsChanged() : saveSoon()),
      explain: d.finding ? { ...cb.draftExplaining(pr, d), run: () => cb.explainDraft(pr, d) } : null,
      file: where === "list" && d.path ? (files?.find((f) => f.path === d.path) ?? null) : null,
    };
    return draftCard(d, o);
  }

  // The Files tab, scrolled to the draft's card.
  function showInDiff(d: Draft): void {
    tab = "files";
    filesQuery = "";
    render();
    const find = (tries: number) => {
      // Its file may be among those not drawn yet.
      if (d.path) drawFile?.(d.path);
      const card = host.querySelector<HTMLElement>(`.pr-draft.inline[data-draft="${d.id}"]`);
      if (card) card.scrollIntoView({ block: "center" });
      else if (tries > 0) setTimeout(() => find(tries - 1), 100);
    };
    find(20);
  }

  // --- Checks ---------------------------------------------------------------

  // --- Commits -------------------------------------------------------------

  // The pull request's commits by the day they were made, as GitHub lists
  // them; one clicked shows its changed files instead.
  function renderCommits(body: HTMLElement, pr: PullRequestDetail): void {
    const open = pr.commits.findIndex((c) => c.oid === commitOpen);
    if (open >= 0) return void renderCommitFiles(body, pr, open);
    commitOpen = null;
    if (pr.commits.length === 0) {
      body.append(el("div", { class: "pr-empty", text: "No commits." }));
      return;
    }
    const list = el("div", { class: "pr-commits" });
    let day = "";
    for (const c of pr.commits) {
      const on = new Date(c.committed_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
      if (on !== day) {
        day = on;
        list.append(el("div", { class: "pr-commits-day", text: `Commits on ${on}` }));
      }
      const row = el("div", { class: "pr-commit", title: "Show the files it changes" }, [
        el("div", { class: "pr-commit-main" }, [
          el("span", { class: "pr-commit-headline", text: c.headline }),
          el("span", { class: "pr-commit-meta", text: commitMeta(c) }),
        ]),
        el("code", { class: "pr-commit-sha", text: c.oid.slice(0, 7) }),
        copySha(c.oid),
      ]);
      row.addEventListener("click", () => {
        commitOpen = c.oid;
        render();
      });
      whenPointedAt(row, () => void readCommitFiles(c.oid).catch(() => {}));
      list.append(row);
    }
    body.append(list);
  }

  function commitMeta(c: PullRequestDetail["commits"][number]): string {
    const who = c.authors.length ? c.authors.join(" and ") : "Someone";
    return `${who} committed ${relativeTime(isoSeconds(c.committed_at))}`;
  }

  function copySha(oid: string): HTMLElement {
    const b = el("button", { class: "btn small ghost", text: "Copy", title: `Copy ${oid}` });
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      void copyText(oid, `Copied ${oid.slice(0, 7)}`);
    });
    return b;
  }

  // Commit `at` of the pull request: its message, the way to the ones before
  // and after it, and the files it changes, read from GitHub once.
  function renderCommitFiles(body: HTMLElement, pr: PullRequestDetail, at: number): void {
    const c = pr.commits[at];
    const go = (oid: string | null) => {
      commitOpen = oid;
      render();
    };
    const step = (text: string, title: string, to: number) => {
      const b = el("button", { class: "btn small ghost", text, title });
      if (to < 0 || to >= pr.commits.length) b.setAttribute("disabled", "");
      else b.addEventListener("click", () => go(pr.commits[to].oid));
      return b;
    };
    const back = el("button", { class: "btn small ghost", text: "← All commits" });
    back.addEventListener("click", () => go(null));
    const head = el("div", { class: "pr-commit-head" }, [
      el("div", { class: "pr-commit-nav" }, [
        back,
        el("span", { class: "spacer" }),
        el("span", { class: "pr-commit-count", text: `Commit ${at + 1} of ${pr.commits.length}` }),
        step("‹ Previous", "The commit before it", at - 1),
        step("Next ›", "The commit after it", at + 1),
      ]),
      el("div", { class: "pr-commit-headline", text: c.headline }),
      ...(c.body.trim() ? [el("pre", { class: "pr-commit-body", text: c.body.trim() })] : []),
      el("div", { class: "pr-commit-nav" }, [
        el("span", { class: "pr-commit-meta", text: commitMeta(c) }),
        el("span", { class: "spacer" }),
        el("code", { class: "pr-commit-sha", text: c.oid.slice(0, 7), title: c.oid }),
        copySha(c.oid),
      ]),
    ]);
    // Unified or split, wrapped or not, as the Files tab is.
    const files = el("div", { class: `pr-files-diffs${loadDiffWrap() && !split ? " wrap-lines" : ""}` });
    body.append(head, files);
    const show = (list: FileDiff[]) => {
      clear(files);
      if (list.length === 0) files.append(el("div", { class: "pr-empty", text: "No changed files." }));
      for (const file of list) {
        const node = split ? renderSplitDiff(file) : renderFile(file);
        if (file.truncated) {
          node.append(el("div", { class: "diff-truncated", text: "This diff is too long to show in full here; open it on GitHub for the rest." }));
        }
        files.append(node);
      }
    };
    // Then the commits before and after it, so Previous and Next show at once.
    const readNeighbours = () => {
      for (const to of [at + 1, at - 1]) if (pr.commits[to]) readCommitFiles(pr.commits[to].oid).catch(() => {});
    };
    const known = commitFiles.get(c.oid);
    if (known) {
      show(known);
      readNeighbours();
      return;
    }
    files.append(el("div", { class: "pr-empty", text: "Loading the changed files…" }));
    const mine = generation;
    readCommitFiles(c.oid).then(
      (list) => {
        if (mine !== generation) return;
        if (tab === "commits" && commitOpen === c.oid) show(list);
        readNeighbours();
      },
      (err: unknown) => {
        if (mine !== generation || commitOpen !== c.oid) return;
        clear(files);
        files.append(el("div", { class: "pr-empty", text: "Couldn't load the changed files." }));
        cb.reportError(`Couldn't load the files of ${c.oid.slice(0, 7)}`, err);
      },
    );
  }

  // Commit `oid`'s changed files, read from GitHub once however many ask.
  function readCommitFiles(oid: string): Promise<FileDiff[]> {
    const known = commitFiles.get(oid);
    if (known) return Promise.resolve(known);
    let read = commitReads.get(oid);
    if (!read) {
      read = cb.fetchCommitFiles(oid);
      commitReads.set(oid, read);
      read.then(
        (list) => {
          // A commit's files never change: kept even when another load began.
          commitFiles.set(oid, list);
          commitReads.delete(oid);
        },
        () => commitReads.delete(oid),
      );
    }
    return read;
  }

  function renderChecks(body: HTMLElement, pr: PullRequestDetail): void {
    body.append(el("div", { class: "pr-checks-summary", text: checksSummary(pr.checks) }));
    const list = el("div", { class: "pr-checks" });
    for (const c of pr.checks) {
      const row = el("div", { class: "pr-check" }, [
        el("span", { class: `pr-check-dot ${c.state}`, title: c.state }),
        el("span", { class: "pr-check-name", text: c.name }),
        el("span", { class: "pr-check-state", text: c.state }),
      ]);
      if (c.url) {
        const url = c.url;
        row.append(smallButton("Details", () => cb.openUrl(url)));
      }
      list.append(row);
    }
    body.append(list);
  }

  function redraw(): void {
    if (!detail) return;
    // A finished review adds the Drafts tab beside the one the user is on.
    toDraftsIfReady();
    if (tab === "drafts" && !review().drafts.length) tab = "conversation";
    if (tab === "drafts" && !files) void showDrafts(detail);
    else render();
  }

  return {
    show: (n) => {
      if (prunedFor !== cb.repoPath()) {
        prunedFor = cb.repoPath();
        cb.pruneThreadConversations();
      }
      if (n !== number) {
        remember();
        treeSelected = null;
        treeCollapsed.clear();
        number = n;
        const kept = seen.get(n);
        detail = kept?.detail ?? storedPullRequest(cb.repoPath(), n);
        files = kept?.files ?? null;
        renderedTab = null;
        commitOpen = null;
        commitFiles.clear();
        commitReads.clear();
        viewed = null;
        searched = null;
        draft = "";
        filesQuery = "";
        lineDrafts.clear();
        signature = null;
        hideNotice();
        cb.restoreDrafts(n);
        // A review that finished while the user was elsewhere opens on its drafts.
        tab = review().drafts.some(isOpen) ? "drafts" : "conversation";
        draftsWhenReady = tab === "conversation";
      }
      if (cb.fetchSignature) stopPolling = startPolling("pr-view", PR_VIEW_POLL_MS, poll);
      // One opened before shows at once while it is read again.
      if (detail && renderedTab === null) redraw();
      void load(true);
    },
    reload: () => void load(true),
    focusThread: (thread) => {
      focus = thread;
      searched = thread;
      openBlocks.add(thread);
      tab = "conversation";
      draftsWhenReady = false;
      if (detail && detail.number === number) render();
    },
    redraw: () => redraw(),
    generateDrafts: () => {
      if (detail) cb.generateDrafts(detail);
    },
    generateDraftsWithSkill: () => {
      if (detail) cb.generateDraftsWithSkill(detail);
    },
    pushAndReplyAll: () => {
      if (detail) void pushAndReplyAll(detail);
    },
    loadReviewFile: () => {
      if (detail) void loadDrafts(detail);
    },
    reset: () => {
      generation++;
      openBlocks.clear();
      lastKind.clear();
      pendingReplyDraft.clear();
      replyOpen.clear();
      replyText.clear();
      followupText.clear();
      lineDrafts.clear();
      stopPolling?.();
      stopPolling = null;
      signature = null;
      waiting = null;
      hideNotice();
      prunedFor = null;
      focus = null;
      searched = null;
      number = null;
      detail = null;
      files = null;
      seen.clear();
      filesLoading = null;
      viewed = null;
      draft = "";
      renderedTab = null;
      clear(host);
    },
  };
}

// One comment, review or the description: who, when, what they did, and the
// text as Markdown.
function card(author: string, at: string, verb: string, body: string | null, actions: HTMLElement[], cls = ""): HTMLElement {
  const secs = isoSeconds(at);
  const head = el("div", { class: "pr-card-head" }, [el("span", { class: "pr-card-author", text: author })]);
  if (verb) head.append(el("span", { class: "pr-card-verb", text: verb }));
  if (secs) head.append(el("span", { class: "pr-card-time", text: relativeTime(secs), title: fullTime(secs) }));
  head.append(...actions);
  const node = el("div", { class: `pr-card ${cls}`.trim() }, [head]);
  node.style.setProperty("--author-hue", String(authorHue(author)));
  if (body !== null) node.append(body.trim() ? renderGitHubMarkdown(body) : el("div", { class: "pr-card-none", text: "No description provided." }));
  return node;
}

// The author's own hue, the same every time, so each one's comments stand out
// from the others' in a thread.
export function authorHue(author: string): number {
  let h = 0;
  for (const ch of author) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h * 137) % 360;
}

// A label in its GitHub color — only when the color is plain hex, since it
// lands in a style.
export function labelChip(label: PrLabel): HTMLElement {
  const chip = el("span", { class: "pr-label", text: label.name });
  if (/^[0-9a-f]{6}$/i.test(label.color)) chip.style.setProperty("--label", `#${label.color}`);
  return chip;
}

// Where a draft stands, for the Drafts tab's filters: still to decide, fixed
// (by a commit here, or by a fix round the review file tells of), discarded.
type DraftShow = "all" | "open" | "fixed" | "discarded";
function draftStanding(d: Draft): Exclude<DraftShow, "all"> {
  if (d.status === "discarded") return "discarded";
  if (d.status === "fixed" || fixedByNotes(d)) return "fixed";
  return "open";
}

// A button that opens a menu: its label, then the shared down chevron.
function withCaret<T extends HTMLElement>(b: T): T {
  b.classList.add("has-caret");
  b.append(menuCaret());
  return b;
}

function smallButton(text: string, onClick: () => void): HTMLElement {
  const b = el("button", { class: "btn small ghost", text });
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

// A comment box with its button (and Cancel when `onCancel`). `post`
// resolves true once posted, which clears the box.
function replyBox(placeholder: string, label: string, post: (text: string) => Promise<boolean>, onCancel?: () => void, focus = true): HTMLElement {
  const area = composerArea({ placeholder });
  const preview = previewToggle(area);
  const send = el("button", { class: "btn small", text: label });
  const submit = async () => {
    if (!area.value.trim()) return area.focus();
    send.disabled = true;
    const ok = await post(area.value);
    send.disabled = false;
    if (ok) {
      area.value = "";
      preview.edit();
    }
  };
  send.addEventListener("click", () => void submit());
  submitOnCmdEnter(area, submit);
  const actions = el("div", { class: "pr-composer-actions" }, [preview.button]);
  if (onCancel) {
    const cancel = el("button", { class: "btn small ghost", text: "Cancel" });
    cancel.addEventListener("click", onCancel);
    actions.append(cancel);
  }
  actions.append(send);
  const box = el("div", { class: "pr-composer" }, [area, actions]);
  // Clicks inside the box aren't clicks on the diff line it sits under.
  box.addEventListener("click", (e) => e.stopPropagation());
  // Not when opened again by a redraw: focus would scroll the view to it.
  if (focus) requestAnimationFrame(() => area.focus());
  return box;
}

function submitOnCmdEnter(area: HTMLTextAreaElement, submit: () => unknown): void {
  area.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  });
}
