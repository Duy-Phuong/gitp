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
  // Red, for an answer that destroys something.
  danger?: boolean;
}

export function askChoice<T>(
  title: string,
  sub: string,
  buttons: ChoiceButton<T>[],
  cancel: T,
  cls = "",
  body: Node[] = [],
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
      const node = el("button", { class: b.danger ? "btn danger-btn" : b.primary ? "btn" : "btn ghost", text: b.label });
      node.addEventListener("click", () => done(b.answer));
      if (b.primary) focus = node;
      return node;
    };
    overlay.append(
      el("div", { class: `modal ${cls}`.trim() }, [
        el("div", { class: "modal-title", text: title }),
        el("div", { class: "modal-sub", text: sub }),
        ...body,
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

// Confirm an action on a list of names (branches to delete): the names sit in
// a box that scrolls, so a long list keeps the buttons on screen. A native
// dialog cannot scroll. Resolves true for the confirm button only.
export function askConfirmList(
  title: string,
  sub: string,
  names: string[],
  note: string,
  confirmLabel: string,
): Promise<boolean> {
  return askChoice(
    title,
    sub,
    [
      { label: "Cancel", answer: false },
      { label: confirmLabel, answer: true, primary: true, danger: true },
    ],
    false,
    "list-confirm",
    [
      el("ul", { class: "list-confirm-names" }, names.map((n) => el("li", { text: n }))),
      ...(note ? [el("div", { class: "list-confirm-note", text: note })] : []),
    ],
  );
}
