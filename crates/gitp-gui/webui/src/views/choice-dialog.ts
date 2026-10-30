// A question with more answers than Yes / No (Save / Don't Save / Cancel,
// Stash & Switch / Switch / Cancel): the native ask() dialog has only two.
// Resolves with the chosen button's answer; Escape or a backdrop click gives
// `cancel`. The primary button has focus, so Enter picks it.

import { el } from "../dom";

export interface ChoiceButton<T> {
  label: string;
  answer: T;
  // The accent button, focused when the dialog opens.
  primary?: boolean;
  // Set apart at the far left, like "Don't Save".
  left?: boolean;
}

export function askChoice<T>(
  title: string,
  sub: string,
  buttons: ChoiceButton<T>[],
  cancel: T,
  cls = "",
): Promise<T> {
  return new Promise((resolve) => {
    const overlay = el("div", { class: "modal-overlay" });
    const done = (answer: T) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(answer);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      done(cancel);
    };
    let focus: HTMLElement | null = null;
    const btn = (b: ChoiceButton<T>) => {
      const node = el("button", { class: b.primary ? "btn" : "btn ghost", text: b.label });
      node.addEventListener("click", () => done(b.answer));
      if (b.primary) focus = node;
      return node;
    };
    overlay.append(
      el("div", { class: `modal ${cls}`.trim() }, [
        el("div", { class: "modal-title", text: title }),
        el("div", { class: "modal-sub", text: sub }),
        el("div", { class: "modal-actions" }, [
          ...buttons.filter((b) => b.left).map(btn),
          el("span", { class: "spacer" }),
          ...buttons.filter((b) => !b.left).map(btn),
        ]),
      ]),
    );
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) done(cancel);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
    requestAnimationFrame(() => focus?.focus());
  });
}
