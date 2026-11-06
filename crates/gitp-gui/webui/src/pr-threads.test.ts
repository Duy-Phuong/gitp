import { expect, it } from "vitest";
import { finishTurn, lastUserText, onThreadsChange, runningTurns, setConversation, startTurn, threadState } from "./pr-threads";
import type { ThreadConversation } from "./types";

const conv = (turns = 1): ThreadConversation => ({
  version: 1,
  pr: 7,
  thread: 500,
  path: "a",
  turns: Array.from({ length: turns }, () => ({ kind: "check" as const, role: "claude" as const, at: 1, text: "x" })),
});

it("starts one turn per thread and keeps the result", () => {
  let changes = 0;
  onThreadsChange(() => changes++);
  const s = threadState("/r", 7, 500);
  expect(s).toEqual({ running: null, error: null, conversation: null, loaded: false });
  expect(startTurn("/r", 7, 500, "check")).toBe(true);
  expect(startTurn("/r", 7, 500, "explain")).toBe(false);
  expect(threadState("/r", 7, 500).running).toBe("check");
  expect(startTurn("/r", 7, 501, "check")).toBe(true);
  expect(runningTurns("/r", 7)).toBe(2);
  expect(runningTurns("/r", 8)).toBe(0);
  finishTurn("/r", 7, 500, conv());
  expect(threadState("/r", 7, 500)).toEqual({ running: null, error: null, conversation: conv(), loaded: true });
  finishTurn("/r", 7, 501, { error: "boom" });
  expect(threadState("/r", 7, 501).error).toBe("boom");
  expect(threadState("/r", 7, 501).running).toBeNull();
  expect(runningTurns("/r", 7)).toBe(0);
  // Two starts that took, one refused, two finishes.
  expect(changes).toBe(4);
});

it("a loaded conversation replaces an error and nothing", () => {
  finishTurn("/r", 9, 1, { error: "old" });
  setConversation("/r", 9, 1, conv(2));
  expect(threadState("/r", 9, 1)).toEqual({ running: null, error: null, conversation: conv(2), loaded: true });
  setConversation("/r", 9, 1, null);
  expect(threadState("/r", 9, 1).conversation).toBeNull();
  expect(threadState("/r", 9, 1).loaded).toBe(true);
});

it("the last user turn is what a reply draft builds on", () => {
  expect(lastUserText(null)).toBe("");
  const c = conv(1);
  c.turns.push({ kind: "followup", role: "user", at: 2, text: "restore >" }, { kind: "followup", role: "claude", at: 3, text: "ok" });
  expect(lastUserText(c)).toBe("restore >");
  expect(lastUserText(conv(1))).toBe("");
});
