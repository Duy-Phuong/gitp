// The one line a comment folds to under "Collapse comments" in a pull
// request's Files tab: who said it and how it starts.

// A comment's first line of text, without Markdown's leading marks, cut to
// what one row can show.
export function firstLine(body: string, max = 140): string {
  const line = body
    .split("\n")
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "").trim())
    .find((l) => l && !l.startsWith("```") && !l.startsWith("<!--"));
  const text = (line ?? "").replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function threadFoldText(author: string, body: string, replies: number, resolved: boolean): string {
  const parts = [`${author}: ${firstLine(body) || "(no text)"}`];
  if (replies) parts.push(`${replies + 1} comments`);
  if (resolved) parts.push("resolved");
  return parts.join(" · ");
}

export function draftFoldText(severity: string | null, body: string): string {
  return `Draft${severity ? ` (${severity})` : ""}: ${firstLine(body) || "(no text)"}`;
}
