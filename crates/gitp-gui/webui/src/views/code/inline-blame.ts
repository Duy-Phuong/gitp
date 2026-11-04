// Inline blame: after the end of the caret's line, dimmed, who last changed
// it, when, and the commit's subject. Hovering it opens a card with the full
// commit message, the pull request it came in with (a link to GitHub) and the
// commit id (shows it in History).
//
// The blame is of the editor's own text, so a line edited since the last
// commit reads "Not committed yet". It is read when the file opens and again
// a moment after the text stops changing; until then nothing shows, rather
// than an answer for lines that have moved.

import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

import { el } from "../../dom";
import { fullTime, relativeTime } from "../../timeago";
import type { BlameCommit, FileBlame } from "../../types";

export interface InlineBlameDeps {
  enabled: () => boolean;
  fetch: (path: string, text: string) => Promise<FileBlame>;
  // The commit's pull request — `number` when its message names one.
  pullRequest: (commit: string, number: number | null) => Promise<{ number: number; url: string } | null>;
  openUrl: (url: string) => void;
  showCommit: (commit: string) => void;
}

// How long the text must rest before it is blamed again.
export const BLAME_IDLE_MS = 1000;

/// The pull request a commit message names: a squash merge's "Subject
/// (#3019)", or a merge commit's "Merge pull request #3019 from …".
export function prNumberIn(summary: string): number | null {
  const m = /\(#(\d+)\)\s*$/.exec(summary) ?? /^Merge pull request #(\d+)\b/.exec(summary);
  return m ? Number(m[1]) : null;
}

/// The text shown after the line: "Huy Vu, 2 months ago • subject".
export function blameLabel(c: BlameCommit | null): string {
  if (!c) return "You, Not committed yet";
  return `${c.author}, ${relativeTime(c.time)} • ${c.summary}`;
}

const setBlame = StateEffect.define<FileBlame | null>();

// The file's blame, dropped on any edit: its line numbers no longer hold.
const blameField = StateField.define<FileBlame | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBlame)) return e.value;
    return tr.docChanged ? null : value;
  },
});

class BlameWidget extends WidgetType {
  constructor(
    readonly line: number,
    readonly commit: string | null,
    readonly info: BlameCommit | null,
    readonly deps: InlineBlameDeps,
  ) {
    super();
  }
  eq(other: BlameWidget): boolean {
    return other.line === this.line && other.commit === this.commit && other.info === this.info;
  }
  toDOM(): HTMLElement {
    const span = el("span", { class: "cm-inline-blame", text: blameLabel(this.info) });
    if (this.commit && this.info) {
      const commit = this.commit;
      const info = this.info;
      span.addEventListener("mouseenter", () => showCard(span, commit, info, this.deps));
      span.addEventListener("mouseleave", hideCardSoon);
    }
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/// The inline blame for the file at `path`.
export function inlineBlame(path: string, deps: InlineBlameDeps): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private timer: ReturnType<typeof setTimeout> | undefined;
      // Drops an answer for text that changed while it was on its way.
      private asked = 0;

      constructor(private view: EditorView) {
        // Back on a tab whose text hasn't changed: its blame still holds.
        const known = view.state.field(blameField);
        if (known) this.decorations = this.build(known);
        else this.schedule(0);
      }
      update(u: ViewUpdate): void {
        if (u.docChanged) this.schedule(BLAME_IDLE_MS);
        if (u.docChanged || u.selectionSet || u.transactions.some((t) => t.effects.some((e) => e.is(setBlame)))) {
          this.decorations = this.build(u.state.field(blameField));
        }
      }
      destroy(): void {
        clearTimeout(this.timer);
        hideCard();
      }
      private schedule(ms: number): void {
        clearTimeout(this.timer);
        if (!deps.enabled()) return;
        this.timer = setTimeout(() => void this.read(), ms);
      }
      private async read(): Promise<void> {
        const mine = ++this.asked;
        let blame: FileBlame | null = null;
        try {
          blame = await deps.fetch(path, this.view.state.doc.toString());
        } catch {
          // Not tracked, or no git: no blame.
        }
        if (mine === this.asked) this.view.dispatch({ effects: setBlame.of(blame) });
      }
      private build(blame: FileBlame | null): DecorationSet {
        if (!blame || !deps.enabled()) return Decoration.none;
        const state = this.view.state;
        const line = state.doc.lineAt(state.selection.main.head);
        if (line.number > blame.lines.length) return Decoration.none;
        const commit = blame.lines[line.number - 1] ?? null;
        const info = commit ? (blame.commits[commit] ?? null) : null;
        if (commit && !info) return Decoration.none;
        const widget = Decoration.widget({ widget: new BlameWidget(line.number, commit, info, deps), side: 1 });
        return Decoration.set([widget.range(line.to)]);
      }
    },
    { decorations: (p) => p.decorations },
  );
  return [blameField, plugin];
}

// --- The hover card ---------------------------------------------------------

let card: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
// Pull requests already looked up, by commit: one call to GitHub each.
const prs = new Map<string, Promise<{ number: number; url: string } | null>>();

function hideCard(): void {
  clearTimeout(hideTimer);
  card?.remove();
  card = null;
}

// A moment's grace, so the pointer can travel from the text onto the card.
function hideCardSoon(): void {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideCard, 250);
}

function showCard(anchor: HTMLElement, commit: string, info: BlameCommit, deps: InlineBlameDeps): void {
  hideCard();
  const link = (text: string, title: string, onClick: () => void) => {
    const a = el("button", { class: "blame-card-link", type: "button", text, title });
    a.addEventListener("click", (e) => {
      e.preventDefault();
      onClick();
    });
    return a;
  };
  const sha = link(commit.slice(0, 8), "Show this commit in History", () => {
    hideCard();
    deps.showCommit(commit);
  });
  const subject = el("span", { text: info.summary });
  const pr = el("span", { class: "blame-card-pr" });
  const head = el("div", { class: "blame-card-head" }, [
    el("span", { class: "blame-card-author", text: info.author, title: info.email }),
    el("span", { class: "blame-card-when", text: `${relativeTime(info.time)} (${fullTime(info.time)})` }),
    el("span", { class: "spacer" }),
    sha,
  ]);
  const body = el("div", { class: "blame-card-body" }, [
    el("div", { class: "blame-card-subject" }, [subject, pr]),
  ]);
  if (info.body) body.append(el("pre", { class: "blame-card-message", text: info.body }));
  card = el("div", { class: "blame-card", role: "tooltip" }, [head, body]);
  card.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  card.addEventListener("mouseleave", hideCardSoon);
  document.body.append(card);

  const r = anchor.getBoundingClientRect();
  const width = Math.min(560, window.innerWidth - 16);
  card.style.width = `${width}px`;
  card.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
  // Below the line when it fits, else above it.
  const below = r.bottom + 6;
  const height = card.offsetHeight;
  card.style.top = `${below + height < window.innerHeight - 8 ? below : Math.max(8, r.top - height - 6)}px`;

  const shown = card;
  let lookup = prs.get(commit);
  if (!lookup) {
    lookup = deps.pullRequest(commit, prNumberIn(info.summary)).catch(() => null);
    prs.set(commit, lookup);
  }
  void lookup.then((found) => {
    if (!found || card !== shown) return;
    // The "(#3019)" the subject ends with becomes the link.
    subject.textContent = info.summary.replace(new RegExp(`\\s*\\(#${found.number}\\)\\s*$`), "");
    pr.append(link(`#${found.number}`, `Open pull request #${found.number} on GitHub`, () => deps.openUrl(found.url)));
  });
}
