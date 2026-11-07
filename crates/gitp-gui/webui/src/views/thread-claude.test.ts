// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { conversationNode, conversationSummary, optionsIn, threadBadges, threadClaudeButtons } from "./thread-claude";
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

it("a read-only block (a resolved thread) offers only Clear, and no Check again", () => {
  let cleared = 0;
  const node = conversationNode({
    state: { running: null, error: null, loaded: true, conversation: conv() },
    head: "bbbb",
    open: true,
    lastKind: null,
    readOnly: true,
    fix: { disabled: null },
    onFollowup() {},
    onClear: () => cleared++,
    onRetry() {},
    onCancel() {},
    onToggle() {},
  });
  expect([...node.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Clear"]);
  expect(node.querySelector("textarea")).toBeNull();
  expect(node.querySelectorAll(".pr-thread-claude-turn").length).toBe(3);
  node.querySelector("button")!.click();
  expect(cleared).toBe(1);
});

const CHECK = [
  "**Bottom line:** the loop stops one early.",
  "",
  "| Option | What changes | Risk |",
  "|---|---|---|",
  "| **A. Reviewer's suggestion** | use `<=` | low |",
  "| B. An alternative | iterate the list | medium |",
  "| C. No change | nothing | the bug stays |",
].join("\n");

it("reads the options from the table of Claude's answer", () => {
  expect(optionsIn(CHECK)).toEqual(["A. Reviewer's suggestion", "B. An alternative", "C. No change"]);
  expect(optionsIn("| File | Line |\n|---|---|\n| a.ts | 3 |")).toEqual([]);
  expect(optionsIn("no table here")).toEqual([]);
});

describe("ticking an option", () => {
  const withCheck = (): ThreadConversation => ({ ...conv(), turns: [{ kind: "check", role: "claude", at: Date.now(), head: "aaaa", text: CHECK }] });
  let chosen: string[] = [];
  const node = (draft = "", fixDisabled: string | null = "Send the option you want as a follow-up first") => {
    const drafts: string[] = [];
    chosen = [];
    const n = conversationNode({
      state: { running: null, error: null, loaded: true, conversation: withCheck() },
      head: "aaaa",
      open: true,
      lastKind: null,
      draft,
      onDraft: (t) => drafts.push(t),
      fix: { disabled: fixDisabled },
      onChooseFix: (t) => chosen.push(t),
      onFollowup() {},
      onClear() {},
      onRetry() {},
      onCancel() {},
      onToggle() {},
    });
    return { n, drafts, boxes: [...n.querySelectorAll<HTMLInputElement>(".pr-thread-option input")], area: n.querySelector("textarea")! };
  };
  const tick = (box: HTMLInputElement) => {
    box.checked = !box.checked;
    box.dispatchEvent(new Event("change"));
  };

  it("fills the follow-up box with it, and unticking takes it out", () => {
    const { boxes, area, drafts } = node();
    expect(boxes).toHaveLength(3);
    tick(boxes[1]);
    expect(area.value).toBe("I choose: B. An alternative");
    expect(drafts[drafts.length - 1]).toBe("I choose: B. An alternative");
    tick(boxes[0]);
    expect(area.value).toBe("I choose: B. An alternative\nI choose: A. Reviewer's suggestion");
    tick(boxes[1]);
    expect(area.value).toBe("I choose: A. Reviewer's suggestion");
  });

  it("keeps what was typed, and shows the options in the box ticked after a redraw", () => {
    const { boxes, area } = node("Please also add a test.");
    tick(boxes[2]);
    expect(area.value).toBe("Please also add a test.\nI choose: C. No change");
    const again = node(area.value);
    expect(again.boxes.map((b) => b.checked)).toEqual([false, false, true]);
  });

  it("Fix with this saves the ticked option and starts the fix, in one click", () => {
    const { n, boxes, area } = node();
    const fixWith = [...n.querySelectorAll("button")].find((b) => b.textContent === "Fix with this")!;
    expect(fixWith.disabled).toBe(true);
    tick(boxes[1]);
    expect(fixWith.disabled).toBe(false);
    fixWith.click();
    expect(chosen).toEqual(["I choose: B. An alternative"]);
    expect(area.value).toBe("");
  });

  it("Fix with this is off while a fix runs elsewhere on the pull request", () => {
    const { n, boxes } = node("", "A fix is running on a.ts:3");
    tick(boxes[0]);
    const fixWith = [...n.querySelectorAll("button")].find((b) => b.textContent === "Fix with this")!;
    expect(fixWith.disabled).toBe(true);
    expect(fixWith.title).toBe("A fix is running on a.ts:3");
  });
});
