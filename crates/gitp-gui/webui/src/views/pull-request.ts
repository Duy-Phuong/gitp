// The pull request view: a GitHub pull request's title, state, branches,
// labels and actions, then three tabs — the conversation (description,
// comments, reviews and line-comment threads in time order, with a box to
// comment), the changed files as diffs (click a line to comment on it), and
// the checks.
//
// Everything in it came from GitHub and was written by other people, so none
// of it goes through innerHTML: Markdown is rendered by markdown-preview.ts,
// which builds text nodes, and the rest is set as text.

import { clear, el, githubIcon } from "../dom";
import { renderGitHubMarkdown } from "./github-markdown";
import { renderFile } from "./detail";
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
  threadsByLine,
  type Thread,
} from "../pull-requests";
import { fullTime, relativeTime } from "../timeago";
import type { FileDiff, LineComment, PrLabel, PrReviewComment, PullRequestDetail } from "../types";

export interface PullRequestCallbacks {
  fetchDetail: (number: number) => Promise<PullRequestDetail>;
  fetchFiles: (number: number) => Promise<FileDiff[]>;
  checkout: (pr: PullRequestDetail) => void;
  // Asks for the folder at (x, y), then checks out there.
  checkoutInWorktree: (pr: PullRequestDetail, x: number, y: number) => void;
  // Approve / Request Changes / Comment, from a menu at (x, y).
  reviewMenu: (pr: PullRequestDetail, x: number, y: number) => void;
  openUrl: (url: string) => void;
  // Each posts after the user confirms, resolving true once it's on GitHub;
  // the view then reloads the conversation.
  comment: (pr: PullRequestDetail, body: string) => Promise<boolean>;
  reply: (pr: PullRequestDetail, root: PrReviewComment, body: string) => Promise<boolean>;
  lineComment: (pr: PullRequestDetail, comment: LineComment) => Promise<boolean>;
  reportError: (title: string, err: unknown) => void;
}

export interface PullRequestHandle {
  // Load and show pull request `number`.
  show: (number: number) => void;
  // Read it again from GitHub — after a review posted from the menu, say.
  reload: () => void;
  // Forget it: the repo it belongs to is no longer the active one.
  reset: () => void;
}

type Tab = "conversation" | "files" | "checks";

