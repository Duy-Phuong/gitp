// One review draft as a card: where it goes, its severity, the text
// (editable), Approve / Discard / Restore, and — on a branch or on your own
// pull request — Fix, or the commit that fixed it. The same card shows in
// the Drafts tab ("list") and under its line in the Files tab ("inline");
// both edit the one Draft object, and `changed(true)` has the views redraw
// so the other one follows.

import { el } from "../dom";
import type { Draft } from "../pr-reviews";
import { lineKey, lineTarget } from "../pull-requests";
import type { FileDiff } from "../types";
import { composerArea, previewToggle } from "./composer";
import { renderMarkdownWithMermaid } from "./mermaid-markdown";

export interface DraftCardOptions {
  where: "list" | "inline";
  // Beside the place: "line not in this diff — …", "line moved", …
  note: string | null;
  // Fix, when offered here: off with `reason` as its title.
  fix: { reason: string | null; run: () => void } | null;
  showInDiff: (() => void) | null;
  openCommit: (sha: string) => void;
  // The draft changed: `redraw` for a status, not for typing.
  changed: (redraw: boolean) => void;
  // Explain more on its finding, as the review board does: whether one runs,
  // why the last one failed. Absent where it isn't offered.
  explain?: { running: boolean; failed: string | null; run: () => void } | null;
  // The draft's file in the diff, for a few lines around its line on the
  // Drafts tab's card. Absent when the diff isn't loaded.
  file?: FileDiff | null;
}

export interface ContextLine {
  origin: string;
  // The line's number on its side: the old file for a removed line.
  no: number | null;
  content: string;
  // The draft's own line.
  target: boolean;
}

// The `around` lines before and after `line` on `side` of `file`, in its
// hunk; empty when the line isn't in the diff.
export function contextLines(file: FileDiff, line: number, side: "LEFT" | "RIGHT", around = 3): ContextLine[] {
  for (const hunk of file.hunks) {
    const i = hunk.lines.findIndex((l) => {
      const t = lineTarget(l);
      return t !== null && t.line === line && t.side === side;
    });
    if (i < 0) continue;
    return hunk.lines.slice(Math.max(0, i - around), i + around + 1).map((l, j) => ({
      origin: l.origin,
      no: l.origin === "-" ? l.old_lineno : l.new_lineno,
      content: l.content.replace(/\r?\n$/, ""),
      target: Math.max(0, i - around) + j === i,
    }));
  }
  return [];
}

// The lines around the draft's line, as a small diff.
function contextNode(d: Draft, file: FileDiff): HTMLElement | null {
  const lines = contextLines(file, d.line, d.side);
  if (!lines.length) return null;
  return el(
    "div",
    { class: "pr-draft-context" },
    lines.map((l) =>
      el("div", { class: `pr-draft-context-line${l.origin === "+" ? " add" : l.origin === "-" ? " del" : ""}${l.target ? " target" : ""}` }, [
        el("span", { class: "pr-draft-context-no", text: l.no === null ? "" : String(l.no) }),
        el("span", { class: "pr-draft-context-code", text: l.content }),
      ]),
    ),
  );
}

