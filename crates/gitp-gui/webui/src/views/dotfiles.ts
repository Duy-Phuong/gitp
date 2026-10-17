// The Settings "Dotfiles" panel: raw view + edit + save for the two fixed
// files a new-device setup needs — ~/.gitconfig and ~/.tigrc. Each is its own
// textarea with its own Save button; content is opaque text to this view (no
// git-config or tigrc parsing), so it works identically for either file.

import { el } from "../dom";
import { applyConfigTemplate, exportConfigTemplate, pickConfigTemplate } from "../template-api";
import type { DotfileKind } from "../types";

import "./dotfiles-template.css";

export interface DotfileEntry {
  kind: DotfileKind;
  path: string;
  content: string;
}

export interface DotfilesCallbacks {
  // Resolves true to proceed; the caller confirms before any overwrite.
  confirm: (message: string) => Promise<boolean>;
  save: (kind: DotfileKind, content: string) => Promise<void>;
  // Outcome reporting for the template buttons (toast + status line).
  reportDone: (message: string) => void;
  reportError: (title: string, err: unknown) => void;
  // Re-read both files after a template was applied so the textareas match disk.
  reload: () => Promise<void>;
}

export function renderDotfiles(host: HTMLElement, files: DotfileEntry[], cb: DotfilesCallbacks): void {
  host.replaceChildren();
  const wrap = el("div", { class: "dotfiles" });
  wrap.append(renderTemplateBar(files, cb));
  for (const file of files) wrap.append(renderPanel(file, cb));
  host.append(wrap);
}

// Export both files as one JSON template, or apply such a template from
// another machine. The native save/open dialogs live in template-api.
function renderTemplateBar(files: DotfileEntry[], cb: DotfilesCallbacks): HTMLElement {
  const exportBtn = el("button", { class: "btn small", text: "Export template…" }) as HTMLButtonElement;
  const applyBtn = el("button", { class: "btn small", text: "Apply template…" }) as HTMLButtonElement;
  const setBusy = (busy: boolean) => {
    exportBtn.disabled = busy;
    applyBtn.disabled = busy;
  };

  exportBtn.addEventListener("click", () => {
    void (async () => {
      setBusy(true);
      try {
        const dest = await exportConfigTemplate();
        if (dest) cb.reportDone(`Exported template to ${dest}`);
      } catch (err) {
        cb.reportError("Failed to export template", err);
      } finally {
        setBusy(false);
      }
    })();
  });

  applyBtn.addEventListener("click", () => {
    void (async () => {
      setBusy(true);
      try {
        const src = await pickConfigTemplate();
        if (!src) return;
        const targets = files.map((f) => `  ${f.path}`).join("\n");
        const ok = await cb.confirm(
          `Apply template ${src}?\n\nEach file it contains will overwrite:\n${targets}\n\n` +
            "Existing files are backed up next to themselves as .bak-<timestamp> first.",
        );
        if (!ok) return;
        const result = await applyConfigTemplate(src);
        await cb.reload();
        cb.reportDone(summariseApply(result));
      } catch (err) {
        cb.reportError("Failed to apply template", err);
      } finally {
        setBusy(false);
      }
    })();
  });

  return el("div", { class: "dotfile-template-bar" }, [
    exportBtn,
    applyBtn,
    el("span", { class: "dotfile-template-hint" }, [
      "A template holds both files; apply it on another machine to set it up.",
    ]),
  ]);
}

// Multi-line on purpose: reportDone offers a details view for messages with
// newlines, which is where the backup paths belong.
export function summariseApply(result: { written: string[]; backups: string[] }): string {
  if (result.written.length === 0) return "Template applied — it contained no files to write.";
  const lines = [`Applied template: wrote ${result.written.length} file(s).`, ...result.written.map((p) => `  ${p}`)];
  if (result.backups.length > 0) lines.push("Backed up:", ...result.backups.map((p) => `  ${p}`));
  return lines.join("\n");
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
