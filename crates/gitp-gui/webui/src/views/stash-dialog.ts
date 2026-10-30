// Stash popup behind the toolbar's Stash button and Quick Launch's "Save
// Stash": an optional message, "Include untracked files" (on, as the plain
// stash always was) and "Staged changes only" (git stash push --staged).
// Enter submits, so Stash + Enter is still the one-step stash it used to be.
// Reuses the `.modal-overlay` / `.modal` shell.

import { el } from "../dom";
import type { StashOptions } from "../types";

let overlay: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;

// Whether a key submits the stash: Enter, except on a focused button (Cancel
// must cancel; the Stash button clicks itself) and the Enter that confirms an
// IME composition in the message.
export function submitsOnEnter(e: KeyboardEvent): boolean {
  if (e.key !== "Enter" || e.isComposing) return false;
  return !(e.target instanceof HTMLElement && e.target.matches("button"));
}

export function closeStashDialog(): void {
  overlay?.remove();
  overlay = null;
  if (onKey) document.removeEventListener("keydown", onKey, true);
  onKey = null;
}

export function openStashDialog(onStash: (opts: StashOptions) => void): void {
  closeStashDialog();

  overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal stash-modal" });
  overlay.append(modal);
  document.body.append(overlay);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeStashDialog();
  });

  const message = el("input", {
    class: "rename-input",
    placeholder: "Message (optional)",
    spellcheck: "false",
    autocomplete: "off",
  }) as HTMLInputElement;

  const untracked = el("input", { type: "checkbox" }) as HTMLInputElement;
  untracked.checked = true;
  const staged = el("input", { type: "checkbox" }) as HTMLInputElement;
  // git refuses --staged together with untracked files, and a staged-only
  // stash has no untracked files to take anyway — so the one rules out the other.
  staged.addEventListener("change", () => (untracked.disabled = staged.checked));

  modal.append(
    el("div", { class: "modal-title", text: "Stash" }),
    el("div", { class: "modal-sub", text: "Save your local changes away and revert them in the working tree" }),
    message,
    el("label", { class: "stash-apply-check" }, [untracked, el("span", { text: "Include untracked files" })]),
    el("label", { class: "stash-apply-check" }, [staged, el("span", { text: "Staged changes only" })]),
  );

  const cancel = el("button", { class: "btn ghost", text: "Cancel" });
  cancel.addEventListener("click", closeStashDialog);
  const stash = el("button", { class: "btn", text: "Stash" });
  const submit = () => {
    const opts: StashOptions = {
      message: message.value.trim(),
      staged: staged.checked,
      includeUntracked: !staged.checked && untracked.checked,
    };
    closeStashDialog();
    onStash(opts);
  };
  stash.addEventListener("click", submit);
  modal.append(el("div", { class: "modal-actions" }, [cancel, stash]));

  onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeStashDialog();
    else if (submitsOnEnter(e)) {
      e.preventDefault();
      submit();
    }
  };
  document.addEventListener("keydown", onKey, true);
  requestAnimationFrame(() => message.focus());
}
