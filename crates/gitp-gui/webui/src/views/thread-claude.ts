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
import type { ThreadState } from "../pr-threads";
import type { ThreadConversation, ThreadTurn, TurnKind } from "../types";

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
};

const lastClaude = (c: ThreadConversation): ThreadTurn | undefined => [...c.turns].reverse().find((t) => t.role === "claude");

// The collapsed line: "Claude · 3 turns · Follow-up 2m ago".
export function conversationSummary(c: ThreadConversation): string {
  const n = c.turns.length;
  const last = lastClaude(c) ?? c.turns[c.turns.length - 1];
  const when = last ? `${TURN_LABELS[last.kind]} ${relativeTime(Math.floor(last.at / 1000))}` : "nothing yet";
  return `Claude · ${n} turn${n === 1 ? "" : "s"} · ${when}`;
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
  onClear: () => void;
  onRetry: (kind: TurnKind) => void;
  onCancel: () => void;
  onToggle: () => void;
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
  if (!open && !state.running && !state.error) return node;

  const body = el("div", { class: "pr-thread-claude-body" });
  if (open && c) for (const t of c.turns) body.append(turnNode(t, head));
  if (state.running) {
    const cancel = el("button", { class: "btn small ghost", text: "Cancel" });
    cancel.addEventListener("click", (e) => {
      e.stopPropagation();
      o.onCancel();
    });
    body.append(
      el("div", { class: "pr-thread-claude-running" }, [
        el("span", { class: "spinner" }),
        el("span", { text: `Claude is thinking (${TURN_LABELS[state.running]})…` }),
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
  if (open && c) {
    const area = composerArea({ placeholder: "Ask a follow-up…" });
    if (o.draft) area.value = o.draft;
    area.addEventListener("input", () => o.onDraft?.(area.value));
    const send = el("button", { class: "btn small", text: "Send" });
    const clear = el("button", { class: "btn small ghost", text: "Clear" }) as HTMLButtonElement;
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
    const box = el("div", { class: "pr-composer pr-thread-claude-composer" }, [area, el("div", { class: "pr-composer-actions" }, [clear, send])]);
    box.addEventListener("click", (e) => e.stopPropagation());
    body.append(box);
  }
  node.append(body);
  return node;
}

// One turn: who, which kind, when, against which commit, and the text.
function turnNode(t: ThreadTurn, head: string): HTMLElement {
  const secs = Math.floor(t.at / 1000);
  const who = t.role === "user" ? "you" : "Claude";
  const headLine = el("div", { class: "pr-card-head" }, [
    el("span", { class: "pr-card-author", text: who }),
    el("span", { class: "pr-card-verb", text: TURN_LABELS[t.kind] }),
    el("span", { class: "pr-card-time", text: relativeTime(secs), title: fullTime(secs) }),
  ]);
  if (t.role === "claude" && t.head && head && !(t.head.startsWith(head) || head.startsWith(t.head))) {
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
  return node;
}
