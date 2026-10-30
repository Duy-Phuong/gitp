// The dialogs that make a repository that isn't open yet: Init Repository.
//
// Each only collects what the user wants and hands it to `onSubmit`; the
// git work, its progress and its errors belong to the caller, like every
// other action. Reuses the `.modal-overlay` / `.modal` shell.

import { browseForFolder, isTauri } from "../api";
import { el } from "../dom";
import { GITIGNORE_TEMPLATES } from "../gitignore-templates";

export interface InitRequest {
  path: string;
  /// The `.gitignore` body to write, or null for none.
  gitignore: string | null;
  readme: boolean;
}

let overlay: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;

export function closeNewRepoDialog(): void {
  overlay?.remove();
  overlay = null;
  if (onKey) document.removeEventListener("keydown", onKey, true);
  onKey = null;
}

/// `defaultPath`: where the folder field starts (it can be edited or browsed).
export function openInitDialog(defaultPath: string, onSubmit: (req: InitRequest) => void): void {
  const path = textInput("/path/to/new-repository", defaultPath);
  const template = el("select", { class: "new-repo-input" });
  template.append(el("option", { value: "", text: "None" }));
  for (const [i, t] of GITIGNORE_TEMPLATES.entries()) template.append(el("option", { value: String(i), text: t.name }));
  const readme = el("input", { type: "checkbox" });
  readme.checked = true;

  const modal = openShell("Initialize a Repository", "Create a new, empty Git repository in a folder.", "Create", (fail) => {
    const folder = path.value.trim();
    if (!folder) return fail("Choose a folder for the repository.");
    const picked = template.value === "" ? null : GITIGNORE_TEMPLATES[Number(template.value)];
    onSubmit({ path: folder, gitignore: picked?.body ?? null, readme: readme.checked });
  });
  modal.body.append(
    field("Folder", path, browseButton(path, "Folder for the New Repository")),
    field(".gitignore", template),
    el("label", { class: "fetch-check new-repo-check" }, [readme, el("span", { text: "Create README.md" })]),
  );
  requestAnimationFrame(() => path.focus());
}

// --- shared layout ----------------------------------------------------------

// The overlay, title, a body for the fields, an error line, and Cancel /
// `submitLabel`. `submit` gets a `fail` that keeps the dialog open with a
// message; returning without calling it closes the dialog.
function openShell(
  title: string,
  sub: string,
  submitLabel: string,
  submit: (fail: (message: string) => void) => void,
): { body: HTMLElement } {
  closeNewRepoDialog();
  overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal new-repo-modal", role: "dialog", "aria-label": title });
  overlay.append(modal);
  document.body.append(overlay);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeNewRepoDialog();
  });

  const body = el("div", { class: "new-repo-body" });
  const error = el("div", { class: "new-repo-error", role: "alert" });
  const cancel = el("button", { class: "btn ghost", text: "Cancel" });
  cancel.addEventListener("click", closeNewRepoDialog);
  const ok = el("button", { class: "btn", text: submitLabel });
  const run = () => {
    let failed = false;
    submit((message) => {
      failed = true;
      error.textContent = message;
    });
    if (!failed) closeNewRepoDialog();
  };
  ok.addEventListener("click", run);
  modal.append(
    el("div", { class: "modal-title", text: title }),
    el("div", { class: "modal-sub", text: sub }),
    body,
    error,
    el("div", { class: "modal-actions" }, [cancel, ok]),
  );

  onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeNewRepoDialog();
    // Enter in a field submits; on a button it's that button's own click.
    else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) run();
  };
  document.addEventListener("keydown", onKey, true);
  return { body };
}

function textInput(placeholder: string, value = ""): HTMLInputElement {
  const input = el("input", { class: "new-repo-input", placeholder, spellcheck: "false" });
  input.value = value;
  return input;
}

// A labelled row. A div rather than a <label>, since a row can hold a Browse…
// button beside its field; the field is named with aria-label instead.
function field(label: string, ...controls: HTMLElement[]): HTMLElement {
  controls[0].setAttribute("aria-label", label);
  return el("div", { class: "new-repo-field" }, [
    el("span", { class: "new-repo-label", text: label }),
    el("span", { class: "new-repo-control" }, controls),
  ]);
}

// Browse… fills `input` from the native folder picker.
function browseButton(input: HTMLInputElement, title: string): HTMLElement {
  const btn = el("button", { class: "btn ghost", type: "button", text: "Browse…" });
  if (!isTauri()) {
    btn.setAttribute("disabled", "");
    btn.title = "The folder picker is only available in the desktop app.";
  }
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    const picked = await browseForFolder(title);
    if (picked) input.value = picked;
  });
  return btn;
}
