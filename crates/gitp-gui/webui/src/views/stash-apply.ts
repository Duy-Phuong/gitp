// Apply-stash popup: a small modal with a "Delete stash after applying"
// checkbox, mirroring the confirmation dialogs of desktop git clients. Checked
// applies then drops the entry (git stash pop); unchecked leaves it in place
// (git stash apply). Reuses the `.modal-overlay` / `.modal` shell.

import { clear, el } from "../dom";
import type { StashRef } from "../types";

let overlay: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;

export function closeStashApplyModal(): void {
  overlay?.remove();
  overlay = null;
  if (onKey) document.removeEventListener("keydown", onKey, true);
  onKey = null;
}

export function openStashApplyModal(stash: StashRef, onApply: (drop: boolean) => void): void {
  closeStashApplyModal();

  overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal stash-apply-modal" });
  overlay.append(modal);
  document.body.append(overlay);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeStashApplyModal();
  });
  onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeStashApplyModal();
  };
  document.addEventListener("keydown", onKey, true);

  clear(modal);
  modal.append(
    el("div", { class: "modal-title", text: "Apply Stash" }),
    el("div", { class: "modal-sub", text: "Apply changes of the stash to your working directory" }),
    el("div", { class: "stash-apply-name", text: `stash@{${stash.index}}  ${stash.message}` }),
  );

  const checkbox = el("input", { type: "checkbox" }) as HTMLInputElement;
  const label = el("label", { class: "stash-apply-check" }, [
    checkbox,
    el("span", { text: "Delete stash after applying" }),
  ]);
  modal.append(label);
  modal.append(
    el("div", {
      class: "modal-sub",
      text: "Stash will not be deleted if a conflict occurs.",
    }),
  );

  const cancel = el("button", { class: "btn ghost", text: "Cancel" });
  cancel.addEventListener("click", closeStashApplyModal);
  const apply = el("button", { class: "btn", text: "Apply" });
  apply.addEventListener("click", () => {
    const drop = checkbox.checked;
    closeStashApplyModal();
    onApply(drop);
  });
  modal.append(el("div", { class: "modal-actions" }, [cancel, apply]));
}
