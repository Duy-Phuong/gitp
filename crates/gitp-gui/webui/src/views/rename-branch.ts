// Rename-branch modal. A prefilled "New name" input plus — when the branch
// genuinely exists on its remote (probed live via git ls-remote) — an "Also
// rename origin/<name>" checkbox. Mirrors the delete-branch modal's remote probe.

import { el } from "../dom";

export function openRenameBranchModal(
  currentName: string,
  remoteProbe: Promise<string | null>,
  onConfirm: (newName: string, renameRemote: boolean) => void,
): void {
  const overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal rename-modal" });
  overlay.append(modal);

  let renameRemote = false;
  let closed = false;

  const close = () => {
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const submit = () => {
    const newName = input.value.trim();
    if (!newName || newName === currentName) {
      close();
      return;
    }
    close();
    onConfirm(newName, renameRemote);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey, true);

  const input = el("input", {
    class: "rename-input",
    value: currentName,
    spellcheck: false,
  }) as HTMLInputElement;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  modal.append(
    el("div", { class: "modal-title", text: "Rename Local Branch" }),
    el("div", { class: "modal-sub", text: "Rename local branch" }),
    el("div", { class: "rename-row" }, [
      el("span", { class: "rename-label", text: "New name:" }),
      input,
    ]),
  );

  // Filled in once the remote probe resolves.
  const remoteSlot = el("div", { class: "delete-remote-slot" }, [
    el("span", { class: "delete-remote-checking", text: "Checking remote…" }),
  ]);
  modal.append(remoteSlot);

  const cancel = el("button", { class: "btn ghost", text: "Cancel" });
  cancel.addEventListener("click", close);
  const rename = el("button", { class: "btn", text: "Rename" });
  rename.addEventListener("click", submit);
  modal.append(el("div", { class: "modal-actions" }, [el("span", { class: "spacer" }), cancel, rename]));

  document.body.append(overlay);
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });

  remoteProbe
    .then((remoteBranch) => {
      if (closed) return;
      remoteSlot.replaceChildren();
      if (!remoteBranch) return; // not on the remote — local-only rename
      const box = el("input", { type: "checkbox" }) as HTMLInputElement;
      box.addEventListener("change", () => (renameRemote = box.checked));
      remoteSlot.append(
        el("label", { class: "delete-remote-row" }, [
          box,
          el("span", { text: `Also rename ${remoteBranch}` }),
        ]),
      );
    })
    .catch(() => {
      if (!closed) remoteSlot.replaceChildren();
    });
}