export function setupPullRequestView(host: HTMLElement, cb: PullRequestCallbacks): PullRequestHandle {
  let number: number | null = null;
  let detail: PullRequestDetail | null = null;
  let files: FileDiff[] | null = null;
  let tab: Tab = "conversation";
  // Drops an answer for a pull request that is no longer the one on screen.
  let generation = 0;
  // The comment box at the bottom of the conversation, kept across re-renders
  // so a reload doesn't throw away what's being written.
  let draft = "";

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
      render();
    } catch (err) {
      if (mine !== generation) return;
      message(`Couldn't load pull request #${number}.`);
      cb.reportError(`Couldn't load pull request #${number}`, err);
    }
  }

  function render(): void {
    if (!detail) return;
    const pr = detail;
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
        render();
      });
      return b;
    };
    tabs.append(
      tabButton("conversation", `Conversation (${prTimeline(pr).length})`),
      tabButton("files", `Files changed (${pr.changed_files})`),
      tabButton("checks", `Checks (${pr.checks.length})`),
      el("span", { class: "pr-diffstat" }, [
        el("span", { class: "pr-add", text: `+${pr.additions}` }),
        el("span", { class: "pr-del", text: `−${pr.deletions}` }),
      ]),
    );
    host.append(el("div", { class: "pr-view" }, [header(pr), tabs, body]));
    if (tab === "conversation") renderConversation(body, pr);
    else if (tab === "files") void renderFiles(body, pr);
    else renderChecks(body, pr);
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
    const open = button("Open on GitHub", () => cb.openUrl(pr.url));
    open.prepend(githubIcon());
    const actions = el("div", { class: "pr-actions" }, [
      button("Check Out", () => cb.checkout(pr), `gh pr checkout ${pr.number}: a local branch tracking ${pr.head}`),
      button("Check Out in New Worktree…", (e) => cb.checkoutInWorktree(pr, e.clientX, e.clientY)),
      button("Review ▾", (e) => cb.reviewMenu(pr, e.clientX, e.clientY), "Approve, request changes or comment"),
      open,
      button("Refresh", () => void load(false), "Read it again from GitHub"),
    ]);
    return el("div", { class: "pr-head" }, [
      el("div", { class: "pr-title-row" }, [
        el("span", { class: "pr-title", text: pr.title }),
        el("span", { class: "pr-number", text: `#${pr.number}` }),
      ]),
      meta,
      actions,
    ]);
  }

  // --- Conversation ---------------------------------------------------------

  function renderConversation(body: HTMLElement, pr: PullRequestDetail): void {
    const area = el("textarea", { class: "pr-composer-input", placeholder: "Leave a comment (Markdown)", spellcheck: "true" }) as HTMLTextAreaElement;
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
        body.append(card(c.author, c.created_at, "commented", c.body, [smallButton("Quote Reply", () => quote(c.author, c.body))]));
      } else if (item.kind === "review") {
        const r = item.review;
        const actions = r.body.trim() ? [smallButton("Quote Reply", () => quote(r.author, r.body))] : [];
        body.append(card(r.author, r.submitted_at, reviewVerb(r.state), r.body.trim() || null, actions, `pr-review ${r.state.toLowerCase()}`));
      } else {
        body.append(threadNode(pr, item.thread, true));
      }
    }

    const post = el("button", { class: "btn small", text: "Comment" }) as HTMLButtonElement;
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
    body.append(el("div", { class: "pr-composer" }, [area, el("div", { class: "pr-composer-actions" }, [post])]));
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
    for (const c of [root, ...thread.replies]) node.append(card(c.author, c.created_at, "", c.body, [], "pr-thread-comment"));
    const open = smallButton("Reply…", () => {
      open.replaceWith(
        replyBox("Reply (Markdown)", "Reply", async (text) => {
          if (!(await cb.reply(pr, root, text))) return false;
          await load(true);
          return true;
        }),
      );
    });
    node.append(el("div", { class: "pr-thread-actions" }, [open]));
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
    body.append(el("div", { class: "pr-files-hint", text: "Click a line to comment on it." }));
    const threads = threadsByLine(reviewThreads(pr.review_comments));
    for (const file of files) body.append(annotatedFile(pr, file, threads));
  }

  // A file's diff, as elsewhere, with its threads under their lines and a
  // comment box on any line clicked.
  function annotatedFile(pr: PullRequestDetail, file: FileDiff, threads: Map<string, Thread[]>): HTMLElement {
    const node = renderFile(file);
    const lineOf = (row: Element) => {
      const hunk = Number(row.closest<HTMLElement>(".hunk")?.dataset.hunk);
      const at = Number((row as HTMLElement).dataset.line);
      return file.hunks[hunk]?.lines[at];
    };
    for (const row of node.querySelectorAll<HTMLElement>(".diff-line")) {
      const line = lineOf(row);
      const target = line && lineTarget(line);
      if (!target) continue;
      row.classList.add("pr-commentable");
      let after: Element = row;
      for (const t of threads.get(lineKey(file.path, target.side, target.line)) ?? []) {
        const n = threadNode(pr, t, false);
        after.after(n);
        after = n;
      }
    }
    if (file.truncated) {
      node.append(el("div", { class: "diff-truncated", text: "This diff is too long to show in full here; open it on GitHub for the rest." }));
    }
    node.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest(".diff-line.pr-commentable");
      // A drag that selected text is a copy, not a click on the line.
      if (!row || !window.getSelection()?.isCollapsed) return;
      const next = row.nextElementSibling;
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
      row.after(box);
    });
    return node;
  }

  // --- Checks ---------------------------------------------------------------

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
      if (n !== number) {
        number = n;
        detail = null;
        files = null;
        draft = "";
        tab = "conversation";
      }
      void load(true);
    },
    reload: () => void load(true),
    reset: () => {
      generation++;
      number = null;
      detail = null;
      files = null;
      draft = "";
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
  if (body !== null) node.append(body.trim() ? renderGitHubMarkdown(body) : el("div", { class: "pr-card-none", text: "No description provided." }));
  return node;
}

// A label in its GitHub color — only when the color is plain hex, since it
// lands in a style.
function labelChip(label: PrLabel): HTMLElement {
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
  const area = el("textarea", { class: "pr-composer-input", placeholder, spellcheck: "true" }) as HTMLTextAreaElement;
  const send = el("button", { class: "btn small", text: label }) as HTMLButtonElement;
  const submit = async () => {
    if (!area.value.trim()) return area.focus();
    send.disabled = true;
    const ok = await post(area.value);
    send.disabled = false;
    if (ok) area.value = "";
  };
  send.addEventListener("click", () => void submit());
  submitOnCmdEnter(area, submit);
  const actions = el("div", { class: "pr-composer-actions" });
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
