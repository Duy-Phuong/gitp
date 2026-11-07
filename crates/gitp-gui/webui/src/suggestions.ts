// A reviewer's ```suggestion blocks: the lines a line comment proposes in
// place of the ones it is on, which gitp-core applies in the pull request's
// worktree and commits (Repo::apply_suggestions).

import type { PrReviewComment, PullRequestDetail } from "./types";

// One suggestion to apply (gitp-core's Suggestion): lines
// `start_line..=line` of `path` at the pull request's head become `text`.
export interface Suggestion {
  comment_id: number;
  author: string;
  path: string;
  start_line: number;
  line: number;
  text: string;
}

// The text of a comment's first ```suggestion block, or null without one.
export function suggestionIn(body: string): string | null {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === "```suggestion");
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.trimEnd() === "```");
  return end < 0 ? null : lines.slice(start + 1, end).join("\n");
}

// The comment's suggestion, when it can be applied: on the new file's lines
// as they are now (not outdated), in a thread not resolved.
export function suggestionOf(c: PrReviewComment, resolved: boolean): Suggestion | null {
  if (resolved || c.side !== "RIGHT" || c.line === null) return null;
  const text = suggestionIn(c.body);
  if (text === null) return null;
  return { comment_id: c.id, author: c.author, path: c.path, start_line: c.start_line ?? c.line, line: c.line, text };
}

// Every suggestion of the pull request that can be applied.
export function prSuggestions(pr: PullRequestDetail): Suggestion[] {
  const resolved = (id: number) => pr.review_threads.some((t) => t.resolved && t.comment_ids.includes(id));
  return pr.review_comments.flatMap((c) => suggestionOf(c, resolved(c.id)) ?? []);
}
