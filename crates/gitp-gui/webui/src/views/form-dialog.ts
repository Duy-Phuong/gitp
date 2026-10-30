// A small modal for the actions that need more than the context menu's single
// inline input: a tag name plus an optional annotation, a remote's name plus
// its URL. Labelled rows, then Cancel / the action. Reuses the rename modal's
// look (`.rename-row` etc.).
//
// Enter submits from a one-line field; a multi-line field takes Enter as a
// newline, so there it's Cmd/Ctrl+Enter. Escape or a backdrop click cancels.

import { el } from "../dom";

export interface FormField {
  label: string;
  value?: string;
  placeholder?: string;
  multiline?: boolean;
  // Must be non-empty to submit; the empty one gets focus instead.
  required?: boolean;
}

export interface FormOptions {
  title: string;
  sub?: string;
  fields: FormField[];
  submitLabel: string;
}

// `onSubmit` gets each field's value, trimmed, in `fields` order.
export function openFormDialog(opts: FormOptions, onSubmit: (values: string[]) => void): void {
  const overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal rename-modal" });
  overlay.append(modal);

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const inputs = opts.fields.map((f) => {
    const input = el(f.multiline ? "textarea" : "input", {
      class: "rename-input",
      placeholder: f.placeholder ?? "",
      spellcheck: "false",
    }) as HTMLInputElement | HTMLTextAreaElement;
    input.value = f.value ?? "";
    return input;
  });
  const submit = () => {
    const values = inputs.map((i) => i.value.trim());
    const missing = opts.fields.findIndex((f, i) => f.required && !values[i]);
    if (missing !== -1) {
      inputs[missing].focus();
      return;
    }
    close();
    onSubmit(values);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey, true);

  modal.append(el("div", { class: "modal-title", text: opts.title }));
  if (opts.sub) modal.append(el("div", { class: "modal-sub", text: opts.sub }));
  opts.fields.forEach((f, i) => {
    const input = inputs[i];
    input.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== "Enter") return;
      if (!f.multiline || ke.metaKey || ke.ctrlKey) {
        ke.preventDefault();
        submit();
      }
    });
    modal.append(
      el("div", { class: `rename-row${f.multiline ? " multiline" : ""}` }, [
        el("span", { class: "rename-label", text: f.label }),
        input,
      ]),
    );
  });

  const cancel = el("button", { class: "btn ghost", text: "Cancel" });
  cancel.addEventListener("click", close);
  const ok = el("button", { class: "btn", text: opts.submitLabel });
  ok.addEventListener("click", submit);
  modal.append(el("div", { class: "modal-actions" }, [el("span", { class: "spacer" }), cancel, ok]));

  document.body.append(overlay);
  requestAnimationFrame(() => {
    // The first field still to fill in, or the first one.
    const first = inputs.find((i) => !i.value) ?? inputs[0];
    first?.focus();
    first?.select();
  });
}
