import { expect, it } from "vitest";
import { cancelQueuedFix, finishTurn, fixDisabledReason, fixRunningOn, hasChosenOption, lastFix, lastUserText, onThreadsChange, ordinal, preparedReplies, preparedReply, queuedFixes, queueFix, queuePosition, runningTurns, setConversation, startTurn, takeQueuedFix, threadState } from "./pr-threads";
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

it("a reload after a failed turn keeps the error, so Try again stays", () => {
  finishTurn("/r", 10, 1, { error: "boom" });
  setConversation("/r", 10, 1, conv(1), { keepError: true });
  expect(threadState("/r", 10, 1)).toEqual({ running: null, error: "boom", conversation: conv(1), loaded: true });
  setConversation("/r", 10, 1, null, { keepError: true });
  expect(threadState("/r", 10, 1).error).toBe("boom");
});

const t = (kind: "check" | "followup" | "reply-draft" | "fix", role: "user" | "claude", extra: Partial<ThreadConversation["turns"][number]> = {}) => ({ kind, role, at: 1, text: kind, ...extra });

it("a chosen option is a user turn after the last Check", () => {
  expect(hasChosenOption(null)).toBe(false);
  expect(hasChosenOption({ ...conv(0), turns: [t("check", "claude")] })).toBe(false);
  expect(hasChosenOption({ ...conv(0), turns: [t("check", "claude"), t("followup", "user"), t("followup", "claude")] })).toBe(true);
  expect(hasChosenOption({ ...conv(0), turns: [t("followup", "user"), t("check", "claude")] })).toBe(false);
  // A fix uses the option up; the next Fix needs a new one.
  expect(hasChosenOption({ ...conv(0), turns: [t("check", "claude"), t("followup", "user"), t("fix", "claude", { commit: "abc" })] })).toBe(false);
  expect(hasChosenOption({ ...conv(0), turns: [t("check", "claude"), t("followup", "user"), t("fix", "claude", { commit: "abc" }), t("followup", "user")] })).toBe(true);
});

it("the prepared reply is the latest draft unless posted or dropped, and the last fix has a commit", () => {
  const c = { ...conv(0), turns: [t("reply-draft", "claude", { text: "A" }), t("fix", "claude", { commit: "abc" }), t("reply-draft", "claude", { text: "B" })] };
  expect(preparedReply(c)?.text).toBe("B");
  expect(lastFix(c)?.commit).toBe("abc");
  expect(preparedReply({ ...c, turns: [...c.turns.slice(0, 2), t("reply-draft", "claude", { text: "B", posted: "u" })] })).toBeNull();
  expect(preparedReply({ ...c, turns: [...c.turns.slice(0, 2), t("reply-draft", "claude", { text: "B", dropped: true })] })).toBeNull();
  expect(lastFix({ ...c, turns: [t("fix", "claude")] })).toBeNull();
  expect(preparedReply(null)).toBeNull();
});

it("counts the loaded threads with a reply ready", () => {
  expect(preparedReplies("/p", 5)).toBe(0);
  setConversation("/p", 5, 1, { ...conv(0), turns: [t("reply-draft", "claude")] });
  setConversation("/p", 5, 2, { ...conv(0), turns: [t("reply-draft", "claude", { posted: "u" })] });
  setConversation("/p", 5, 3, { ...conv(0), turns: [t("reply-draft", "claude")] });
  expect(preparedReplies("/p", 5)).toBe(2);
  expect(preparedReplies("/p", 6)).toBe(0);
});

it("one fix per pull request: the running one disables the others with its place", () => {
  startTurn("/f", 3, 10, "fix");
  expect(fixRunningOn("/f", 3)).toBe(10);
  expect(fixRunningOn("/f", 4)).toBeNull();
  const chosen = { ...conv(0), turns: [t("check", "claude"), t("followup", "user")] };
  expect(fixDisabledReason(chosen, null)).toBeNull();
  expect(fixDisabledReason(null, null)).toBe("Send the option you want as a follow-up first");
  expect(fixDisabledReason(chosen, "src/a.ts:1")).toBe("A fix is running on src/a.ts:1");
  finishTurn("/f", 3, 10, { error: "x" });
  expect(fixRunningOn("/f", 3)).toBeNull();
});

it("queues fixes per pull request, in the order asked, once each", () => {
  const changes: number[] = [];
  onThreadsChange(() => changes.push(1));
  const q = (repo: string, number: number, thread: number) => ({ repo, number, thread, where: `f.ts:${thread}`, pr: null, input: null });
  queueFix(q("/q", 9, 2));
  queueFix(q("/q", 9, 3));
  queueFix(q("/q", 9, 2));
  queueFix(q("/other", 9, 7));
  expect(queuedFixes("/q", 9).map((x) => x.thread)).toEqual([2, 3]);
  expect(queuedFixes().length).toBe(3);
  expect([queuePosition("/q", 9, 3), queuePosition("/q", 9, 4)]).toEqual([2, null]);
  expect(takeQueuedFix("/q", 9)?.thread).toBe(2);
  expect(queuePosition("/q", 9, 3)).toBe(1);
  expect(cancelQueuedFix("/q", 9, 3)).toBe(true);
  expect(cancelQueuedFix("/q", 9, 3)).toBe(false);
  expect(takeQueuedFix("/q", 9)).toBeNull();
  expect(takeQueuedFix("/other", 9)?.thread).toBe(7);
  expect(changes.length).toBeGreaterThan(0);
  expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 102].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "102nd"]);
});
