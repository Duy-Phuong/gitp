// The pure parts of the conflict resolver's help: the question "Suggest with
// Claude" sends, reading its answer back, and whether git rerere is on.

import type { ConfigEntry, ConflictCommit } from "./types";

// One conflict as Claude is asked about it: the three sides, and a few
// unchanged lines around it for context.
export interface ConflictQuestion {
  id: number;
  before: string[];
  base: string[];
  ours: string[];
  theirs: string[];
  after: string[];
}

export interface PromptContext {
  path: string;
  kind: string;
  oursLabel: string;
  theirsLabel: string;
  oursCommits: ConflictCommit[];
  theirsCommits: ConflictCommit[];
}

export interface Suggestion {
  lines: string[];
  why: string;
}

const fence = (lines: string[]) => ["```", ...lines, "```"].join("\n");

const commitList = (commits: ConflictCommit[]) =>
  commits.length ? commits.map((c) => `- ${c.short} ${c.subject} (${c.author}, ${c.when})`).join("\n") : "- (none found)";

// The stdin of a suggestion run: what the file and the sides are, why each
// side changed it, the conflicts, and the exact JSON to answer with.
export function conflictPrompt(ctx: PromptContext, conflicts: ConflictQuestion[]): string {
  const parts = [
    `File: ${ctx.path}`,
    `Operation: ${ctx.kind}`,
    `Ours: ${ctx.oursLabel}`,
    `Theirs: ${ctx.theirsLabel}`,
  ];
  if (ctx.kind === "rebase") {
    parts.push("In a rebase git swaps the sides: ours is the branch being rebased onto, theirs is the commit being applied.");
  }
  parts.push(
    "",
    "Commits on ours that changed this file:",
    commitList(ctx.oursCommits),
    "",
    "Commits on theirs that changed this file:",
    commitList(ctx.theirsCommits),
    "",
    "For each conflict below, write the lines that should replace it in the merged file. " +
      "Keep what both sides meant when the changes can be combined; otherwise keep the side whose intent is right. " +
      "The lines before and after a conflict are context only: do not repeat them.",
    "",
    "Answer with only this JSON object and no other text:",
    '{"resolutions":[{"id":1,"lines":["first line","second line"],"why":"one short sentence"}]}',
    "Leave out a conflict you cannot resolve with confidence.",
  );
  for (const c of conflicts) {
    parts.push(
      "",
      `### Conflict ${c.id}`,
      "Before (context):",
      fence(c.before),
      "Base (before both sides changed it):",
      fence(c.base),
      "Ours:",
      fence(c.ours),
      "Theirs:",
      fence(c.theirs),
      "After (context):",
      fence(c.after),
    );
  }
  return `${parts.join("\n")}\n`;
}

// Claude's answer as suggestions by conflict id. The JSON may sit in a code
// fence or after a sentence, so the outermost {…} is read; anything that
// isn't a well-formed resolution is skipped. Throws when there is no JSON.
export function parseSuggestions(answer: string): Map<number, Suggestion> {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Claude's answer had no suggestions in it.");
  const json = JSON.parse(answer.slice(start, end + 1)) as { resolutions?: unknown };
  const out = new Map<number, Suggestion>();
  if (!Array.isArray(json.resolutions)) return out;
  for (const r of json.resolutions as Record<string, unknown>[]) {
    if (typeof r?.id !== "number" || !Array.isArray(r.lines)) continue;
    if (!r.lines.every((l) => typeof l === "string")) continue;
    out.set(r.id, { lines: r.lines, why: typeof r.why === "string" ? r.why : "" });
  }
  return out;
}

// Whether git rerere is on for this repository: the value of the most
// specific scope that sets rerere.enabled (local over global over system).
export function rerereEnabled(entries: ConfigEntry[]): boolean {
  const order = ["Local", "Global", "System", "Other"];
  const set = entries
    .filter((e) => e.name.toLowerCase() === "rerere.enabled")
    .sort((a, b) => order.indexOf(a.scope) - order.indexOf(b.scope));
  return ["true", "yes", "on", "1"].includes((set[0]?.value ?? "").toLowerCase());
}
