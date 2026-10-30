// The GitHub sign-in dialog: the one-time code `gh auth login` printed, a
// Copy button, an Open GitHub button for the device page, and Cancel. It stays
// up while gh waits for the user to approve in the browser; the caller closes
// it when gh finishes.

import { copyToClipboard, el } from "../dom";

export interface SignInDialog {
  close: () => void;
}

export function openSignInDialog(code: string, url: string, on: { openUrl: () => void; cancel: () => void }): SignInDialog {
  const overlay = el("div", { class: "modal-overlay" });
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const cancel = () => {
    close();
    on.cancel();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") cancel();
  };
  document.addEventListener("keydown", onKey, true);

  const copy = el("button", { class: "btn ghost small", text: "Copy" });
  copy.addEventListener("click", () => {
    void copyToClipboard(code);
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy"), 1200);
  });
  const open = el("button", { class: "btn", text: "Open GitHub" });
  open.addEventListener("click", on.openUrl);
  const cancelBtn = el("button", { class: "btn ghost", text: "Cancel" });
  cancelBtn.addEventListener("click", cancel);

  overlay.append(
    el("div", { class: "modal gh-sign-in", role: "dialog", "aria-label": "Sign in to GitHub" }, [
      el("div", { class: "modal-title", text: "Sign in to GitHub" }),
      el("div", { class: "modal-sub", text: `Enter this code at ${url}, then approve the GitHub CLI.` }),
      el("div", { class: "gh-code-row" }, [el("code", { class: "gh-code", text: code }), copy]),
      el("div", { class: "gh-sign-in-wait", text: "Waiting for you to approve in the browser…" }),
      el("div", { class: "modal-actions" }, [el("span", { class: "spacer" }), cancelBtn, open]),
    ]),
  );
  document.body.append(overlay);
  requestAnimationFrame(() => open.focus());
  return { close };
}
