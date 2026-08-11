// Config editor: a table of entries with inline value editing and scope badges,
// plus a row to add a new key. Editing is only offered for Local/Global scopes.

import { clear, el } from "../dom";
import type { ConfigEntry, ConfigScope } from "../types";

const EDITABLE_SCOPES: ConfigScope[] = ["Local", "Global"];

export function renderConfig(
  host: HTMLElement,
  entries: ConfigEntry[],
  onSave: (scope: ConfigScope, name: string, value: string) => void,
): void {
  clear(host);

  const table = el("table", { class: "config-table" });
  const thead = el("tr", {}, []);
  thead.append(
    el("th", { text: "Key" }),
    el("th", { text: "Value" }),
    el("th", { text: "Scope" }),
    el("th", { text: "" }),
  );
  table.append(thead);

  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    table.append(renderRow(entry, onSave));
  }
  host.append(table);

  host.append(renderAddRow(onSave));
}

function renderRow(
  entry: ConfigEntry,
  onSave: (scope: ConfigScope, name: string, value: string) => void,
): HTMLElement {
  const tr = el("tr");
  tr.append(el("td", { class: "config-key", text: entry.name }));

  const editable = EDITABLE_SCOPES.includes(entry.scope);
  const valueCell = el("td");
  const input = el("input", {
    class: "config-value-input",
    value: entry.value,
  }) as HTMLInputElement;
  input.disabled = !editable;
  valueCell.append(input);
  tr.append(valueCell);

  tr.append(
    el("td", {}, [el("span", { class: `scope-badge scope-${entry.scope}`, text: entry.scope })]),
  );

  const actionCell = el("td");
  if (editable) {
    const saveBtn = el("button", { class: "btn small", text: "Save" });
    saveBtn.addEventListener("click", () => onSave(entry.scope, entry.name, input.value));
    actionCell.append(saveBtn);
  }
  tr.append(actionCell);
  return tr;
}

function renderAddRow(
  onSave: (scope: ConfigScope, name: string, value: string) => void,
): HTMLElement {
  const wrap = el("div", { class: "config-add" });

  const scopeSel = el("select") as HTMLSelectElement;
  for (const s of EDITABLE_SCOPES) scopeSel.append(el("option", { value: s, text: s }));

  const keyInput = el("input", {
    class: "key-input",
    placeholder: "section.key",
  }) as HTMLInputElement;
  const valInput = el("input", {
    class: "val-input",
    placeholder: "value",
  }) as HTMLInputElement;

  const addBtn = el("button", { class: "btn", text: "Add" });
  addBtn.addEventListener("click", () => {
    const name = keyInput.value.trim();
    if (!name) return;
    onSave(scopeSel.value as ConfigScope, name, valInput.value);
    keyInput.value = "";
    valInput.value = "";
  });

  wrap.append(scopeSel, keyInput, valInput, addBtn);
  return wrap;
}
