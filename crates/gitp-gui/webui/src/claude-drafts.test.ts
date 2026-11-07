// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import {
  cancelDraft,
  DEFAULT_DRAFT_COMMANDS,
  DRAFT_TOOLS,
  draftCommitMessage,
  draftPullRequest,
  loadDraftCommand,
  needsConfirm,
  saveDraftCommand,
} from "./claude-drafts";
import { withClaudeChoice } from "./prefs";

describe("DEFAULT_DRAFT_COMMANDS", () => {
  it("run claude read-only, as JSON, with the prompt first and no resume", () => {
    for (const command of Object.values(DEFAULT_DRAFT_COMMANDS)) {
      expect(command.startsWith('claude -p "')).toBe(true);
      expect(command).toContain(`--allowedTools "${DRAFT_TOOLS.join(" ")}"`);
      expect(command.indexOf("--allowedTools")).toBeGreaterThan(command.indexOf('"', 11));
      expect(command).toContain("--output-format json");
      expect(command).toContain("--permission-mode dontAsk");
      expect(command).not.toContain("--resume");
      expect(withClaudeChoice(command, { model: "sonnet", effort: "high" })).toContain("--model sonnet --effort high");
    }
    expect(DRAFT_TOOLS).toEqual(["Read", "Grep", "Glob", "Bash(git log *)", "Bash(git diff *)", "Bash(git show *)"]);
  });

  it("asks the commit message for the repo's style from the log file", () => {
    expect(DEFAULT_DRAFT_COMMANDS["commit-message"]).toContain("$GITP_LOG_FILE");
  });

  it("asks the pull request for a Checks list and the template, named without $", () => {
    const pr = DEFAULT_DRAFT_COMMANDS["pr-draft"];
    expect(pr).toContain("Checks");
    expect(pr).toContain("GITP_PR_TEMPLATE_FILE");
    expect(pr).not.toContain("$GITP_PR_TEMPLATE_FILE");
    expect(pr).toContain("title and body");
  });
});

describe("loadDraftCommand / saveDraftCommand", () => {
  beforeEach(() => localStorage.clear());

  it("keeps a custom command and forgets it on blank or the default", () => {
    expect(loadDraftCommand("pr-draft")).toBe(DEFAULT_DRAFT_COMMANDS["pr-draft"]);
    saveDraftCommand("pr-draft", "  my-draft  ");
    expect(loadDraftCommand("pr-draft")).toBe("my-draft");
    expect(loadDraftCommand("commit-message")).toBe(DEFAULT_DRAFT_COMMANDS["commit-message"]);
    saveDraftCommand("pr-draft", " ");
    expect(localStorage.getItem("gitp-draft-command-pr-draft")).toBeNull();
    saveDraftCommand("commit-message", "x");
    saveDraftCommand("commit-message", DEFAULT_DRAFT_COMMANDS["commit-message"]);
    expect(localStorage.getItem("gitp-draft-command-commit-message")).toBeNull();
  });
});

describe("needsConfirm", () => {
  it("never asks over empty text or a pre-fill", () => {
    expect(needsConfirm("", [])).toBe(false);
    expect(needsConfirm("  \n ", ["x"])).toBe(false);
    expect(needsConfirm("## Why\n", [null, undefined, "## Why"])).toBe(false);
  });

  it("asks over anything else", () => {
    expect(needsConfirm("typed", [])).toBe(true);
    expect(needsConfirm("## Why\nmine", ["## Why"])).toBe(true);
  });
});

describe("the preview mocks", () => {
  it("draft, and reject as cancelled when cancelled", async () => {
    const pr = draftPullRequest("/r", "feature", "main", "cmd");
    const commit = draftCommitMessage("/r", "cmd", false);
    await cancelDraft("/r", "commit_message");
    await expect(commit).rejects.toBe("operation cancelled");
    const draft = await pr;
    expect(draft.title).not.toBe("");
    expect(draft.body).toContain("Checks");
  }, 10_000);
});
