// The answer of an "Explain with Claude" run: Markdown in a dialog, with
// Copy. Closing it doesn't stop the run — it is a Claude job, listed with
// its Stop — and an answer that lands after the dialog closed says so.

import { clear, el } from "../dom";
import { renderGitHubMarkdown } from "./github-markdown";

export interface AskDialogCallbacks {
  copy: (text: string) => void;
  reportDone: (msg: string) => void;
  reportError: (title: string, err: unknown) => void;
}

let overlay: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;

export function closeAskDialog(): void {
  overlay?.remove();
  overlay = null;
  if (onKey) document.removeEventListener("keydown", onKey, true);
  onKey = null;
}

export function openAskDialog(title: string, run: () => Promise<string>, cb: AskDialogCallbacks): void {
  closeAskDialog();
  const mine = el("div", { class: "modal-overlay" });
  overlay = mine;
  const body = el("div", { class: "ask-body" }, [el("div", { class: "ask-wait", text: "Claude is reading… It runs as a Claude job: close this and it keeps going." })]);
  const copy = el("button", { class: "btn ghost", text: "Copy" });
  copy.disabled = true;
  const close = el("button", { class: "btn", text: "Close" });
  close.addEventListener("click", closeAskDialog);
  mine.append(
    el("div", { class: "modal ask-dialog" }, [
      el("div", { class: "modal-title", text: title }),
      body,
      el("div", { class: "modal-actions" }, [el("span", { class: "spacer" }), copy, close]),
    ]),
  );
  mine.addEventListener("mousedown", (e) => {
    if (e.target === mine) closeAskDialog();
  });
  onKey = (e) => {
    if (e.key === "Escape") closeAskDialog();
  };
  document.addEventListener("keydown", onKey, true);
  document.body.append(mine);

  run().then(
    (answer) => {
      if (overlay !== mine) {
        cb.reportDone(`${title}: ready in Claude jobs.`);
        return;
      }
      clear(body);
      body.append(renderGitHubMarkdown(answer));
      copy.disabled = false;
      copy.addEventListener("click", () => cb.copy(answer));
    },
    (err) => {
      if (overlay === mine) closeAskDialog();
      cb.reportError(`${title} failed`, err);
    },
  );
}
