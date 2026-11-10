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
import { renderGitHubMarkdown } from "./github-markdown";

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
}

function button(text: string, onClick: () => void, cls = "btn small ghost"): HTMLButtonElement {
  const b = el("button", { class: cls, text });
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

export function draftCard(d: Draft, o: DraftCardOptions): HTMLElement {
  const head = el("div", { class: "pr-draft-head" }, [
    d.path
      ? el("code", { class: "pr-draft-where", text: `${d.path}:${d.line}${d.side === "LEFT" ? " (removed line)" : ""}` })
      : el("span", { class: "pr-draft-where pr-draft-topic", text: d.topic ?? "On the whole change" }),
  ]);
  if (d.severity) head.append(el("span", { class: `pr-draft-sev ${d.severity.replace(/\W+/g, "-")}`, text: d.severity }));
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
  if (d.status === "discarded") {
    // Back to what it was: a fixed one keeps its fix.
    head.append(button("Restore", () => set(d.fix ? "fixed" : "pending")));
  } else if (d.status === "fixed") {
    head.append(button("Discard", () => set("discarded")));
  } else {
    head.append(button(d.status === "approved" ? "Approved ✓" : "Approve", () => set(d.status === "approved" ? "pending" : "approved")));
    head.append(button("Discard", () => set("discarded")));
    if (o.fix) {
      const fix = button("Fix", o.fix.run);
      fix.disabled = o.fix.reason !== null;
      fix.title = o.fix.reason ?? "Fix this in the branch's worktree with the Fix command (Settings → Git): one commit";
      head.append(fix);
    }
  }
  const card = el("div", { class: `pr-draft ${d.status}${o.where === "inline" ? " inline" : ""}`, "data-draft": d.id }, [head]);
  if (d.status !== "discarded") {
    const why = o.where === "list" ? explainNode(d, o.explain ?? null) : null;
    if (why) card.append(why, el("div", { class: "pr-draft-label", text: "Comment to paste" }));
    const area = composerArea({ class: "pr-draft-text" });
    area.value = d.body;
    area.addEventListener("input", () => {
      d.body = area.value;
      o.changed(false);
    });
    head.append(previewToggle(area).button);
    card.append(area);
  }
  return card;
}

// What the review says about the finding, above its comment: "Explained
// simply", the Explain more answers (the newest open), and Explain more.
// Null when there is none of it.
function explainNode(d: Draft, explain: DraftCardOptions["explain"]): HTMLElement | null {
  const more = d.explanations ?? [];
  if (!d.explained && !more.length && !explain) return null;
  const node = el("div", { class: "pr-draft-explain" });
  const fold = (title: string, md: string, open: boolean) => {
    const box = el("details", { class: "pr-draft-fold" }, [el("summary", { text: title }), el("div", { class: "pr-draft-md" }, [renderGitHubMarkdown(md)])]);
    box.open = open;
    return box;
  };
  if (d.explained) node.append(fold("Explained simply", d.explained, true));
  more.forEach((md, i) => node.append(fold(`Explained more ${i + 1}`, md, i === more.length - 1)));
  if (explain) {
    const b = button(explain.running ? "Explaining…" : "Explain more", explain.run);
    b.disabled = explain.running;
    b.title = more.length
      ? "Ask Claude to explain this finding again, another way, as the review board does; the answer is added here and to the review file"
      : "Ask Claude to explain this finding in more depth, as the review board does; the answer is added here and to the review file";
    const row = el("div", { class: "pr-draft-explain-actions" }, [b]);
    if (explain.failed) row.append(el("span", { class: "pr-draft-warn", text: `Couldn't explain: ${explain.failed}` }));
    node.append(row);
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
