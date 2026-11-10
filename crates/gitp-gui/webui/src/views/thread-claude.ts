// Claude on a line-comment thread of a pull request: the three buttons the
// thread offers (Check, Explain simply, Reply with Claude) and the block
// under the thread that shows the conversation — Claude's answers, the
// user's follow-ups, a composer for the next one, Clear — collapsed to one
// line once it has been read. Everything Claude wrote is Markdown rendered
// through renderGitHubMarkdown, never innerHTML, like the comments around it.

import { el } from "../dom";
import { renderGitHubMarkdown } from "./github-markdown";
import { composerArea } from "./composer";
import { relativeTime, fullTime } from "../timeago";
import { lastFix, NO_OPTION_CHOSEN, preparedReply, sameCommit, type ThreadState } from "../pr-threads";
import { fixChangesNode } from "../fix-changes";
import type { CommitDetail, ThreadConversation, ThreadTurn, TurnKind } from "../types";

// What a button starts: a follow-up has its own composer.
export type ClaudeAction = "check" | "explain" | "reply-draft";

export interface ClaudeButton {
  action: ClaudeAction;
  label: string;
  disabled: boolean;
  running: boolean;
}

const ACTIONS: [ClaudeAction, string][] = [
  ["check", "Check"],
  ["explain", "Explain simply"],
  ["reply-draft", "Reply with Claude"],
];

// The buttons a thread shows: none once resolved; while a turn runs, the one
// that started it marked and every one disabled.
export function threadClaudeButtons(resolved: boolean, running: TurnKind | null): ClaudeButton[] {
  if (resolved) return [];
  return ACTIONS.map(([action, label]) => ({
    action,
    label: running === action ? `${label}…` : label,
    disabled: running !== null,
    running: running === action,
  }));
}

export const TURN_LABELS: Record<TurnKind, string> = {
  check: "Check",
  explain: "Explain",
  followup: "Follow-up",
  "reply-draft": "Reply draft",
  fix: "Fix",
};

// What the thread has ready, for its badges: a committed fix, a reply
// ready to post, or the latest reply posted.
export function threadBadges(c: ThreadConversation | null): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (lastFix(c)) out.push("fixed");
  const drafts = c.turns.filter((t) => t.kind === "reply-draft" && t.role === "claude");
  const last = drafts[drafts.length - 1];
  if (preparedReply(c)) out.push("reply ready");
  else if (last?.posted) out.push("posted");
  return out;
}

const lastClaude = (c: ThreadConversation): ThreadTurn | undefined => [...c.turns].reverse().find((t) => t.role === "claude");

// The collapsed line: "Claude · 3 turns · Follow-up 2m ago".
export function conversationSummary(c: ThreadConversation): string {
  const n = c.turns.length;
  const last = lastClaude(c) ?? c.turns[c.turns.length - 1];
  const when = last ? `${TURN_LABELS[last.kind]} ${relativeTime(Math.floor(last.at / 1000))}` : "nothing yet";
  return `Claude · ${n} turn${n === 1 ? "" : "s"} · ${when}`;
}

