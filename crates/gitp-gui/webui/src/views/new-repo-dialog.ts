// The dialogs that make a repository that isn't open yet: Init Repository and
// Clone Repository.
//
// Each only collects what the user wants and hands it to `onSubmit`; the
// git work, its progress and its errors belong to the caller, like every
// other action. Reuses the `.modal-overlay` / `.modal` shell.

import { browseForFolder, isTauri } from "../api";
import { el } from "../dom";
import { GITIGNORE_TEMPLATES } from "../gitignore-templates";
import type { CloneOptions } from "../types";

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

export interface CloneRequest {
  url: string;
  /// The new repository's folder: the chosen parent plus the folder name.
  dest: string;
  options: CloneOptions;
}

/// The folder name a clone of `url` gets by default — git's own choice: the
/// last path segment, without `.git`. Works for scp-style `host:owner/repo`
/// too. Empty when the URL has nothing usable yet.
export function repoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[/\\]+$/, "").replace(/\.git$/i, "");
  return trimmed.split(/[/\\:]/).pop() ?? "";
}

/// `defaultParent`: the folder the clone goes in, to start with.
export function openCloneDialog(defaultParent: string, onSubmit: (req: CloneRequest) => void): void {
  const url = textInput("https://github.com/owner/repo.git");
  const parent = textInput("/path/to/parent-folder", defaultParent);
  const name = textInput("folder name");
  const target = el("div", { class: "new-repo-target" });
  const joined = () => {
    const base = parent.value.trim().replace(/\/+$/, "");
    return name.value.trim() ? `${base}/${name.value.trim()}` : "";
  };
  const showTarget = () => (target.textContent = joined() ? `Clones into ${joined()}` : "");
  // The name follows the URL until it's edited by hand.
  let nameEdited = false;
  url.addEventListener("input", () => {
    if (!nameEdited) name.value = repoNameFromUrl(url.value);
    showTarget();
  });
  name.addEventListener("input", () => {
    nameEdited = name.value.trim() !== "";
    showTarget();
  });
  parent.addEventListener("input", showTarget);

  // The extras most clones never need, folded away.
  const branch = textInput("remote's default");
  const singleBranch = el("input", { type: "checkbox" });
  const depth = el("input", { class: "new-repo-input", type: "number", min: 1, placeholder: "full history" });
  const submodules = el("input", { type: "checkbox" });
  const options = el("details", { class: "new-repo-options" }, [
    el("summary", { text: "Options" }),
    el("div", { class: "new-repo-body" }, [
      field("Branch", branch),
      el("label", { class: "fetch-check new-repo-check" }, [singleBranch, el("span", { text: "Only this branch (--single-branch)" })]),
      field("Depth", depth),
      el("label", { class: "fetch-check new-repo-check" }, [submodules, el("span", { text: "Initialize submodules" })]),
    ]),
  ]);

  const modal = openShell("Clone a Repository", "Copy a remote repository to this computer.", "Clone", (fail) => {
    const u = url.value.trim();
    if (!u) return fail("Enter the URL of the repository to clone.");
    // git would read it as an option; the backend refuses it too.
    if (u.startsWith("-")) return fail("That isn't a repository URL.");
    if (!parent.value.trim()) return fail("Choose the folder to clone into.");
    if (!name.value.trim()) return fail("Enter a name for the new folder.");
    const b = branch.value.trim();
    if (b.startsWith("-")) return fail("That isn't a branch name.");
    const d = depth.value.trim();
    if (d && !/^[1-9]\d*$/.test(d)) return fail("Depth is a number of commits, 1 or more.");
    onSubmit({
      url: u,
      dest: joined(),
      options: {
        branch: b || null,
        single_branch: singleBranch.checked,
        depth: d ? Number(d) : null,
        recurse_submodules: submodules.checked,
      },
    });
  });
  modal.body.append(
    field("URL", url),
    field("Where to clone", parent, browseButton(parent, "Folder to Clone Into", showTarget)),
    field("Folder name", name),
    target,
    options,
  );
  requestAnimationFrame(() => url.focus());
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
    // Enter in a field submits; on a button (or the Options toggle) it's that
    // control's own click.
    else if (e.key === "Enter" && !(e.target instanceof HTMLElement && e.target.matches("button, summary"))) run();
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

// Browse… fills `input` from the native folder picker, then calls `onPick`.
function browseButton(input: HTMLInputElement, title: string, onPick?: () => void): HTMLElement {
  const btn = el("button", { class: "btn ghost", type: "button", text: "Browse…" });
  if (!isTauri()) {
    btn.setAttribute("disabled", "");
    btn.title = "The folder picker is only available in the desktop app.";
  }
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    const picked = await browseForFolder(title);
    if (!picked) return;
    input.value = picked;
    onPick?.();
  });
  return btn;
}
