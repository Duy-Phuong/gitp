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

import { clear, el, githubIcon } from "../dom";
import { renderGitHubMarkdown } from "./github-markdown";
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
import { checkAnchor, type DraftComment } from "../review-drafts";
import type { FileDiff, LineComment, PrLabel, PrReviewComment, PullRequestDetail, ReviewVerdict } from "../types";

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
  // Picks and reads a review file; its findings, or null when nothing was
  // picked (the caller has reported why).
  loadDrafts: (pr: PullRequestDetail) => Promise<DraftComment[] | null>;
  // Runs the review command over the diff; its findings, or null when it
  // failed or found nothing (the caller has reported why).
  generateDrafts: (pr: PullRequestDetail) => Promise<DraftComment[] | null>;
  // Posts one review with `comments` after the user confirms; true once it is
  // on GitHub.
  postReview: (pr: PullRequestDetail, verdict: ReviewVerdict, body: string, comments: LineComment[]) => Promise<boolean>;
  reportError: (title: string, err: unknown) => void;
}

// A loaded finding and what the user decided about it.
interface Draft extends DraftComment {
  id: number;
  status: "pending" | "approved" | "discarded";
}

export interface PullRequestHandle {
  // Load and show pull request `number`.
  show: (number: number) => void;
  // Read it again from GitHub — after a review posted from the menu, say.
  reload: () => void;
  // Forget it: the repo it belongs to is no longer the active one.
  reset: () => void;
}

