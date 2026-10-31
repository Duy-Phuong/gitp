// Draft review comments loaded from a review written outside gitp — the
// findings of a review tool or a reviewer's notes — so each can be read,
// edited, approved or discarded here, and the approved ones posted as one
// review. Pure: the parsing and the anchor check are unit-tested.
//
// Two shapes are read:
//
// - Markdown, one block per finding under a `###` heading that names the
//   location, `path/to/file.ext:42` (a range `42-50` anchors at its end),
//   with or without backticks. The comment is what lies between
//   `<!-- copy:start -->` and `<!-- copy:end -->`, else what follows a
//   "Comment to paste" label, else the block's text. A `**Severity:**` line
//   is kept as a tag.
// - JSON: an array of `{path, line, body, severity?, side?}`, or an object
//   holding one under `findings` or `comments`.

import type { FileDiff } from "./types";

export interface DraftComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  /// "blocking", "minor", "nit" or whatever the file said; null when it didn't.
  severity: string | null;
}

/// The findings in a review file, in file order. Blocks without a location or
/// without a comment are left out.
export function parseReviewFile(text: string): DraftComment[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return parseJson(trimmed);
  return parseMarkdown(text);
}

function parseJson(text: string): DraftComment[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? ((data as Record<string, unknown>).findings ?? (data as Record<string, unknown>).comments)
      : null;
  if (!Array.isArray(list)) return [];
  const drafts: DraftComment[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const path = typeof o.path === "string" ? o.path.trim() : "";
    const line = typeof o.line === "number" ? o.line : typeof o.line === "string" ? Number(o.line) : NaN;
    const body = typeof o.body === "string" ? o.body.trim() : typeof o.comment === "string" ? o.comment.trim() : "";
    if (!path || !Number.isInteger(line) || line < 1 || !body) continue;
    drafts.push({
      path,
      line,
      side: o.side === "LEFT" ? "LEFT" : "RIGHT",
      body,
      severity: typeof o.severity === "string" && o.severity.trim() ? o.severity.trim() : null,
    });
  }
  return drafts;
}

// `### path/to/file.ext:42`, `### \`src/a.rs:10-12\``, `### src/a.rs:7 — title`.
const HEADING = /^###\s+`?([^\s`:]+(?:\/[^\s`:]+)*):(\d+)(?:-(\d+))?`?/;
const COPY_START = "<!-- copy:start -->";
const COPY_END = "<!-- copy:end -->";

function parseMarkdown(text: string): DraftComment[] {
  const lines = text.split(/\r?\n/);
  const drafts: DraftComment[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = HEADING.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    // The block runs to the next heading of the same or a higher level.
    let j = i + 1;
    while (j < lines.length && !/^#{1,3}\s/.test(lines[j])) j++;
    const block = lines.slice(i + 1, j).join("\n");
    const body = commentOf(block);
    if (body) {
      drafts.push({
        path: m[1],
        line: Number(m[3] ?? m[2]),
        side: "RIGHT",
        body,
        severity: severityOf(block),
      });
    }
    i = j;
  }
  return drafts;
}

/// The comment inside the copy markers; else after a "Comment to paste"
/// label; else the whole block. Markers mismatched or empty give nothing.
function commentOf(block: string): string {
  const start = block.indexOf(COPY_START);
  if (start >= 0) {
    const end = block.indexOf(COPY_END, start);
    const inner = end >= 0 ? block.slice(start + COPY_START.length, end) : block.slice(start + COPY_START.length);
    return inner.trim();
  }
  const label = /\*\*Comment to paste:?\*\*:?\s*/i.exec(block);
  if (label) return block.slice(label.index + label[0].length).trim();
  return block.trim();
}

/// "blocking" from `**Severity:** 🔴 blocking`; the emoji and spaces are
/// dropped so the tag reads the same from any file.
function severityOf(block: string): string | null {
  const m = /\*\*Severity:?\*\*:?\s*(.+)/i.exec(block);
  if (!m) return null;
  const word = m[1].replace(/[^\p{L}\p{N} _-]/gu, "").trim();
  return word ? word.toLowerCase() : null;
}

export type AnchorCheck = "ok" | "no-file" | "no-line";

/// Whether GitHub would take a comment at the draft's location: the file must
/// be in the pull request and the line part of its diff (a line outside every
/// hunk is refused by the API). `files` is the pull request's diff.
export function checkAnchor(draft: DraftComment, files: FileDiff[]): AnchorCheck {
  const file = files.find((f) => f.path === draft.path || f.old_path === draft.path);
  if (!file) return "no-file";
  // A truncated diff may hold the line in a hunk that wasn't sent.
  if (file.truncated) return "ok";
  const inDiff = file.hunks.some((h) =>
    h.lines.some((l) => (draft.side === "LEFT" ? l.old_lineno : l.new_lineno) === draft.line),
  );
  return inDiff ? "ok" : "no-line";
}