// The options of the last Markdown table in `text` with an "Option" column
// (the Check prompt asks for its options in one): that column's cells,
// without Markdown marks.
export function optionsIn(text: string): string[] {
  const lines = text.split("\n").map((l) => l.trim());
  const cells = (row: string) => row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const plain = (c: string) => c.replace(/\*\*|__|`|\*/g, "").trim();
  let found: string[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].startsWith("|") || !/^\|[\s:|-]+$/.test(lines[i + 1])) continue;
    const col = cells(lines[i]).findIndex((h) => /option/i.test(h));
    const rows: string[] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].startsWith("|"); j++) {
      const cell = col >= 0 ? plain(cells(lines[j])[col] ?? "") : "";
      if (cell) rows.push(cell);
    }
    if (rows.length) found = rows;
    i = j - 1;
  }
  return found;
}

// The options Claude gave last in the conversation, if any.
function latestOptions(c: ThreadConversation): string[] {
  for (const t of [...c.turns].reverse()) {
    if (t.role !== "claude") continue;
    const options = optionsIn(t.text);
    if (options.length) return options;
  }
  return [];
}

// The follow-up line an option's checkbox puts in the box.
const chosen = (option: string) => `I choose: ${option}`;

// A checkbox per option above the follow-up box: ticking one adds its line to
// the box, unticking takes it out; what else is typed stays. Each box shows
// whether its line is in the text, so a redraw or typing keeps them right.
// "Fix with this" beside them, when Fix is offered: saves what the box holds
// as the user's choice and starts the fix, with no follow-up to wait for. Off
// with nothing ticked, or for `blocked`. With a fix running elsewhere on the
// pull request (`queuesAfter`) it queues; once queued, it says its place.
function optionPicker(
  options: string[],
  area: HTMLTextAreaElement,
  running: boolean,
  onDraft?: (text: string) => void,
  fixWith?: { blocked: string | null; queuesAfter?: string | null; queued?: QueuedInfo; run: (text: string) => void },
): HTMLElement {
  const row = el("div", { class: "pr-thread-options" }, [el("span", { class: "pr-thread-options-label", text: "Options" })]);
  const boxes: [HTMLInputElement, string][] = [];
  const queued = fixWith?.queued;
  const fixButton = fixWith ? el("button", { class: "btn small", text: queued ? queued.label : "Fix with this" }) : null;
  // Why it is off, or that it queues, beside it: a title alone is easy to miss.
  const why = el("span", { class: "pr-thread-options-why" });
  const sync = () => {
    const lines = area.value.split("\n");
    for (const [box, option] of boxes) box.checked = lines.includes(chosen(option));
    if (fixButton && fixWith) {
      const ticked = boxes.some(([b]) => b.checked);
      fixButton.disabled = running || queued !== undefined || fixWith.blocked !== null || !ticked;
      fixButton.title = queued
        ? queued.note
        : (fixWith.blocked ??
          (fixWith.queuesAfter
            ? `Queue the fix for the ticked option: it starts when the fix on ${fixWith.queuesAfter} ends`
            : "Make the change for the ticked option now: no follow-up to wait for"));
      why.textContent = queued
        ? ""
        : (fixWith.blocked ?? (!ticked ? "Tick an option" : fixWith.queuesAfter ? `Queues after the fix on ${fixWith.queuesAfter}` : ""));
    }
  };
  for (const option of options) {
    const box = el("input", { type: "checkbox" });
    box.disabled = running;
    box.addEventListener("change", () => {
      const lines = area.value.split("\n").filter((l) => l !== chosen(option));
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      if (box.checked) lines.push(chosen(option));
      area.value = lines.join("\n");
      onDraft?.(area.value);
      sync();
    });
    boxes.push([box, option]);
    row.append(el("label", { class: "pr-thread-option", title: option }, [box, el("span", { text: option })]));
  }
  if (fixButton && fixWith) {
    fixButton.addEventListener("click", () => {
      const text = area.value.trim();
      if (!text) return;
      area.value = "";
      onDraft?.("");
      sync();
      fixWith.run(text);
    });
    row.append(fixButton, why);
  }
  area.addEventListener("input", sync);
  sync();
  row.addEventListener("click", (e) => e.stopPropagation());
  return row;
}

export interface ConversationOptions {
  state: ThreadState;
  // The pull request's head: a turn made against another is marked.
  head: string;
  open: boolean;
  // The kind the last failed turn was, for Try again.
  lastKind: TurnKind | null;
  // What the follow-up box holds, kept by the view across redraws.
  draft?: string;
  onDraft?: (text: string) => void;
  onFollowup: (text: string) => void;
  // Fix, when the view offers it: off with the reason as the button's title;
  // `queuesAfter`, a fix running elsewhere on the pull request ("path:line"),
  // which this one would wait for.
  fix?: { disabled: string | null; queuesAfter?: string | null };
  // This thread's fix waits in the pull request's queue.
  queued?: QueuedInfo;
  // While this thread's fix runs: how many wait after it.
  queuedBehind?: number;
  onFix?: () => void;
  // Save the chosen option (what the follow-up box holds) and start Fix.
  onChooseFix?: (text: string) => void;
  // Drop the prepared reply.
  onDrop?: () => void;
  // A resolved thread's block: the turns and Clear, nothing that starts one.
  readOnly?: boolean;
  onClear: () => void;
  onRetry: (kind: TurnKind) => void;
  onCancel: () => void;
  onToggle: () => void;
  // A fix's commit: read it for the changes under the turn, open it in History.
  loadCommit?: (commit: string) => Promise<CommitDetail>;
  openCommit?: (commit: string) => void;
}

// A waiting fix: its button's label ("Queued · 2nd"), what it waits for,
// and how to take it off the queue.
export interface QueuedInfo {
  label: string;
  note: string;
  cancel: () => void;
}

// The block under a thread.
export function conversationNode(o: ConversationOptions): HTMLElement {
  const { state, head, open } = o;
  const c = state.conversation;
  const node = el("div", { class: `pr-thread-claude${open ? " open" : ""}` });
  const summary = c ? conversationSummary(c) : "Claude";
  const headLine = el("div", { class: "pr-thread-claude-head" }, [
    el("span", { class: "pr-thread-claude-arrow", text: open ? "▾" : "▸" }),
    el("span", { text: summary }),
  ]);
  headLine.addEventListener("click", (e) => {
    e.stopPropagation();
    o.onToggle();
  });
  node.append(headLine);
  if (!open && !state.running && !state.error && !o.queued) return node;

  const body = el("div", { class: "pr-thread-claude-body" });
  if (open && c) {
    for (const t of c.turns) body.append(turnNode(t, head, o));
    // The pull request moved on since the last Check: offer another.
    const stale = c.turns.some((t) => t.role === "claude" && t.kind === "check" && t.head && !sameCommit(t.head, head));
    if (stale && !state.running && !o.readOnly) {
      const again = el("button", { class: "btn small ghost", text: "Check again" });
      again.addEventListener("click", (e) => {
        e.stopPropagation();
        o.onRetry("check");
      });
      body.append(el("div", { class: "pr-thread-claude-stale" }, [el("span", { text: "The pull request has new commits since." }), again]));
    }
  }
  if (o.queued) {
    const { note, cancel: onCancel } = o.queued;
    const cancel = el("button", { class: "btn small ghost", text: "Cancel", title: "Take this fix off the queue" });
    cancel.addEventListener("click", (e) => {
      e.stopPropagation();
      onCancel();
    });
    body.append(el("div", { class: "pr-thread-claude-queued" }, [el("span", { text: `⏳ ${note}` }), cancel]));
  }
  if (state.running) {
    const cancel = el("button", { class: "btn small ghost", text: "Cancel" });
    cancel.addEventListener("click", (e) => {
      e.stopPropagation();
      o.onCancel();
    });
    body.append(
      el("div", { class: "pr-thread-claude-running" }, [
        el("span", { class: "spinner" }),
        el("span", {
          text:
            state.running === "fix"
              ? `Claude is fixing (change, test, commit)…${o.queuedBehind ? ` · ${o.queuedBehind} queued after this` : ""}`
              : `Claude is thinking (${TURN_LABELS[state.running]})…`,
        }),
        cancel,
      ]),
    );
  }
  if (state.error) {
    const line = el("div", { class: "pr-thread-claude-error" }, [el("span", { text: state.error })]);
    if (o.lastKind) {
      const kind = o.lastKind;
      const retry = el("button", { class: "btn small ghost", text: "Try again" });
      retry.addEventListener("click", (e) => {
        e.stopPropagation();
        o.onRetry(kind);
      });
      line.append(retry);
    }
    body.append(line);
  }
  if (open && c && o.readOnly) {
    const clear = el("button", { class: "btn small ghost", text: "Clear" });
    clear.addEventListener("click", (e) => {
      e.stopPropagation();
      o.onClear();
    });
    body.append(el("div", { class: "pr-composer-actions" }, [clear]));
  } else if (open && c) {
    const area = composerArea({ placeholder: "Ask a follow-up…" });
    if (o.draft) area.value = o.draft;
    area.addEventListener("input", () => o.onDraft?.(area.value));
    const send = el("button", { class: "btn small", text: "Send" });
    const clear = el("button", { class: "btn small ghost", text: "Clear" });
    const actions = [clear, send];
    if (o.fix) {
      const reason = o.fix.disabled;
      const fix = el("button", {
        class: "btn small",
        text: "Fix",
        title:
          reason ??
          (o.queued
            ? o.queued.note
            : o.fix.queuesAfter
              ? `Queue the fix: it starts when the fix on ${o.fix.queuesAfter} ends`
              : "Make the change for the chosen option in the branch's worktree, commit it, and prepare the reply"),
      });
      fix.disabled = state.running !== null || reason !== null || o.queued !== undefined;
      fix.addEventListener("click", (e) => {
        e.stopPropagation();
        o.onFix?.();
      });
      actions.push(fix);
    }
    clear.disabled = state.running !== null;
    send.disabled = state.running !== null;
    const submit = () => {
      const text = area.value.trim();
      if (!text) return area.focus();
      area.value = "";
      o.onDraft?.("");
      o.onFollowup(text);
    };
    send.addEventListener("click", (e) => {
      e.stopPropagation();
      submit();
    });
    area.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    });
    clear.addEventListener("click", (e) => {
      e.stopPropagation();
      o.onClear();
    });
    const options = latestOptions(c);
    // Fix with this ignores "no option chosen": it chooses one.
    const fixWith =
      o.fix && o.onChooseFix
        ? { blocked: o.fix.disabled === NO_OPTION_CHOSEN ? null : o.fix.disabled, queuesAfter: o.fix.queuesAfter, queued: o.queued, run: o.onChooseFix }
        : undefined;
    const picker = options.length ? [optionPicker(options, area, state.running !== null, o.onDraft, fixWith)] : [];
    const box = el("div", { class: "pr-composer pr-thread-claude-composer" }, [...picker, area, el("div", { class: "pr-composer-actions" }, actions)]);
    box.addEventListener("click", (e) => e.stopPropagation());
    body.append(box);
  }
  node.append(body);
  return node;
}

// One turn: who, which kind, when, against which commit, and the text.
function turnNode(t: ThreadTurn, head: string, o?: Pick<ConversationOptions, "loadCommit" | "openCommit">): HTMLElement {
  const secs = Math.floor(t.at / 1000);
  const who = t.role === "user" ? "you" : "Claude";
  const headLine = el("div", { class: "pr-card-head" }, [
    el("span", { class: "pr-card-author", text: who }),
    el("span", { class: "pr-card-verb", text: TURN_LABELS[t.kind] }),
    el("span", { class: "pr-card-time", text: relativeTime(secs), title: fullTime(secs) }),
  ]);
  // A fix moves the code on purpose, and a reply draft is not an analysis.
  const analysis = t.kind === "check" || t.kind === "explain" || t.kind === "followup";
  if (t.role === "claude" && analysis && t.head && !sameCommit(t.head, head)) {
    headLine.append(
      el("span", {
        class: "pr-badge",
        text: "older commit",
        title: `Made against ${t.head.slice(0, 7)}; the pull request has moved on since.`,
      }),
    );
  }
  const node = el("div", { class: `pr-thread-claude-turn ${t.role}` }, [headLine]);
  node.append(t.role === "user" ? el("div", { class: "pr-thread-claude-text", text: t.text }) : renderGitHubMarkdown(t.text));
  if (t.kind === "fix" && t.commit && o?.loadCommit) {
    node.append(fixChangesNode(t.commit, t.worktree ?? null, o.loadCommit, o.openCommit));
  } else if (t.kind === "fix" && t.commit) {
    const where = t.worktree ? ` in ${t.worktree.replace(/\/$/, "").split("/").pop()}` : "";
    node.append(el("div", { class: "pr-thread-claude-commit", text: `Commit ${t.commit.slice(0, 7)}${where}` }));
  }
  return node;
}
