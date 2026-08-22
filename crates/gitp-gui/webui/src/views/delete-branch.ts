// Delete-branch confirmation modal. Confirms the local delete and, when the
// branch genuinely exists on its remote, offers to also delete it there via a
// checkbox (unchecked by default — the riskier, opt-in action).
//
// Remote existence is probed live (git ls-remote) and passed in as a promise:
// the modal shows "Checking remote…" until it resolves, then reveals the
// checkbox only if the branch is actually present on the remote.

import { el } from "../dom";

export function openDeleteBranchModal(
  branchName: string,
  remoteProbe: Promise<string | null>,
  onConfirm: (deleteRemote: boolean) => void,
): void {
  const overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal delete-modal" });
  overlay.append(modal);

  let deleteRemote = false;
  let closed = false;

  const close = () => {
    closed = true;
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

  // Placeholder for the remote-delete option; filled in once the probe resolves.
  const remoteSlot = el("div", { class: "delete-remote-slot" }, [
    el("span", { class: "delete-remote-checking", text: "Checking remote…" }),
  ]);
  modal.append(remoteSlot);

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

  remoteProbe
    .then((remoteBranch) => {
      if (closed) return;
      remoteSlot.replaceChildren();
      if (!remoteBranch) return; // not on the remote — local-only delete
      const box = el("input", { type: "checkbox" }) as HTMLInputElement;
      box.addEventListener("change", () => (deleteRemote = box.checked));
      remoteSlot.append(
        el("label", { class: "delete-remote-row" }, [
          el("span", { class: "delete-warn-icon", text: "⚠️" }),
          box,
          el("span", { text: `Also delete remote branch ${remoteBranch}` }),
        ]),
      );
    })
    .catch(() => {
      // Couldn't confirm (no remote / unreachable) — offer local delete only.
      if (!closed) remoteSlot.replaceChildren();
    });
}
