// Fetch options popup: pick one remote, or tick "Fetch all remotes".
//
// gitp's toolbar Refresh has always fetched everything. That's the right
// default, but on a repo with several remotes — a fork plus upstream, say —
// waiting on all of them to see one is wasteful, so Quick Launch's "Fetch…"
// opens this instead. Reuses the `.modal-overlay` / `.modal` shell.

import { el } from "../dom";

let overlay: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;

export function closeFetchDialog(): void {
  overlay?.remove();
  overlay = null;
  if (onKey) document.removeEventListener("keydown", onKey, true);
  onKey = null;
}

/// `remotes`: configured remote names, e.g. `["origin", "upstream"]`.
/// `onFetch` receives the chosen remote, or null for "all remotes".
export function openFetchDialog(remotes: string[], onFetch: (remote: string | null) => void): void {
  closeFetchDialog();

  overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal fetch-modal" });
  overlay.append(modal);
  document.body.append(overlay);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeFetchDialog();
  });

  modal.append(
    el("div", { class: "modal-title", text: "Fetch" }),
    el("div", { class: "modal-sub", text: "Fetch latest changes from the remote repository" }),
  );

  const select = el("select", { class: "fetch-remote" }) as HTMLSelectElement;
  for (const name of remotes) select.append(el("option", { value: name, text: name }));
  const row = el("div", { class: "fetch-row" }, [
    el("label", { class: "fetch-row-label", text: "Remote:" }),
    select,
  ]);

  const all = el("input", { type: "checkbox" }) as HTMLInputElement;
  // Only one remote to choose from means the choice is already made: default to
  // all (identical in effect) and grey the dropdown out rather than presenting
  // a control that can't change anything.
  all.checked = remotes.length <= 1;
  const allLabel = el("label", { class: "fetch-check" }, [all, el("span", { text: "Fetch all remotes" })]);
  const syncSelect = () => (select.disabled = all.checked || remotes.length === 0);
  all.addEventListener("change", syncSelect);
  syncSelect();

  modal.append(row, allLabel);

  const cancel = el("button", { class: "btn ghost", text: "Cancel" });
  cancel.addEventListener("click", closeFetchDialog);
  const fetch = el("button", { class: "btn", text: "Fetch" });
  const submit = () => {
    const remote = all.checked || !select.value ? null : select.value;
    closeFetchDialog();
    onFetch(remote);
  };
  fetch.addEventListener("click", submit);
  modal.append(el("div", { class: "modal-actions" }, [cancel, fetch]));

  onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeFetchDialog();
    else if (e.key === "Enter") submit();
  };
  document.addEventListener("keydown", onKey, true);
  requestAnimationFrame(() => fetch.focus());
}