function button(text: string, onClick: () => void, cls = "btn small ghost"): HTMLButtonElement {
  const b = el("button", { class: cls, text });
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

// What a fix round's "**Fix status:**" line says: `label` for a badge, and
// `tone` — "done" (fixed), "warn" (still open, changed, not approved) or
// "open" (proposed). Null when the notes have no status line.
export function fixState(notes: string | undefined): { label: string; tone: "done" | "warn" | "open" } | null {
  const m = notes && /\*\*Fix status:?\*\*:?\s*(.+)/i.exec(notes);
  if (!m) return null;
  const said = m[1].trim();
  const label = (/re-check:\s*(.+)$/i.exec(said)?.[1] ?? said).trim();
  if (/still open|not approved|changed|⚠|⏳/i.test(said)) return { label, tone: "warn" };
  if (/✅|\bfixed\b|fixed-local|pushed in/i.test(said)) return { label, tone: "done" };
  return { label, tone: "open" };
}

// Fixed by a fix round, though still open here: nothing left to post.
export const fixedByNotes = (d: Draft): boolean => fixState(d.fixNotes)?.tone === "done";

// The cards a click opened while their draft was folded away (fixed).
const unfolded = new Set<number>();

export function draftCard(d: Draft, o: DraftCardOptions): HTMLElement {
  const dir = d.path.includes("/") ? d.path.slice(0, d.path.lastIndexOf("/") + 1) : "";
  const head = el("div", { class: "pr-draft-head" }, [
    d.path
      ? el("span", { class: "pr-draft-where", title: d.path }, [
          el("strong", { class: "pr-draft-file", text: `${d.path.slice(dir.length)}:${d.line}${d.side === "LEFT" ? " (removed line)" : ""}` }),
          ...(dir ? [el("span", { class: "pr-draft-dir", text: dir })] : []),
        ])
      : el("span", { class: "pr-draft-where pr-draft-topic", text: d.topic ?? "On the whole change" }),
  ]);
  if (d.severity) head.append(el("span", { class: `pr-draft-sev ${d.severity.replace(/\W+/g, "-")}`, text: d.severity }));
  const fixed = fixState(d.fixNotes);
  if (fixed) head.append(el("span", { class: `pr-draft-fix-badge ${fixed.tone}`, text: fixed.label, title: "The fix round's status, from the review file" }));
  if (o.note) head.append(el("span", { class: "pr-draft-warn", text: o.note }));
  if (o.showInDiff) head.append(button("Show in diff", o.showInDiff, "btn small ghost pr-draft-show"));
  head.append(el("span", { class: "spacer" }));
  const set = (status: Draft["status"]) => {
    d.status = status;
    o.changed(true);
  };
  if (d.fix && d.status !== "discarded") {
    const sha = d.fix.commit;
    const link = button(`Fixed in ${sha.slice(0, 7)}`, () => o.openCommit(sha), "btn small ghost pr-draft-fixed");
    link.title = `Open ${sha.slice(0, 12)}, made in ${d.fix.worktree}`;
    head.append(link);
  }
  // Fixed already, by a commit here or by a fix round: Discard is the one
  // thing left to do, and the card folds to its head.
  const done = d.status === "fixed" || (o.where === "list" && d.status === "pending" && fixed?.tone === "done");
  const folded = done && o.where === "list" && !unfolded.has(d.id);
  if (d.status === "discarded") {
    // Back to what it was: a fixed one keeps its fix.
    head.append(button("Restore", () => set(d.fix ? "fixed" : "pending")));
  } else if (d.status === "fixed") {
    head.append(button("Discard", () => set("discarded")));
  } else {
    const approve = button(d.status === "approved" ? "Approved ✓" : "Approve", () => set(d.status === "approved" ? "pending" : "approved"), done ? "btn small ghost" : "btn small");
    approve.title = done ? "The review file says this is fixed: post it anyway" : "Post this comment with the review";
    head.append(approve, button("Discard", () => set("discarded"), done ? "btn small" : "btn small ghost"));
    if (o.fix) {
      const fix = button("Fix", o.fix.run);
      fix.disabled = o.fix.reason !== null;
      fix.title = o.fix.reason ?? "Fix this in the branch's worktree with the Fix command (Settings → Git): one commit";
      head.append(fix);
    }
  }
  const card = el("div", { class: `pr-draft ${d.status}${o.where === "inline" ? " inline" : ""}${folded ? " folded" : ""}`, "data-draft": d.id }, [head]);
  if (done && o.where === "list" && d.status !== "discarded") {
    head.append(
      button(folded ? "Show" : "Hide", () => {
        if (folded) unfolded.add(d.id);
        else unfolded.delete(d.id);
        o.changed(true);
      }),
    );
  }
  if (d.status !== "discarded" && !folded) {
    const context = o.where === "list" && o.file && d.path ? contextNode(d, o.file) : null;
    if (context) card.append(context);
    const why = o.where === "list" ? explainNode(d, o.explain ?? null) : null;
    const notes = o.where === "list" ? fixNotesNode(d.fixNotes, fixed) : null;
    if (why) card.append(why);
    if (why || notes) card.append(el("div", { class: "pr-draft-label", text: "Comment to paste" }));
    const area = composerArea({ class: "pr-draft-text" });
    area.value = d.body;
    area.addEventListener("input", () => {
      d.body = area.value;
      o.changed(false);
    });
    head.append(previewToggle(area).button);
    card.append(area);
    if (notes) card.append(notes);
  }
  return card;
}

// A fix round's notes under the comment, as Markdown, with the status as a
// badge; folded once the status says fixed.
function fixNotesNode(notes: string | undefined, state: ReturnType<typeof fixState>): HTMLElement | null {
  if (!notes) return null;
  const summary = el("summary", {}, [el("span", { class: "pr-draft-fold-title", text: "Fix" })]);
  if (state) summary.append(el("span", { class: `pr-draft-fix-badge ${state.tone}`, text: state.label }));
  const box = el("details", { class: "pr-draft-fold pr-draft-fix-notes" }, [summary, el("div", { class: "pr-draft-md" }, [renderMarkdownWithMermaid(notes)])]);
  box.open = state?.tone !== "done";
  return box;
}

// What the review says about the finding, above its comment: "Explained
// simply", the Explain more answers (the newest open), and Explain more in
// the title of the first. Null when there is none of it.
function explainNode(d: Draft, explain: DraftCardOptions["explain"]): HTMLElement | null {
  const more = d.explanations ?? [];
  if (!d.explained && !more.length && !explain) return null;
  const node = el("div", { class: "pr-draft-explain" });
  const folds: HTMLDetailsElement[] = [];
  const fold = (title: string, md: string, open: boolean) => {
    const box = el("details", { class: "pr-draft-fold" }, [
      el("summary", {}, [el("span", { class: "pr-draft-fold-title", text: title })]),
      el("div", { class: "pr-draft-md" }, [renderMarkdownWithMermaid(md)]),
    ]) as HTMLDetailsElement;
    box.open = open;
    folds.push(box);
    return box;
  };
  if (d.explained) node.append(fold("Explained simply", d.explained, true));
  more.forEach((md, i) => node.append(fold(`Explained more ${i + 1}`, md, i === more.length - 1)));
  if (explain) {
    const b = button(explain.running ? "Explaining…" : "Explain more", explain.run, "btn small ghost pr-draft-explain-btn");
    // In a fold's title: the click mustn't open or close it too.
    b.addEventListener("click", (e) => e.preventDefault());
    b.disabled = explain.running;
    b.title = more.length
      ? "Ask Claude to explain this finding again, another way, as the review board does; the answer is added here and to the review file"
      : "Ask Claude to explain this finding in more depth, as the review board does; the answer is added here and to the review file";
    if (folds.length) folds[0].querySelector("summary")!.append(b);
    else node.append(el("div", { class: "pr-draft-explain-actions" }, [b]));
    if (explain.failed) node.append(el("div", { class: "pr-draft-explain-actions" }, [el("span", { class: "pr-draft-warn", text: `Couldn't explain: ${explain.failed}` })]));
  }
  return node;
}

// Put a card for each of `drafts` (at `line` on `side` of `file`) under that
// line of `node`, a diff renderFile or renderSplitDiff drew: after what is
// already there (threads, other cards), once per line even where the split
// view shows it twice.
export function placeDraftCards(
  node: HTMLElement,
  file: FileDiff,
  drafts: { d: Draft; line: number; side: "LEFT" | "RIGHT" }[],
  card: (d: Draft) => HTMLElement,
): void {
  if (!drafts.length) return;
  const byKey = new Map<string, Draft[]>();
  for (const x of drafts) {
    const k = lineKey(file.path, x.side, x.line);
    byKey.set(k, [...(byKey.get(k) ?? []), x.d]);
  }
  for (const row of node.querySelectorAll<HTMLElement>(".diff-line, .split-cell[data-line]")) {
    const hunk = Number(row.closest<HTMLElement>(".hunk")?.dataset.hunk);
    const line = file.hunks[hunk]?.lines[Number(row.dataset.line)];
    const target = line && lineTarget(line);
    if (!target) continue;
    const k = lineKey(file.path, target.side, target.line);
    const here = byKey.get(k);
    if (!here) continue;
    byKey.delete(k);
    let after: Element = row.closest(".split-row") ?? row;
    while (after.nextElementSibling?.matches(".pr-thread, .pr-draft")) after = after.nextElementSibling;
    for (const d of here) {
      const c = card(d);
      after.after(c);
      after = c;
    }
  }
}
