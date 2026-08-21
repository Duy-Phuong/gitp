// Delete-branch confirmation modal. Confirms the local delete and, when the
// branch has a remote counterpart, offers to also delete it on the remote via a
// checkbox (unchecked by default — deleting the remote branch is the riskier,
// opt-in action).

import { el } from "../dom";

export function openDeleteBranchModal(
  branchName: string,
  remoteBranch: string | null,
  onConfirm: (deleteRemote: boolean) => void,
): void {
  const overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal delete-modal" });
  overlay.append(modal);

  let deleteRemote = false;

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey, true);

  modal.append(
    el("div", { class: "modal-title", text: "Delete Branch" }),
    el("div", { class: "modal-sub", text: "Delete local branch from your repository" }),
    el("div", { class: "delete-branch-row" }, [
      el("span", { class: "delete-branch-label", text: "Branch:" }),
      el("span", { class: "delete-branch-name", text: branchName }),
    ]),
  );

  if (remoteBranch) {
    const box = el("input", { type: "checkbox" }) as HTMLInputElement;
    box.addEventListener("change", () => (deleteRemote = box.checked));
    modal.append(
      el("label", { class: "delete-remote-row" }, [
        el("span", { class: "delete-warn-icon", text: "⚠️" }),
        box,
        el("span", { text: `Also delete remote branch ${remoteBranch}` }),
      ]),
    );
  }

  const cancel = el("button", { class: "btn ghost", text: "Cancel" });
  cancel.addEventListener("click", close);
  const del = el("button", { class: "btn danger-btn", text: "Delete" });
  del.addEventListener("click", () => {
    close();
    onConfirm(deleteRemote);
  });

  modal.append(el("div", { class: "modal-actions" }, [el("span", { class: "spacer" }), cancel, del]));
  document.body.append(overlay);
  requestAnimationFrame(() => del.focus());
}
