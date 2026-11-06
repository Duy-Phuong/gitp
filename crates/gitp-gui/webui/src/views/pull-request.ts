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

import { clear, el, svg } from "../dom";
import { renderGitHubMarkdown } from "./github-markdown";
import { conversationNode, threadBadges, threadClaudeButtons } from "./thread-claude";
import { fixDisabledReason, fixRunningOn, preparedReplies, runningTurns, threadState } from "../pr-threads";
import { composerArea, previewToggle } from "./composer";
import { iconBtn, renderFile, renderSplitDiff, WRAP_ICON } from "./detail";
import { loadDiffWrap, loadPrDiffSplit, loadPrFilesTree, saveDiffWrap, savePrDiffSplit, savePrFilesTree } from "../prefs";
import { renderFileTree } from "./tree";
import {
  checksSummary,
  isoSeconds,
  lineKey,
  lineTarget,
  prTimeline,
  quoteReply,
  reviewDecisionLabel,
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
import {
  clearDrafts,
  hasNewCommits,
  markPosted,
  prReview,
  reviewsChanged,
  setReviewedHead,
  type Draft,
  type PrReview,
} from "../pr-reviews";
import type { FileDiff, LineComment, PrLabel, PrReviewComment, PrReviewThread, PullRequestDetail, ReviewVerdict, TurnKind } from "../types";

export interface PullRequestCallbacks {
  fetchDetail: (number: number) => Promise<PullRequestDetail>;
  fetchFiles: (number: number) => Promise<FileDiff[]>;
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
  // Fix the thread as the chosen option says, in the branch's worktree,
  // commit, and prepare the reply; drop a prepared reply after a confirm.
  fixThread: (pr: PullRequestDetail, thread: Thread) => void;
  dropReply: (pr: PullRequestDetail, thread: Thread) => Promise<void>;
  // Pushes the branch and posts every reply Claude has ready, after one
  // confirm; `edited` is what the Reply boxes hold. True once done.
  pushAndReplyAll: (pr: PullRequestDetail, edited: Map<number, string>) => Promise<boolean>;
  cancelThreadTurn: (pr: PullRequestDetail, thread: Thread) => void;
  loadThreadConversation: (pr: PullRequestDetail, thread: Thread) => void;
  // True once forgotten; false when the user said no or it failed.
  clearThreadConversation: (pr: PullRequestDetail, thread: Thread) => Promise<boolean>;
  pruneThreadConversations: () => void;
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
  // Draw it again from what it holds: a review in the background moved on.
  redraw: () => void;
  // Forget it: the repo it belongs to is no longer the active one.
  reset: () => void;
}

type Tab = "conversation" | "commits" | "files" | "checks" | "drafts";

// A page with lines: the saved review page.
const REVIEW_PAGE_ICON = ["M6 3h9l4 4v14H6z", "M14 3v5h5", "M9 12h7", "M9 16h7"];
// An open book: the saved review, read inside gitp.
const READ_REVIEW_ICON = ["M3 5c3-1 6-1 9 1v14c-3-2-6-2-9-1z", "M21 5c-3-1-6-1-9 1v14c3-2 6-2 9-1z"];
// A box with an arrow out of it: the pull request on GitHub.
const PR_LINK_ICON = ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"];
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
  // Drops an answer for a pull request that is no longer the one on screen.
  let generation = 0;
  // The comment box at the bottom of the conversation, kept across re-renders
  // so a reload doesn't throw away what's being written.
  let draft = "";
  // The Files tab's search, kept across re-renders (a layout switch).
  let filesQuery = "";
  let split = loadPrDiffSplit();
  // The folder tree beside the diffs: shown or not, which folders are folded,
  // and the file last picked in it.
  let treeShown = loadPrFilesTree();
  const treeCollapsed = new Set<string>();
  let treeSelected: string | null = null;
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
  // What is typed in a thread's Reply box and follow-up box, by root comment
  // id, and which Reply boxes are open: a redraw (a turn ending on any
  // thread) keeps them, as `draft` keeps the bottom composer.
  const replyOpen = new Set<number>();
  const replyText = new Map<number, string>();
  const followupText = new Map<number, string>();

  const message = (text: string) => {
    clear(host);
    host.append(el("div", { class: "pr-view" }, [el("div", { class: "pr-empty", text })]));
  };

  async function load(keepFiles: boolean): Promise<void> {
    if (number === null) return;
    const mine = ++generation;
    if (!detail || detail.number !== number) message(`Loading pull request #${number}…`);
    if (!keepFiles) files = null;
    try {
      const d = await cb.fetchDetail(number);
      if (mine !== generation) return;
      detail = d;
      toDraftsIfReady();
      if (tab === "drafts" && !files) void showDrafts(d);
      else render();
    } catch (err) {
      if (mine !== generation) return;
      message(`Couldn't load pull request #${number}.`);
      cb.reportError(`Couldn't load pull request #${number}`, err);
    }
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
        ? [tabButton("drafts", `Drafts (${review().drafts.filter((d) => d.status !== "discarded").length})`)]
        : []),
      el("span", { class: "pr-diffstat" }, [
        el("span", { class: "pr-add", text: `+${pr.additions}` }),
        el("span", { class: "pr-del", text: `−${pr.deletions}` }),
      ]),
    );
    host.append(el("div", { class: "pr-view" }, [header(pr), tabs, body]));
    if (tab === "conversation") renderConversation(body, pr);
    else if (tab === "files") void renderFiles(body, pr).then(() => restore(body));
    else if (tab === "commits") renderCommits(body, pr);
    else if (tab === "drafts") renderDrafts(body, pr);
    else renderChecks(body, pr);
    restore(body);
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
    const decision = reviewDecisionLabel(pr.review_decision);
    if (decision) meta.append(el("span", { class: `pr-badge review-${pr.review_decision!.toLowerCase()}`, text: decision }));
    for (const label of pr.labels) meta.append(labelChip(label));

    const button = (text: string, onClick: (e: MouseEvent) => void, title?: string) => {
      const b = el("button", { class: "btn small ghost", text, title });
      b.addEventListener("click", onClick);
      return b;
    };
    const actions = el("div", { class: "pr-actions" }, [
      button("Check Out", () => cb.checkout(pr), `gh pr checkout ${pr.number}: a local branch tracking ${pr.head}`),
      button("Check Out in New Worktree…", (e) => cb.checkoutInWorktree(pr, e.clientX, e.clientY)),
      button("Review ▾", (e) => cb.reviewMenu(pr, e.clientX, e.clientY), "Approve, request changes or comment"),
      ...(review().running
        ? [button("Reviewing… Cancel", () => cb.cancelReview(pr), "The review command is running in the background; click to stop it")]
        : [generateButton(pr), skillButton(pr), ...pushAndReplyButton(pr)]),
      button("Load Review File…", () => void loadDrafts(pr), "Read a review's findings as draft comments, to approve or discard before posting"),
    ]);
    if (pr.state === "OPEN") {
      const merge = button("Merge…", () => cb.merge(pr), `Merge #${pr.number} into ${pr.base} on GitHub`);
      merge.classList.remove("ghost");
      actions.prepend(merge);
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
        titleLink(PR_LINK_ICON, `Open #${pr.number} on GitHub\n${pr.url}`, () => cb.openUrl(pr.url)),
      ]),
      meta,
      actions,
    ]);
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
  function fixElsewhere(pr: PullRequestDetail, thisThread: number): string | null {
    const id = fixRunningOn(cb.repoPath(), pr.number);
    if (id === null || id === thisThread) return null;
    const root = pr.review_comments.find((c) => c.id === id);
    return root ? `${root.path}:${root.line ?? root.original_line ?? "?"}` : "another thread";
  }

  // A line-comment thread: where it is, the code it is on, its comments, and
  // a Reply box behind a button. `withCode`: the conversation shows the lines
  // it was made on; the Files tab shows it under them already.
  function threadNode(pr: PullRequestDetail, thread: Thread, withCode: boolean): HTMLElement {
    const { root } = thread;
    const node = el("div", { class: "pr-thread" });
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
    // Resolved threads fold to their first comment, as on GitHub.
    const state = pr.review_threads.find((t) => t.comment_ids.includes(root.id));
    const resolved = state?.resolved ?? false;
    node.classList.toggle("resolved", resolved);
    if (resolved) {
      node.append(el("div", { class: "pr-thread-resolved" }, [el("span", { class: "pr-badge", text: "Resolved" }), el("span", { text: `${1 + thread.replies.length} comment${thread.replies.length ? "s" : ""}` })]));
    }
    for (const c of resolved ? [root] : [root, ...thread.replies]) node.append(card(c.author, c.created_at, "", c.body, [], "pr-thread-comment"));
    // The Reply box, above the actions row (which the Claude buttons share: a
    // box in the row would be squeezed beside them), with what was typed in
    // it kept across redraws.
    const openReply = () => {
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
      );
      const area = box.querySelector("textarea")!;
      area.value = replyText.get(root.id) ?? "";
      area.addEventListener("input", () => replyText.set(root.id, area.value));
      actions.before(box);
      open.remove();
    };
    const open = smallButton("Reply…", () => openReply());
    const actions = el("div", { class: "pr-thread-actions" }, [open]);
    // Claude on the thread: its conversation block, and the buttons that
    // start a turn — not on a resolved thread, as on GitHub nothing happens
    // there any more.
    if (!resolved) {
      cb.loadThreadConversation(pr, thread);
      const ts = threadState(cb.repoPath(), pr.number, root.id);
      const turn = (kind: TurnKind, text = "") => {
        lastKind.set(root.id, kind);
        openBlocks.add(root.id);
        cb.threadTurn(pr, thread, kind, text);
      };
      // Fix: only with an option chosen and no fix elsewhere on the pull
      // request; it ends in a reply draft, which lands in the Reply box.
      const fix = () => {
        if (fixDisabledReason(ts.conversation, fixElsewhere(pr, root.id))) return;
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
            draft: followupText.get(root.id),
            onDraft: (text) => followupText.set(root.id, text),
            onFollowup: (text) => turn("followup", text),
            fix: { disabled: fixDisabledReason(ts.conversation, fixElsewhere(pr, root.id)) },
            onFix: fix,
            onDrop: () => void cb.dropReply(pr, thread),
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
      for (const text of threadBadges(ts.conversation)) {
        actions.append(el("span", { class: "pr-badge pr-thread-ready", text }));
        if (text === "reply ready") actions.append(smallButton("Drop", () => void cb.dropReply(pr, thread)));
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
        smallButton(resolved ? "Unresolve" : "Resolve", () => {
          void cb.resolve(pr, state, !resolved).then((ok) => {
            if (ok) void load(true);
          });
        }),
      );
    }
    node.append(actions);
    if (replyOpen.has(root.id) || (replyText.get(root.id) ?? "") !== "") openReply();
    return node;
  }

  // --- Files changed --------------------------------------------------------

  async function renderFiles(body: HTMLElement, pr: PullRequestDetail): Promise<void> {
    if (!files) {
      body.append(el("div", { class: "pr-empty", text: "Loading the changed files…" }));
      const mine = generation;
      try {
        const loaded = await cb.fetchFiles(pr.number);
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
    const nodes = shown.map((file) => {
      const node = annotatedFile(pr, file, byLine, counts.get(file.path) ?? 0);
      node.dataset.path = file.path;
      return node;
    });

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
          nodes.find((n) => n.dataset.path === p)?.scrollIntoView({ block: "start" });
        },
      });
      // Files the search hid are dimmed in the tree too.
      for (const row of tree.querySelectorAll<HTMLElement>(".tree-file")) {
        row.classList.toggle("dim", nodes.find((n) => n.dataset.path === row.title)?.hidden ?? false);
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
      let files = 0;
      let lines = 0;
      searchFiles(shown, filesQuery).forEach((hits, i) => {
        const node = nodes[i];
        node.hidden = hits === null;
        for (const row of node.querySelectorAll(".pr-search-hit")) row.classList.remove("pr-search-hit");
        if (hits === null) return;
        files++;
        lines += hits.length;
        for (const [h, k] of hits) {
          for (const row of node.querySelectorAll(`.hunk[data-hunk="${h}"] [data-line="${k}"]`)) row.classList.add("pr-search-hit");
        }
      });
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
    columns.append(el("div", { class: `pr-files-diffs${wrap && !split ? " wrap-lines" : ""}` }, nodes));
    body.append(
      el("div", { class: "pr-files-bar" }, [
        el("div", { class: "tb-group" }, [treeToggle]),
        layout,
        el("div", { class: "tb-group" }, [wrapToggle]),
        search,
        count,
        el("span", { class: "pr-files-hint", text: "Click a line to comment on it." }),
      ]),
      columns,
    );
    applySearch();
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
    for (const row of node.querySelectorAll<HTMLElement>(".diff-line, .split-cell[data-line]")) {
      const line = lineOf(row);
      const target = line && lineTarget(line);
      if (!target) continue;
      row.classList.add("pr-commentable");
      const key = lineKey(file.path, target.side, target.line);
      if (placed.has(key)) continue;
      placed.add(key);
      // Below the threads the row's other side has put there already.
      let after = anchorOf(row);
      while (after.nextElementSibling?.classList.contains("pr-thread")) after = after.nextElementSibling;
      for (const t of threads.get(key) ?? []) {
        const n = threadNode(pr, t, false);
        after.after(n);
        after = n;
      }
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
      const where = `${file.path}:${target.line}${target.side === "LEFT" ? " (removed line)" : ""}`;
      const box = replyBox(`Comment on ${where} (Markdown)`, "Add Comment", async (text) => {
        const ok = await cb.lineComment(pr, { path: file.path, line: target.line, side: target.side, commit_id: pr.head_oid, body: text });
        if (ok) await load(true);
        return ok;
      }, () => box.remove());
      box.classList.add("pr-line-composer");
      anchor.after(box);
    });
    return node;
  }

  // Generate Drafts, with a green dot when commits arrived since the last
  // review: time to review again.
  function generateButton(pr: PullRequestDetail): HTMLElement {
    const reviewed = cb.reviewedHead(pr.number);
    const fresh = hasNewCommits(reviewed, pr.head_oid);
    const b = el("button", {
      class: `btn small ghost${fresh ? " pr-has-news" : ""}`,
      text: "Generate Drafts",
      title: fresh
        ? `New commits since the last review (${reviewed!.slice(0, 8)} → ${pr.head_oid.slice(0, 8)}): run the review command again`
        : "Run the review command (Settings → Git) in the background; its findings become draft comments to approve or discard",
    });
    b.addEventListener("click", () => cb.generateDrafts(pr));
    return b;
  }

  // Review with skill: the /review-pr-phuong skill in one click, whatever the
  // Review command preset in Settings says; the same green dot.
  function skillButton(pr: PullRequestDetail): HTMLElement {
    const fresh = hasNewCommits(cb.reviewedHead(pr.number), pr.head_oid);
    const b = el("button", {
      class: `btn small ghost${fresh ? " pr-has-news" : ""}`,
      text: "Review with skill",
      title: "Run the /review-pr-phuong Claude Code skill in the background, whatever the Review command preset; its review page becomes the drafts",
    });
    b.addEventListener("click", () => cb.generateDraftsWithSkill(pr));
    return b;
  }

  // Push and reply all: once a reply is ready or the branch is ahead of its
  // upstream; off while Claude works on the pull request.
  function pushAndReplyButton(pr: PullRequestDetail): HTMLElement[] {
    const ready = preparedReplies(cb.repoPath(), pr.number);
    const ahead = cb.branchAhead(pr.head);
    if (!ready && !ahead) return [];
    const b = el("button", {
      class: "btn small ghost",
      text: "Push and reply all",
      title: `${ahead ? `Push ${pr.head} (${ahead} ahead)` : "Nothing to push"}; ${ready ? `post ${ready} ${ready === 1 ? "reply" : "replies"} Claude has ready` : "no reply ready"} — after one confirm that lists both`,
    }) as HTMLButtonElement;
    b.disabled = runningTurns(cb.repoPath(), pr.number) > 0;
    b.addEventListener("click", () => void pushAndReplyAll(pr));
    return [b];
  }

  async function pushAndReplyAll(pr: PullRequestDetail): Promise<void> {
    const edited = new Map<number, string>();
    for (const [id, text] of replyText) if (text.trim()) edited.set(id, text);
    if (await cb.pushAndReplyAll(pr, edited)) {
      // The posted replies' boxes close; the reload drew them open still.
      for (const id of edited.keys()) {
        replyText.delete(id);
        replyOpen.delete(id);
      }
      render();
    }
  }

  // Drafts read back from a saved review just after the pull request opened
  // with none: show them, when no tab was picked meanwhile.
  function toDraftsIfReady(): void {
    if (draftsWhenReady && review().drafts.some((d) => d.status !== "discarded")) {
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
        files = await cb.fetchFiles(pr.number);
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
    const live = drafts.filter((d) => d.status !== "discarded");
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
          if (!r.drafts.some((d) => d.status !== "discarded")) {
            clearDrafts(cb.repoPath(), pr.number);
            tab = "conversation";
          }
          reviewsChanged();
          await load(true);
        });
    });
    const setAll = (status: Draft["status"]) => {
      for (const d of drafts) if (d.status !== "discarded" || status === "pending") d.status = status;
      reviewsChanged();
    };
    const summary = `${live.length} draft${live.length === 1 ? "" : "s"} · ${drafts.filter((d) => d.status === "approved").length} approved${offDiff.length ? ` · ${offDiff.length} in the review message (line not in this diff)` : ""}`;
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
    for (const d of drafts) body.append(draftCard(d, anchorOf(d)));
  }

  function draftCard(d: Draft, anchor: ReturnType<typeof checkAnchor>): HTMLElement {
    const head = el("div", { class: "pr-draft-head" }, [
      anchor === "general"
        ? el("span", { class: "pr-draft-where pr-draft-topic", text: d.topic ?? "On the pull request" })
        : el("code", { class: "pr-draft-where", text: `${d.path}:${d.line}${d.side === "LEFT" ? " (removed line)" : ""}` }),
    ]);
    if (d.severity) head.append(el("span", { class: `pr-draft-sev ${d.severity.replace(/\W+/g, "-")}`, text: d.severity }));
    if (anchor === "general") {
      head.append(el("span", { class: "pr-draft-note", text: "on the whole pull request — posts in the review message" }));
    } else if (anchor !== "ok") {
      head.append(
        el("span", {
          class: "pr-draft-warn",
          text: `${anchor === "no-file" ? "file not in this pull request" : "line not in this diff"} — posts in the review message`,
          title: "GitHub only takes line comments on lines of the diff, so this one goes in the review's message, linked to its line.",
        }),
      );
    }
    head.append(el("span", { class: "spacer" }));
    const toggle = (status: Draft["status"]) => () => {
      d.status = d.status === status ? "pending" : status;
      reviewsChanged();
    };
    if (d.status !== "discarded") {
      head.append(smallButton(d.status === "approved" ? "Approved ✓" : "Approve", toggle("approved")));
      head.append(smallButton("Discard", toggle("discarded")));
    } else {
      head.append(smallButton("Restore", toggle("discarded")));
    }
    const card = el("div", { class: `pr-draft ${d.status}` }, [head]);
    if (d.status !== "discarded") {
      const area = composerArea({ class: "pr-draft-text" });
      area.value = d.body;
      area.addEventListener("input", () => (d.body = area.value));
      head.append(previewToggle(area).button);
      card.append(area);
    }
    return card;
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
    const known = commitFiles.get(c.oid);
    if (known) return show(known);
    files.append(el("div", { class: "pr-empty", text: "Loading the changed files…" }));
    const mine = generation;
    cb.fetchCommitFiles(c.oid).then(
      (list) => {
        commitFiles.set(c.oid, list);
        if (mine === generation && tab === "commits" && commitOpen === c.oid) show(list);
      },
      (err: unknown) => {
        if (mine !== generation || commitOpen !== c.oid) return;
        clear(files);
        files.append(el("div", { class: "pr-empty", text: "Couldn't load the changed files." }));
        cb.reportError(`Couldn't load the files of ${c.oid.slice(0, 7)}`, err);
      },
    );
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

  return {
    show: (n) => {
      if (prunedFor !== cb.repoPath()) {
        prunedFor = cb.repoPath();
        cb.pruneThreadConversations();
      }
      if (n !== number) {
        treeSelected = null;
        treeCollapsed.clear();
        number = n;
        detail = null;
        files = null;
        commitOpen = null;
        commitFiles.clear();
        draft = "";
        filesQuery = "";
        cb.restoreDrafts(n);
        // A review that finished while the user was elsewhere opens on its drafts.
        tab = review().drafts.some((d) => d.status !== "discarded") ? "drafts" : "conversation";
        draftsWhenReady = tab === "conversation";
      }
      void load(true);
    },
    reload: () => void load(true),
    redraw: () => {
      if (!detail) return;
      // A finished review adds the Drafts tab beside the one the user is on.
      toDraftsIfReady();
      if (tab === "drafts" && !review().drafts.length) tab = "conversation";
      if (tab === "drafts" && !files) void showDrafts(detail);
      else render();
    },
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
      prunedFor = null;
      number = null;
      detail = null;
      files = null;
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
function replyBox(placeholder: string, label: string, post: (text: string) => Promise<boolean>, onCancel?: () => void): HTMLElement {
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
  requestAnimationFrame(() => area.focus());
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
