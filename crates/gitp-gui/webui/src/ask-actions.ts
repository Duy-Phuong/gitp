// "Explain with Claude" from the menus: a commit, a branch, a tag's release.

import { claudeAsk } from "./api";
import { copyText } from "./clipboard";
import { ASK_COMMANDS, withClaudeChoice } from "./prefs";
import { opFailed, reportDone } from "./report";
import { openAskDialog } from "./views/ask-dialog";

const callbacks = {
  copy: (text: string) => void copyText(text, "Copied."),
  reportDone,
  reportError: opFailed,
};

export function explainCommitAction(sha: string, short: string): void {
  openAskDialog(`Explain ${short}`, () => claudeAsk("commit", sha, withClaudeChoice(ASK_COMMANDS.commit)), callbacks);
}

export function summarizeBranchAction(name: string): void {
  openAskDialog(`Summary of ${name}`, () => claudeAsk("branch", name, withClaudeChoice(ASK_COMMANDS.branch)), callbacks);
}

export function releaseNotesAction(tag: string): void {
  openAskDialog(`Release notes for ${tag}`, () => claudeAsk("release", tag, withClaudeChoice(ASK_COMMANDS.release)), callbacks);
}