type Tab = "conversation" | "files" | "checks" | "drafts";

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
  // The Files tab's search, kept across re-renders (a layout switch).
  let filesQuery = "";
  let split = loadPrDiffSplit();
  // The folder tree beside the diffs: shown or not, which folders are folded,
  // and the file last picked in it.
  let treeShown = loadPrFilesTree();
  const treeCollapsed = new Set<string>();
  let treeSelected: string | null = null;
  // Draft comments loaded from a review file, with the verdict and message
  // the review they'll be posted in will carry.
  let drafts: Draft[] = [];
  let draftsVerdict: ReviewVerdict = "comment";
  let draftsBody = "";

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
      ...(drafts.length ? [tabButton("drafts", `Drafts (${drafts.filter((d) => d.status !== "discarded").length})`)] : []),
      el("span", { class: "pr-diffstat" }, [
        el("span", { class: "pr-add", text: `+${pr.additions}` }),
        el("span", { class: "pr-del", text: `−${pr.deletions}` }),
      ]),
    );
    host.append(el("div", { class: "pr-view" }, [header(pr), tabs, body]));
    if (tab === "conversation") renderConversation(body, pr);
    else if (tab === "files") void renderFiles(body, pr);
    else if (tab === "drafts") renderDrafts(body, pr);
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
      button("Generate Drafts", () => void loadDrafts(pr, cb.generateDrafts), "Run the review command (Settings → Git) over the diff; its findings become draft comments to approve or discard"),
      button("Load Review File…", () => void loadDrafts(pr, cb.loadDrafts), "Read a review's findings as draft comments, to approve or discard before posting"),
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

  // --- Draft comments -------------------------------------------------------

  // Read a review file's findings into the Drafts tab. The changed files are
  // loaded too, so each draft can say whether its line is in the diff.
  async function loadDrafts(pr: PullRequestDetail, source: (pr: PullRequestDetail) => Promise<DraftComment[] | null>): Promise<void> {
    const found = await source(pr);
    if (!found || number !== pr.number) return;
    if (!files) {
      try {
        files = await cb.fetchFiles(pr.number);
      } catch {
        // Without the diff the anchors go unchecked; GitHub will still refuse a
        // bad one when posting.
      }
    }
    const next = drafts.length ? Math.max(...drafts.map((d) => d.id)) + 1 : 1;
    drafts = [...drafts, ...found.map((d, i) => ({ ...d, id: next + i, status: "pending" as const }))];
    tab = "drafts";
    render();
  }

  // Each draft: where it goes, its severity, the text (editable), and Approve
  // or Discard. Above them the review the approved ones will be posted as.
  function renderDrafts(body: HTMLElement, pr: PullRequestDetail): void {
    const live = drafts.filter((d) => d.status !== "discarded");
    if (live.length === 0 && drafts.length === 0) {
      body.append(el("div", { class: "pr-empty", text: "No draft comments. Load a review file to get some." }));
      return;
    }
    const anchorOf = (d: Draft) => (files ? checkAnchor(d, files) : "ok");
    const postable = drafts.filter((d) => d.status === "approved" && anchorOf(d) === "ok");
    const blocked = drafts.filter((d) => d.status === "approved" && anchorOf(d) !== "ok").length;

    const verdict = el("select", { class: "pr-drafts-verdict", "aria-label": "Review verdict" }) as HTMLSelectElement;
    for (const [value, label] of [
      ["comment", "Comment"],
      ["approve", "Approve"],
      ["request_changes", "Request changes"],
    ] as const) {
      const o = el("option", { value, text: label }) as HTMLOptionElement;
      o.selected = draftsVerdict === value;
      verdict.append(o);
    }
    verdict.addEventListener("change", () => (draftsVerdict = verdict.value as ReviewVerdict));
    const message = el("textarea", {
      class: "pr-composer-input pr-drafts-message",
      placeholder: "Review message (Markdown) — optional for Comment and Approve",
      spellcheck: "true",
    }) as HTMLTextAreaElement;
    message.value = draftsBody;
    message.addEventListener("input", () => (draftsBody = message.value));

    const n = postable.length;
    const postBtn = el("button", { class: "btn small", text: `Post ${n} approved` }) as HTMLButtonElement;
    postBtn.disabled = n === 0;
    postBtn.addEventListener("click", () => {
      postBtn.disabled = true;
      void cb
        .postReview(
          pr,
          draftsVerdict,
          draftsBody,
          postable.map((d) => ({ path: d.path, line: d.line, side: d.side, commit_id: pr.head_oid, body: d.body })),
        )
        .then(async (ok) => {
          if (!ok) {
            postBtn.disabled = false;
            return;
          }
          const posted = new Set(postable.map((d) => d.id));
          drafts = drafts.filter((d) => !posted.has(d.id));
          draftsBody = "";
          if (!drafts.some((d) => d.status !== "discarded")) {
            drafts = [];
            tab = "conversation";
          }
          await load(true);
        });
    });
    const setAll = (status: Draft["status"]) => {
      for (const d of drafts) if (d.status !== "discarded" || status === "pending") d.status = status;
      render();
    };
    const summary = `${live.length} draft${live.length === 1 ? "" : "s"} · ${drafts.filter((d) => d.status === "approved").length} approved${blocked ? ` · ${blocked} can't be posted (line not in this diff)` : ""}`;
    body.append(
      el("div", { class: "pr-drafts-bar" }, [
        el("span", { class: "pr-drafts-summary", text: summary }),
        smallButton("Approve All", () => setAll("approved")),
        smallButton("Clear", () => {
          drafts = [];
          tab = "conversation";
          render();
        }),
        el("span", { class: "spacer" }),
        verdict,
        postBtn,
      ]),
      message,
    );
    for (const d of drafts) body.append(draftCard(d, anchorOf(d)));
  }

  function draftCard(d: Draft, anchor: ReturnType<typeof checkAnchor>): HTMLElement {
    const head = el("div", { class: "pr-draft-head" }, [
      el("code", { class: "pr-draft-where", text: `${d.path}:${d.line}${d.side === "LEFT" ? " (removed line)" : ""}` }),
    ]);
    if (d.severity) head.append(el("span", { class: `pr-draft-sev ${d.severity.replace(/\W+/g, "-")}`, text: d.severity }));
    if (anchor !== "ok") {
      head.append(
        el("span", {
          class: "pr-draft-warn",
          text: anchor === "no-file" ? "file not in this pull request" : "line not in this diff",
          title: "GitHub only takes comments on lines that are part of the diff; this one can't be posted as it stands.",
        }),
      );
    }
    head.append(el("span", { class: "spacer" }));
    const toggle = (status: Draft["status"]) => () => {
      d.status = d.status === status ? "pending" : status;
      render();
    };
    if (d.status !== "discarded") {
      head.append(smallButton(d.status === "approved" ? "Approved ✓" : "Approve", toggle("approved")));
      head.append(smallButton("Discard", toggle("discarded")));
    } else {
      head.append(smallButton("Restore", toggle("discarded")));
    }
    const card = el("div", { class: `pr-draft ${d.status}` }, [head]);
    if (d.status !== "discarded") {
      const area = el("textarea", { class: "pr-composer-input pr-draft-text", spellcheck: "true" }) as HTMLTextAreaElement;
      area.value = d.body;
      area.addEventListener("input", () => (d.body = area.value));
      card.append(area);
    }
    return card;
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
        drafts = [];
        draftsBody = "";
        treeSelected = null;
        treeCollapsed.clear();
      }
      if (n !== number) {
        number = n;
        detail = null;
        files = null;
        draft = "";
        filesQuery = "";
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
      drafts = [];
      draftsBody = "";
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
