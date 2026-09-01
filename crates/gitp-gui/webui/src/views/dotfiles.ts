// The Settings "Dotfiles" panel: raw view + edit + save for the two fixed
// files a new-device setup needs — ~/.gitconfig and ~/.tigrc. Each is its own
// textarea with its own Save button; content is opaque text to this view (no
// git-config or tigrc parsing), so it works identically for either file.

import { el } from "../dom";
import type { DotfileKind } from "../types";

export interface DotfileEntry {
  kind: DotfileKind;
  path: string;
  content: string;
}

export interface DotfilesCallbacks {
  // Resolves true to proceed; the caller confirms before any overwrite.
  confirm: (message: string) => Promise<boolean>;
  save: (kind: DotfileKind, content: string) => Promise<void>;
}

export function renderDotfiles(host: HTMLElement, files: DotfileEntry[], cb: DotfilesCallbacks): void {
  host.replaceChildren();
  const wrap = el("div", { class: "dotfiles" });
  for (const file of files) wrap.append(renderPanel(file, cb));
  host.append(wrap);
}

function renderPanel(file: DotfileEntry, cb: DotfilesCallbacks): HTMLElement {
  const panel = el("div", { class: "dotfile-panel" });
  panel.append(el("div", { class: "dotfile-path" }, [file.path]));

  const textarea = el("textarea", {
    class: "dotfile-textarea",
    spellcheck: "false",
    placeholder: `${file.path} doesn't exist yet — Save will create it.`,
  }) as HTMLTextAreaElement;
  textarea.value = file.content;

  const status = el("span", { class: "dotfile-status" });
  const saveBtn = el("button", { class: "btn small", text: "Save" }) as HTMLButtonElement;
  saveBtn.addEventListener("click", () => {
    void (async () => {
      const ok = await cb.confirm(`Overwrite ${file.path} with this content?`);
      if (!ok) return;
      saveBtn.disabled = true;
      status.textContent = "Saving…";
      try {
        await cb.save(file.kind, textarea.value);
        status.textContent = "Saved.";
      } catch (err) {
        status.textContent = `Failed: ${String(err)}`;
      } finally {
        saveBtn.disabled = false;
      }
    })();
  });

  panel.append(textarea, el("div", { class: "dotfile-actions" }, [saveBtn, status]));
  return panel;
}
