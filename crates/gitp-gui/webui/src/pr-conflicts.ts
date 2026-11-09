// The preview of a pull request's conflicts as Claude resolved them, shown
// before anything is committed or pushed: what Claude says it did, every
// file the merge changes (the conflicted ones marked), and the diff of the
// conflicted files on the branch.

import { el } from "./dom";
import type { ConflictResolution } from "./types";
import { renderGitHubMarkdown } from "./views/github-markdown";

// One line of a unified diff, by its look: a file header, a hunk header, an
// added or removed line, or context.
export function diffLineKind(line: string): "file" | "hunk" | "add" | "del" | "" {
  if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) return "file";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

const STATUS_WORDS: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type changed" };

export function conflictPreviewBody(r: ConflictResolution): Node[] {
  const conflicted = new Set(r.conflicted);
  const nodes: Node[] = [];
  if (r.summary.trim()) {
    nodes.push(el("div", { class: "conflict-preview-summary" }, [renderGitHubMarkdown(r.summary)]));
  }
  const ordered = [...r.changed].sort((a, b) => Number(conflicted.has(b.path)) - Number(conflicted.has(a.path)) || a.path.localeCompare(b.path));
  nodes.push(
    el("div", { class: "conflict-preview-label", text: `${r.changed.length} file${r.changed.length === 1 ? "" : "s"} change on ${r.branch} · ${r.conflicted.length} had conflicts` }),
    el(
      "ul",
      { class: "conflict-preview-files" },
      ordered.map((f) =>
        el("li", { class: conflicted.has(f.path) ? "conflicted" : "" }, [
          el("span", { class: `conflict-preview-status s-${f.status.toLowerCase()}`, text: f.status, title: STATUS_WORDS[f.status] ?? f.status }),
          el("span", { class: "conflict-preview-path", text: f.path }),
          ...(conflicted.has(f.path) ? [el("span", { class: "pr-thread-status resolved", text: "✓ resolved by Claude" })] : []),
        ]),
      ),
    ),
  );
  if (r.diff.trim()) {
    nodes.push(
      el("div", { class: "conflict-preview-label", text: "What the resolution changes in the conflicted files" }),
      el(
        "pre",
        { class: "conflict-preview-diff" },
        r.diff.split("\n").map((l) => el("div", { class: `d-${diffLineKind(l) || "ctx"}`, text: l || " " })),
      ),
    );
  }
  return nodes;
}
