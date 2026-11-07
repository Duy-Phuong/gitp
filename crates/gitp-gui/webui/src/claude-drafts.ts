// Drafts with Claude: a commit message for the commit box and a pull
// request's title and description for the Create Pull Request dialog. The
// commands (Settings → Git), the calls that run and cancel them, and the rule
// for when a draft may replace text without asking. Kept out of api.ts and
// prefs.ts so the feature owns its own surface.

import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "./api";
import { SESSION_ID_ARG } from "./prefs";
import type { PrDraft } from "./types";

export interface CommitDraft {
  subject: string;
  body: string;
}

// Which draft runs, as the backend names it (for Cancel).
export type DraftRunKind = "commit_message" | "pull_request";

// Which command, as Settings keeps it.
export type DraftCommandKind = "commit-message" | "pr-draft";

// What "thinking…" says while a draft runs.
export const DRAFT_THINKING = "Claude is thinking…";

// Read-only: a draft only reads the diff and, when that isn't clear, the code.
export const DRAFT_TOOLS = ["Read", "Grep", "Glob", "Bash(git log *)", "Bash(git diff *)", "Bash(git show *)"];

// The prompt comes first: --allowedTools takes every word after it as a tool.
// A fresh session each time, never a resume.
const draftCommand = (prompt: string) =>
  `claude -p "${prompt}" --model opus --effort medium --permission-mode dontAsk ` +
  `--allowedTools "${DRAFT_TOOLS.join(" ")}" --output-format json ${SESSION_ID_ARG}`;

const DRAFT_RULES = "Read the code when the diff alone is not clear. Change nothing, ask no questions.";

export const DEFAULT_DRAFT_COMMANDS: Record<DraftCommandKind, string> = {
  "commit-message": draftCommand(
    "Write the commit message for the staged changes; their diff is on stdin. Follow the style of this " +
      "repository's recent subjects, listed newest first in $GITP_LOG_FILE (branch $GITP_BRANCH): a subject " +
      "line under 72 characters, a blank line, then a short body that says what changed and why, wrapped at " +
      "72 characters. " +
      DRAFT_RULES +
      " Print only the message: no heading, no code fence, no explanation.",
  ),
  // The template's variable is named without $: unset, it would leave a hole.
  "pr-draft": draftCommand(
    "Draft the pull request from $GITP_BRANCH into $GITP_BASE. Its commits and then its diff are on stdin. " +
      "If the environment variable GITP_PR_TEMPLATE_FILE names a file, it is the repository's pull request " +
      "template: follow its sections. Write a short title in the style of the commits, and a description in " +
      "GitHub Markdown that says what changed and why, ending with a Checks section: a task list (- [ ] item) " +
      "of what a reviewer should verify. " +
      DRAFT_RULES +
      " Print only a JSON object with two string keys, title and body, and nothing else.",
  ),
};

const commandKey = (kind: DraftCommandKind) => `gitp-draft-command-${kind}`;

export function loadDraftCommand(kind: DraftCommandKind): string {
  try {
    return localStorage.getItem(commandKey(kind)) ?? DEFAULT_DRAFT_COMMANDS[kind];
  } catch {
    return DEFAULT_DRAFT_COMMANDS[kind];
  }
}

// Blank, or the default itself, forgets the custom command.
export function saveDraftCommand(kind: DraftCommandKind, command: string): void {
  try {
    if (!command.trim() || command.trim() === DEFAULT_DRAFT_COMMANDS[kind]) localStorage.removeItem(commandKey(kind));
    else localStorage.setItem(commandKey(kind), command.trim());
  } catch {
    // Full or blocked storage: the command just doesn't survive a restart.
  }
}

// Whether a draft must ask before replacing `current`: not when it is empty
// or still exactly one of the texts gitp (or Claude) put there.
export function needsConfirm(current: string, prefilled: (string | null | undefined)[]): boolean {
  const text = current.trim();
  return text !== "" && !prefilled.some((p) => p != null && p.trim() === text);
}

// --- Calls ---------------------------------------------------------------------

// The preview's runs, which Cancel rejects.
const mockRuns = new Map<string, (reason: string) => void>();

function mockRun<T>(path: string, kind: DraftRunKind, value: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const key = `${path}\n${kind}`;
    const timer = setTimeout(() => {
      mockRuns.delete(key);
      resolve(value);
    }, 1500);
    mockRuns.set(key, (reason) => {
      clearTimeout(timer);
      mockRuns.delete(key);
      reject(reason);
    });
  });
}

export async function draftCommitMessage(path: string, command: string, amend: boolean): Promise<CommitDraft> {
  if (!isTauri()) {
    return mockRun(path, "commit_message", {
      subject: "feat(webui): draft the commit message with Claude",
      body: "The commit box gets a Draft with Claude button that fills the\nsubject and the description from the staged diff.",
    });
  }
  return invoke<CommitDraft>("draft_commit_message", { path, command, amend });
}

export async function draftPullRequest(path: string, branch: string, base: string, command: string): Promise<PrDraft> {
  if (!isTauri()) {
    return mockRun(path, "pull_request", {
      title: `Drafts with Claude (${branch} into ${base})`,
      body: "## What\n\nA Draft with Claude button in the commit box and here.\n\n## Checks\n\n- [ ] The draft fills an empty box\n- [ ] Typed text is kept unless you agree",
    });
  }
  return invoke<PrDraft>("draft_pull_request", { path, branch, base, command });
}

export async function cancelDraft(path: string, kind: DraftRunKind): Promise<void> {
  if (!isTauri()) {
    mockRuns.get(`${path}\n${kind}`)?.("operation cancelled");
    return;
  }
  return invoke<void>("draft_cancel", { path, kind });
}
