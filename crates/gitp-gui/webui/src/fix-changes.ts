// What a Claude fix committed, shown under its turn in the thread: the
// commit, the files it changed and their diff, folded until asked for, so
// the change can be reviewed where it was discussed.

import { el } from "./dom";
import type { ChangeKind, CommitDetail } from "./types";

// The commits shown open (by id): kept across redraws, and opened by the
// fix's toast before it shows the thread.
const expanded = new Set<string>();
const details = new Map<string, Promise<CommitDetail>>();

export function expandFixChanges(commit: string): void {
  expanded.add(commit);
}

const STATUS_LETTER: Partial<Record<ChangeKind, string>> = { Added: "A", Deleted: "D", Modified: "M", Renamed: "R", Copied: "C", Untracked: "A" };

// The commit's diff as lines, each with its look: the file header, a hunk
// header, an added, removed or unchanged line.
export function commitDiffLines(d: CommitDetail): { kind: "file" | "hunk" | "add" | "del" | "ctx"; text: string }[] {
  const out: { kind: "file" | "hunk" | "add" | "del" | "ctx"; text: string }[] = [];
  for (const f of d.files) {
    out.push({ kind: "file", text: f.old_path && f.old_path !== f.path ? `${f.old_path} → ${f.path}` : f.path });
    for (const h of f.hunks) {
      out.push({ kind: "hunk", text: h.header.trimEnd() });
      for (const l of h.lines) {
        const kind = l.origin === "+" ? "add" : l.origin === "-" ? "del" : "ctx";
        out.push({ kind, text: `${l.origin === "+" || l.origin === "-" ? l.origin : " "}${l.content.replace(/\n$/, "")}` });
      }
    }
    if (f.truncated) out.push({ kind: "ctx", text: "… (cut: open the commit for the rest)" });
  }
  return out;
}

// The fix's commit line, a toggle; open, the files and the diff below it.
export function fixChangesNode(
  commit: string,
  worktree: string | null,
  load: (commit: string) => Promise<CommitDetail>,
  openCommit?: (commit: string) => void,
): HTMLElement {
  const node = el("div", { class: "fix-changes" });
  const where = worktree ? ` in ${worktree.replace(/\/$/, "").split("/").pop()}` : "";
  const draw = () => {
    const open = expanded.has(commit);
    const toggle = el("button", {
      class: "fix-changes-toggle",
      text: `${open ? "▾" : "▸"} Commit ${commit.slice(0, 7)}${where} — ${open ? "hide" : "show"} the changes`,
      title: "The files this fix changed, and the diff",
    });
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (open) expanded.delete(commit);
      else expanded.add(commit);
      draw();
    });
    const head = el("div", { class: "fix-changes-head" }, [toggle]);
    if (openCommit) {
      const history = el("button", { class: "btn small ghost", text: "Open in History", title: "The commit in the graph, with the full diff viewer" });
      history.addEventListener("click", (e) => {
        e.stopPropagation();
        openCommit(commit);
      });
      head.append(history);
    }
    node.replaceChildren(head);
    if (!open) return;
    const body = el("div", { class: "fix-changes-body", text: "Loading the changes…" });
    node.append(body);
    let pending = details.get(commit);
    if (!pending) {
      pending = load(commit);
      details.set(commit, pending);
      pending.catch(() => details.delete(commit));
    }
    void pending.then(
      (d) => {
        const files = el(
          "ul",
          { class: "conflict-preview-files" },
          d.files.map((f) =>
            el("li", {}, [
              el("span", { class: `conflict-preview-status s-${(STATUS_LETTER[f.status] ?? "M").toLowerCase()}`, text: STATUS_LETTER[f.status] ?? "M" }),
              el("span", { class: "conflict-preview-path", text: f.path }),
            ]),
          ),
        );
        body.replaceChildren(
          el("div", { class: "conflict-preview-label", text: `${d.files.length} file${d.files.length === 1 ? "" : "s"} changed · ${d.summary}` }),
          files,
          el("pre", { class: "conflict-preview-diff" }, commitDiffLines(d).map((l) => el("div", { class: `d-${l.kind}`, text: l.text || " " }))),
        );
      },
      (err) => body.replaceChildren(el("span", { class: "fix-changes-error", text: `Couldn't read the commit: ${String(err)}` })),
    );
  };
  draw();
  return node;
}
