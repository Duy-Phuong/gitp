// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { conversationNode, conversationSummary, threadBadges, threadClaudeButtons } from "./thread-claude";
import type { ThreadConversation } from "../types";

it("a resolved thread has no Claude buttons", () => {
  expect(threadClaudeButtons(true, null)).toEqual([]);
});

it("three buttons, the running one marked and the others disabled", () => {
  const idle = threadClaudeButtons(false, null);
  expect(idle.map((b) => [b.action, b.label, b.disabled])).toEqual([
    ["check", "Check", false],
    ["explain", "Explain simply", false],
    ["reply-draft", "Reply with Claude", false],
  ]);
  const busy = threadClaudeButtons(false, "explain");
  expect(busy.map((b) => [b.running, b.disabled, b.label])).toEqual([
    [false, true, "Check"],
    [true, true, "Explain simply…"],
    [false, true, "Reply with Claude"],
  ]);
  expect(threadClaudeButtons(false, "followup").every((b) => b.disabled)).toBe(true);
});

const conv = (): ThreadConversation => ({
  version: 1,
  pr: 7,
  thread: 1,
  path: "a",
  turns: [
    { kind: "check", role: "claude", at: Date.now() - 3 * 86400_000, head: "aaaa", text: "**x**" },
    { kind: "followup", role: "user", at: Date.now() - 120_000, text: "y" },
    { kind: "followup", role: "claude", at: Date.now() - 90_000, head: "aaaa", text: "z" },
  ],
});

it("summarises a conversation by its last Claude turn", () => {
  expect(conversationSummary(conv())).toBe("Claude · 3 turns · Follow-up 1m ago");
  const one = { ...conv(), turns: conv().turns.slice(0, 1) };
  expect(conversationSummary(one)).toBe("Claude · 1 turn · Check 3d ago");
});

it("the block marks turns made against an older commit, offers Try again on an error, and renders Markdown", () => {
  const node = conversationNode({
    state: { running: null, error: "boom", loaded: true, conversation: conv() },
    head: "bbbb",
    open: true,
    lastKind: "check",
    onFollowup() {},
    onClear() {},
    onRetry() {},
    onCancel() {},
    onToggle() {},
  });
  expect(node.querySelector(".pr-badge")?.textContent).toBe("older commit");
  expect([...node.querySelectorAll("button")].map((b) => b.textContent)).toContain("Check again");
  expect(node.querySelector(".pr-thread-claude-error")?.textContent).toContain("boom");
  expect([...node.querySelectorAll("button")].map((b) => b.textContent)).toContain("Try again");
  expect(node.querySelector(".github-markdown strong")?.textContent).toBe("x");
  expect([...node.querySelectorAll(".pr-thread-claude-turn")].map((t) => t.classList.contains("user"))).toEqual([false, true, false]);
});

it("a collapsed block shows only its summary line, and Clear is off while a turn runs", () => {
  const closed = conversationNode({
    state: { running: null, error: null, loaded: true, conversation: conv() },
    head: "aaaa",
    open: false,
    lastKind: null,
    onFollowup() {},
    onClear() {},
    onRetry() {},
    onCancel() {},
    onToggle() {},
  });
  expect(closed.querySelector(".pr-thread-claude-turn")).toBeNull();
  const current = conversationNode({ state: { running: null, error: null, loaded: true, conversation: conv() }, head: "aaaa", open: true, lastKind: null, onFollowup() {}, onClear() {}, onRetry() {}, onCancel() {}, onToggle() {} });
  expect([...current.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Check again");
  expect(closed.querySelector(".pr-thread-claude-head")?.textContent).toContain("3 turns");
  const running = conversationNode({
    state: { running: "check", error: null, loaded: true, conversation: conv() },
    head: "aaaa",
    open: true,
    lastKind: null,
    onFollowup() {},
    onClear() {},
    onRetry() {},
    onCancel() {},
    onToggle() {},
  });
  const clear = [...running.querySelectorAll("button")].find((b) => b.textContent === "Clear") as HTMLButtonElement;
  expect(clear.disabled).toBe(true);
  expect(running.textContent).toContain("Claude is thinking");
  expect([...running.querySelectorAll("button")].map((b) => b.textContent)).toContain("Cancel");
});

it("the follow-up box keeps what was typed across a redraw and reports edits", () => {
  let typed = "";
  const node = conversationNode({
    state: { running: null, error: null, loaded: true, conversation: conv() },
    head: "aaaa",
    open: true,
    lastKind: null,
    draft: "half a question",
    onDraft: (t) => (typed = t),
    onFollowup() {},
    onClear() {},
    onRetry() {},
    onCancel() {},
    onToggle() {},
  });
  const area = node.querySelector("textarea") as HTMLTextAreaElement;
  expect(area.value).toBe("half a question");
  area.value = "half a question more";
  area.dispatchEvent(new Event("input"));
  expect(typed).toBe("half a question more");
});

const opts = (over: Partial<Parameters<typeof conversationNode>[0]>) => ({
  state: { running: null, error: null, loaded: true, conversation: conv() },
  head: "aaaa",
  open: true,
  lastKind: null,
  fix: { disabled: null },
  onFix() {},
  onDrop() {},
  onFollowup() {},
  onClear() {},
  onRetry() {},
  onCancel() {},
  onToggle() {},
  ...over,
});

it("the Fix button carries its disabled reason, and a Fix turn shows its commit", () => {
  const off = conversationNode(opts({ fix: { disabled: "A fix is running on src/a.ts:1" } }));
  const fix = [...off.querySelectorAll("button")].find((b) => b.textContent === "Fix") as HTMLButtonElement;
  expect(fix.disabled).toBe(true);
  expect(fix.title).toBe("A fix is running on src/a.ts:1");
  const c = conv();
  c.turns.push({ kind: "fix", role: "claude", at: Date.now(), head: "bbbb", text: "**Changed** x", commit: "a1b2c3d4e5f6", worktree: "/Users/you/mideal-feature" });
  const on = conversationNode(opts({ state: { running: null, error: null, loaded: true, conversation: c }, head: "bbbb" }));
  expect(on.textContent).toContain("Commit a1b2c3d in mideal-feature");
  expect(([...on.querySelectorAll("button")].find((b) => b.textContent === "Fix") as HTMLButtonElement).disabled).toBe(false);
  const fixing = conversationNode(opts({ state: { running: "fix", error: null, loaded: true, conversation: c } }));
  expect(fixing.textContent).toContain("Claude is fixing");
});

it("badges say what the thread has ready", () => {
  const c = conv();
  expect(threadBadges(c)).toEqual([]);
  c.turns.push({ kind: "reply-draft", role: "claude", at: 1, text: "r" });
  expect(threadBadges(c)).toEqual(["reply ready"]);
  c.turns.splice(c.turns.length - 1, 0, { kind: "fix", role: "claude", at: 1, text: "f", commit: "abc" });
  expect(threadBadges(c)).toEqual(["fixed", "reply ready"]);
  c.turns[c.turns.length - 1].posted = "u";
  expect(threadBadges(c)).toEqual(["fixed", "posted"]);
  c.turns[c.turns.length - 1].posted = undefined;
  c.turns[c.turns.length - 1].dropped = true;
  expect(threadBadges(c)).toEqual(["fixed"]);
  expect(threadBadges(null)).toEqual([]);
});
