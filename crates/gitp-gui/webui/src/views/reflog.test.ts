import { describe, it, expect } from "vitest";
import { splitReflogMessage } from "./reflog";

describe("splitReflogMessage", () => {
  it("splits git's action from what it acted on", () => {
    expect(splitReflogMessage("commit: add widget")).toEqual({ action: "commit", detail: "add widget" });
    expect(splitReflogMessage("checkout: moving from main to topic")).toEqual({
      action: "checkout",
      detail: "moving from main to topic",
    });
  });

  it("keeps a parenthesised qualifier with the action", () => {
    expect(splitReflogMessage("commit (amend): fix typo")).toEqual({ action: "commit (amend)", detail: "fix typo" });
    expect(splitReflogMessage("rebase (finish): returning to refs/heads/main")).toEqual({
      action: "rebase (finish)",
      detail: "returning to refs/heads/main",
    });
  });

  it("splits only at the first colon, so a conventional-commit subject stays whole", () => {
    expect(splitReflogMessage("commit: feat(gui): reflog view")).toEqual({
      action: "commit",
      detail: "feat(gui): reflog view",
    });
  });

  it("treats a message without an action as all detail", () => {
    expect(splitReflogMessage("fixture")).toEqual({ action: "", detail: "fixture" });
    expect(splitReflogMessage("")).toEqual({ action: "", detail: "" });
  });
});
