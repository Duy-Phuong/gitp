// The in-app file editor: a working-tree file in a plain <textarea>, with
// Save, Save and Stage, and Close. Cmd/Ctrl+S saves; a dot by the name marks
// unsaved edits, and closing with some asks Save / Don't Save / Cancel. Save
// asks before overwriting a file changed on disk since it was opened. A
// Markdown file can be previewed (see markdown-preview.ts).
//
// The backend hands the text over with "\n" line breaks — what a textarea
// keeps anyway — and writes it back with the file's own (CRLF or LF), so a
// file only changes where it was edited.

import { el } from "../dom";
import type { TextFile } from "../types";
import { askChoice } from "./choice-dialog";
import { renderMarkdown } from "./markdown-preview";

export interface FileEditorDeps {
  read: (path: string) => Promise<TextFile | null>;
  write: (path: string, text: string, crlf: boolean) => Promise<void>;
  stage: (path: string) => Promise<void>;
  // After a save (and stage) — refresh what shows the file's status.
  onSaved: (message: string) => void;
  reportError: (title: string, detail: string) => void;
}

// One editor at a time: a second one would sit under the first's backdrop.
let isOpen = false;

export async function openFileEditor(path: string, deps: FileEditorDeps): Promise<void> {
  if (isOpen) return;
  let file: TextFile | null;
  try {
    file = await deps.read(path);
  } catch (err) {
    deps.reportError(`Can't edit ${path}`, String(err));
    return;
  }
  if (!file) {
    deps.reportError(`Can't edit ${path}`, `${path} doesn't exist in the working tree.`);
    return;
  }
  if (isOpen) return; // opened again while this one was reading
  isOpen = true;
  let { crlf } = file;
  let saved = file.text;
  // The file's text as last read from or written to disk. Save compares the
  // disk with it, so an edit made meanwhile elsewhere (another editor, a
  // checkout) isn't overwritten without asking.
  let onDisk = file.text;
  let saving = false;
  // Set while the Save / Don't Save / Cancel question is up.
  let asking = false;

  const overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal file-editor" });
  overlay.append(modal);

  const text = el("textarea", {
    class: "file-editor-text",
    spellcheck: "false",
    autocapitalize: "none",
    autocorrect: "off",
    autocomplete: "off",
    wrap: "off",
  });
  text.value = saved;
  const preview = el("div", { class: "file-editor-preview hidden" });

  const dirtyDot = el("span", { class: "file-editor-dirty", text: "●", title: "Unsaved changes" });
  const notes: HTMLElement[] = [];
  if (crlf) {
    notes.push(
      el("span", {
        class: "file-editor-badge",
        text: "CRLF",
        title: "Saved with Windows (CRLF) line breaks, as the file has them.",
      }),
    );
  }
  if (file.mixed) {
    notes.push(
      el("span", {
        class: "file-editor-badge warn",
        text: "Mixed line breaks",
        title: `The file mixes line break kinds; saving makes them all ${crlf ? "CRLF" : "LF"}.`,
      }),
    );
  }
  const head = el("div", { class: "file-editor-head" }, [
    el("span", { class: "modal-title file-editor-path", text: path }),
    dirtyDot,
    ...notes,
  ]);
  if (/\.(md|markdown)$/i.test(path)) {
    const toggle = el("button", { class: "btn ghost small", text: "Preview" });
    toggle.addEventListener("click", () => {
      const showing = preview.classList.toggle("hidden") === false;
      text.classList.toggle("hidden", showing);
      toggle.textContent = showing ? "Edit" : "Preview";
      toggle.classList.toggle("active", showing);
      if (showing) preview.replaceChildren(renderMarkdown(text.value));
      else text.focus();
    });
    head.append(el("span", { class: "spacer" }), toggle);
  }

  const closeBtn = el("button", { class: "btn ghost", text: "Close" });
  const stageBtn = el("button", { class: "btn ghost", text: "Save and Stage" });
  const saveBtn = el("button", { class: "btn", text: "Save" });
  modal.append(
    head,
    text,
    preview,
    el("div", { class: "modal-actions" }, [el("span", { class: "spacer" }), closeBtn, stageBtn, saveBtn]),
  );

  const dirty = () => text.value !== saved;
  const paint = () => {
    dirtyDot.classList.toggle("hidden", !dirty());
    saveBtn.disabled = saving || !dirty();
    stageBtn.disabled = saving;
  };

  // Whether the text was written. A stage that fails after it still counts:
  // the file is saved, and Local Changes is refreshed to show it.
  async function save(andStage: boolean): Promise<boolean> {
    if (saving) return false;
    saving = true;
    paint();
    const content = text.value;
    try {
      if (!(await mayWrite())) return false;
      await deps.write(path, content, crlf);
    } catch (err) {
      deps.reportError("Save failed", String(err));
      return false;
    } finally {
      saving = false;
      paint();
    }
    saved = content;
    onDisk = content;
    paint();
    let message = `Saved ${path}.`;
    if (andStage) {
      try {
        await deps.stage(path);
        message = `Saved and staged ${path}.`;
      } catch (err) {
        deps.reportError("Stage failed", String(err));
      }
    }
    deps.onSaved(message);
    return true;
  }

  // Whether Save may write: yes while the disk still holds what this editor
  // last read or wrote, else the user decides. Reload takes the disk's text
  // instead (dropping the edits here) and doesn't save.
  async function mayWrite(): Promise<boolean> {
    const now = await deps.read(path);
    if (now?.text === onDisk) return true;
    asking = true;
    const answer = await askChoice<"overwrite" | "reload" | "cancel">(
      now ? `${path} changed on disk` : `${path} was deleted`,
      now
        ? "It was changed outside this editor since you opened it. Overwrite it with your version, or reload it and drop your edits here?"
        : "It was deleted outside this editor since you opened it. Save it again from your version?",
      [
        ...(now ? [{ label: "Reload", answer: "reload" as const, left: true }] : []),
        { label: "Cancel", answer: "cancel" },
        { label: now ? "Overwrite" : "Save", answer: "overwrite", primary: true },
      ],
      "cancel",
      "file-editor-ask",
    );
    asking = false;
    if (answer === "reload" && now) {
      text.value = saved = onDisk = now.text;
      crlf = now.crlf;
    }
    if (answer !== "overwrite") text.focus();
    return answer === "overwrite";
  }

  function close(): void {
    isOpen = false;
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  }

  async function requestClose(): Promise<void> {
    if (saving || asking) return;
    if (dirty()) {
      asking = true;
      const answer = await askSave(path);
      asking = false;
      if (answer === "cancel") return text.focus();
      if (answer === "save" && !(await save(false))) return;
    }
    close();
  }

  const onKey = (e: KeyboardEvent) => {
    // Another dialog on top (the Save question, an error) takes the keys.
    const overlays = document.querySelectorAll(".modal-overlay");
    if (overlays[overlays.length - 1] !== overlay) return;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      if (dirty()) void save(false);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      void requestClose();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      // Not Quick Launch: it could switch the repository under the open file,
      // and Save would then write into the other one.
      e.stopPropagation();
    }
  };
  document.addEventListener("keydown", onKey, true);
  // A textarea moves focus on Tab; in an editor it's an indent. execCommand
  // keeps it on the textarea's own undo stack, which setRangeText wouldn't.
  text.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    if (!document.execCommand("insertText", false, "\t")) {
      text.setRangeText("\t", text.selectionStart, text.selectionEnd, "end");
    }
    paint();
  });
  text.addEventListener("input", paint);
  closeBtn.addEventListener("click", () => void requestClose());
  saveBtn.addEventListener("click", () => void save(false));
  stageBtn.addEventListener("click", () => void save(true));

  paint();
  document.body.append(overlay);
  requestAnimationFrame(() => {
    text.focus();
    text.setSelectionRange(0, 0);
  });
}

// Save / Don't Save / Cancel for closing with unsaved edits. Escape or a
// backdrop click cancels; Save has focus, so Enter saves.
function askSave(path: string): Promise<"save" | "discard" | "cancel"> {
  return askChoice<"save" | "discard" | "cancel">(
    `Save changes to ${path}?`,
    "Your changes are lost if you don't save them.",
    [
      { label: "Don't Save", answer: "discard", left: true },
      { label: "Cancel", answer: "cancel" },
      { label: "Save", answer: "save", primary: true },
    ],
    "cancel",
    "file-editor-ask",
  );
}
