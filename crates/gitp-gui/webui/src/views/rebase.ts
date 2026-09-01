// Interactive-rebase editor: a modal listing the commits to be replayed
// (oldest at top, matching a git rebase todo). Each commit gets an action
// (pick / edit / reword / squash / fixup / drop), can be reordered by drag, by
// the arrow buttons, or with Alt+↑/↓, and — when selected — previews its file
// changes. "Rebase" hands the ordered plan plus the two option toggles (update
// dependent branches, backup branch) back to the caller.
//
// The action control is a coloured chip with a native <select> laid over it at
// zero opacity: closed it shows just "Squash" in the action's colour, so the
// sha and subject — the parts you actually scan down the list — keep the room;
// open it's the platform dropdown with the full one-line explanations, so
// keyboard and screen-reader behaviour stay native.
//
// Nothing here re-renders the whole modal. Changing an action repaints one row,
// selecting one moves a class and refetches the preview, and only a reorder
// rebuilds the list (keeping its scroll position). The previous version called
// clear(modal) on every interaction, so clicking one arrow in a 50-commit
// rebase rebuilt every row and re-rendered the diff preview.

import { fetchCommitDetail } from "../api";
import { clear, el, svg } from "../dom";
import type { CommitDetail, RebaseAction, RebaseCommit, RebaseStep } from "../types";
import { renderFile } from "./detail";

interface Row {
  commit: RebaseCommit;
  action: RebaseAction;
  message: string; // used only when action === "reword"
}

export interface RebaseOptions {
  updateRefs: boolean;
  backup: boolean;
}

// Action, the short name on the chip, the explanation shown in the open
// dropdown, and the single-key shortcut (matches the reference).
const ACTIONS: { value: RebaseAction; name: string; label: string; key: string }[] = [
  { value: "pick", name: "Pick", label: "Pick — use commit", key: "p" },
  { value: "edit", name: "Edit", label: "Edit — stop for amending", key: "e" },
  { value: "reword", name: "Reword", label: "Reword — edit the message", key: "r" },
  { value: "squash", name: "Squash", label: "Squash — meld into previous, keep both messages", key: "s" },
  { value: "fixup", name: "Fixup", label: "Fixup — meld into previous, discard message", key: "f" },
  { value: "drop", name: "Drop", label: "Drop — remove commit", key: "d" },
];
const KEY_TO_ACTION = new Map(ACTIONS.map((a) => [a.key, a.value]));
const ACTION_NAME = new Map(ACTIONS.map((a) => [a.value, a.name]));

// A rounded chevron for the move buttons; CSS rotates it for "up".
function chevron(): SVGElement {
  const s = svg("svg", { viewBox: "0 0 16 16", class: "rebase-move-icon" });
  s.append(
    svg("path", {
      d: "M4 6l4 4 4-4",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.8",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
  return s;
}

// The six-dot grip that marks a row as draggable.
function grip(): SVGElement {
  const s = svg("svg", { viewBox: "0 0 16 16", class: "rebase-grip-icon" });
  for (const [cx, cy] of [[6, 4], [10, 4], [6, 8], [10, 8], [6, 12], [10, 12]]) {
    s.append(svg("circle", { cx: String(cx), cy: String(cy), r: "1.15", fill: "currentColor" }));
  }
  return s;
}

let overlay: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;

export function closeRebaseModal(): void {
  overlay?.remove();
  overlay = null;
  if (onKey) document.removeEventListener("keydown", onKey, true);
  onKey = null;
}

export function openRebaseModal(
  onto: string,
  currentName: string,
  commits: RebaseCommit[],
  onRun: (steps: RebaseStep[], opts: RebaseOptions) => void,
): void {
  closeRebaseModal();
  const rows: Row[] = commits.map((commit) => ({ commit, action: "pick", message: commit.subject }));
  let selected = 0;
  let updateRefs = false;
  let backup = false;

  overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal rebase-modal" });
  overlay.append(modal);
  document.body.append(overlay);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeRebaseModal();
  });

  onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      closeRebaseModal();
      return;
    }
    // Typing a message must not be read as an action shortcut. A focused
    // <select> owns its own arrow keys, so leave those to it too.
    const target = e.target as HTMLElement;
    const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
    if (typing) return;

    // Alt+↑/↓ moves the selected commit, plain ↑/↓ moves the selection —
    // the whole plan can be built without leaving the keyboard.
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (target.tagName === "SELECT") return;
      const dir = e.key === "ArrowUp" ? -1 : 1;
      if (e.altKey) move(selected, dir);
      else select(selected + dir);
      e.preventDefault();
      return;
    }

    const action = KEY_TO_ACTION.get(e.key.toLowerCase());
    if (action && rows[selected]) {
      setAction(selected, action);
      e.preventDefault();
    }
  };
  document.addEventListener("keydown", onKey, true);

  // The first commit that isn't dropped can't be squash/fixup (nothing before).
  function firstApplied(): Row | undefined {
    return rows.find((r) => r.action !== "drop");
  }

  function planIsInvalid(): boolean {
    const first = firstApplied();
    return first?.action === "squash" || first?.action === "fixup";
  }

  // Lazily loaded commit detail for the changes preview, keyed by sha.
  const detailCache = new Map<string, CommitDetail>();

  // Long-lived pieces of the modal, built once by render() and updated in place.
  let list!: HTMLElement;
  let preview!: HTMLElement;
  let warn!: HTMLElement;
  let start!: HTMLButtonElement;
  // Row elements, index-aligned with `rows`, so a single row can be repainted.
  let rowEls: HTMLElement[] = [];
  // The row index a drag started from, or -1 when no drag is in progress.
  let dragFrom = -1;

  function render(): void {
    clear(modal);

    // Header: what's being rebased, onto what, and the update-refs toggle.
    const header = el("div", { class: "rebase-header" }, [
      el("span", { class: "rebase-onto" }, [
        el("span", { class: "rebase-branch", text: currentName }),
        el("span", { class: "rebase-onto-sep", text: "onto" }),
        el("span", { class: "rebase-target", text: onto }),
      ]),
      checkbox("Update dependent branches", updateRefs, (v) => (updateRefs = v)),
    ]);

    list = el("div", { class: "rebase-list" });
    renderList();

    preview = el("div", { class: "rebase-preview" });
    renderPreview(preview);

    warn = el("div", { class: "rebase-warn" });

    const backupBox = checkbox("Backup current state with temporary branch", backup, (v) => (backup = v));
    backupBox.classList.add("rebase-backup");

    const cancel = el("button", { class: "btn ghost", text: "Cancel" });
    cancel.addEventListener("click", closeRebaseModal);
    start = el("button", { class: "btn", text: "Rebase" }) as HTMLButtonElement;
    start.addEventListener("click", () => {
      const steps: RebaseStep[] = rows.map((r) => ({
        sha: r.commit.sha,
        action: r.action,
        message: r.action === "reword" ? r.message : null,
      }));
      closeRebaseModal();
      onRun(steps, { updateRefs, backup });
    });

    modal.append(
      header,
      el("div", { class: "rebase-hint", text: "Drag to reorder · Alt+↑/↓ to move · P E R S F D to set an action" }),
      list,
      preview,
      warn,
      el("div", { class: "modal-actions rebase-actions" }, [
        backupBox,
        el("span", { class: "spacer" }),
        cancel,
        start,
      ]),
    );
    refreshValidity();
  }

  // Rebuild the rows. Only a reorder needs this; the scroll position is kept so
  // moving a commit doesn't jump a long list back to the top.
  function renderList(): void {
    const scroll = list.scrollTop;
    clear(list);
    rowEls = rows.map((row, i) => {
      const node = renderRow(row, i);
      list.append(node);
      return node;
    });
    list.scrollTop = scroll;
  }

  // Repaint one row in place — used when its action changes, so the rest of the
  // list (and the preview) is left alone.
  function repaintRow(i: number): void {
    const fresh = renderRow(rows[i], i);
    rowEls[i].replaceWith(fresh);
    rowEls[i] = fresh;
  }

  function setAction(i: number, action: RebaseAction): void {
    if (rows[i].action === action) return;
    rows[i].action = action;
    repaintRow(i);
    refreshValidity();
  }

  function select(i: number): void {
    if (i < 0 || i >= rows.length || i === selected) return;
    const prev = selected;
    selected = i;
    rowEls[prev]?.classList.remove("selected");
    rowEls[selected]?.classList.add("selected");
    rowEls[selected]?.scrollIntoView({ block: "nearest" });
    clear(preview);
    renderPreview(preview);
  }

  // Move the row at `i` by `delta`, keeping it selected. Silently ignores a
  // move off either end, so the arrow buttons and Alt+↑/↓ share one guard.
  function move(i: number, delta: number): void {
    const to = i + delta;
    if (i < 0 || to < 0 || to >= rows.length) return;
    const [row] = rows.splice(i, 1);
    rows.splice(to, 0, row);
    selected = to;
    renderList();
    rowEls[to]?.scrollIntoView({ block: "nearest" });
    refreshValidity();
  }

  // Reordering or re-actioning can make the first applied commit a squash/fixup,
  // which git refuses — say so and block Rebase rather than letting it fail.
  function refreshValidity(): void {
    const invalid = planIsInvalid();
    warn.textContent = invalid ? "The first applied commit can't be Squash or Fixup." : "";
    start.disabled = invalid || rows.length === 0;
  }

  function renderRow(row: Row, i: number): HTMLElement {
    const wrap = el("div", {
      class: `rebase-row action-${row.action}${i === selected ? " selected" : ""}`,
      draggable: "true",
    });
    wrap.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, select, input")) return;
      select(i);
    });

    // --- drag to reorder ---
    // The list isn't rebuilt mid-drag (that would destroy the element being
    // dragged and cancel it); the hovered row just shows an insertion line and
    // the move happens on drop.
    wrap.addEventListener("dragstart", (e) => {
      dragFrom = i;
      wrap.classList.add("dragging");
      e.dataTransfer?.setData("text/plain", String(i));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    wrap.addEventListener("dragend", () => {
      dragFrom = -1;
      wrap.classList.remove("dragging");
      clearDropMarks();
    });
    wrap.addEventListener("dragover", (e) => {
      if (dragFrom < 0 || dragFrom === i) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const box = wrap.getBoundingClientRect();
      const below = e.clientY > box.top + box.height / 2;
      clearDropMarks();
      wrap.classList.add(below ? "drop-below" : "drop-above");
    });
    wrap.addEventListener("drop", (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      const box = wrap.getBoundingClientRect();
      const below = e.clientY > box.top + box.height / 2;
      // Removing the dragged row first shifts every later index down by one,
      // so an insert *after* row i lands at i, not i+1.
      let to = below ? i + 1 : i;
      if (dragFrom < to) to -= 1;
      const from = dragFrom;
      dragFrom = -1;
      clearDropMarks();
      if (to !== from) move(from, to - from);
    });

    const gripBtn = el("span", { class: "rebase-grip", title: "Drag to reorder" });
    gripBtn.append(grip());

    const up = el("button", {
      class: "rebase-move-btn up",
      title: "Move up (Alt+↑)",
      "aria-label": "Move up",
    }) as HTMLButtonElement;
    up.append(chevron());
    up.disabled = i === 0;
    up.addEventListener("click", () => move(i, -1));

    const down = el("button", {
      class: "rebase-move-btn",
      title: "Move down (Alt+↓)",
      "aria-label": "Move down",
    }) as HTMLButtonElement;
    down.append(chevron());
    down.disabled = i === rows.length - 1;
    down.addEventListener("click", () => move(i, 1));

    wrap.append(gripBtn, el("span", { class: "rebase-move" }, [up, down]), actionChip(row, i));

    wrap.append(el("span", { class: "rebase-sha", text: row.commit.short_sha }));

    // Reword shows an editable message; otherwise just the subject.
    if (row.action === "reword") {
      const inp = el("input", {
        class: "rebase-message",
        value: row.message,
        spellcheck: "false",
      }) as HTMLInputElement;
      inp.addEventListener("input", () => (row.message = inp.value));
      // Typing in the message shouldn't be interrupted by a drag starting.
      inp.addEventListener("mousedown", () => (wrap.draggable = false));
      inp.addEventListener("blur", () => (wrap.draggable = true));
      wrap.append(inp);
    } else {
      wrap.append(el("span", { class: "rebase-subject", text: row.commit.subject }));
    }
    return wrap;
  }

  function clearDropMarks(): void {
    for (const node of rowEls) node.classList.remove("drop-above", "drop-below");
  }

  // The action control: a coloured chip showing the short name, with the native
  // <select> laid over it invisibly so the platform dropdown (and its full
  // explanations, keyboard handling, and accessibility) is what actually opens.
  function actionChip(row: Row, i: number): HTMLElement {
    const chip = el("span", { class: `rebase-action-chip act-${row.action}` });
    chip.append(
      el("span", { class: "rebase-action-name", text: ACTION_NAME.get(row.action) ?? row.action }),
      chevron(),
    );

    const sel = el("select", {
      class: "rebase-action-select",
      "aria-label": `Action for ${row.commit.short_sha}`,
    }) as HTMLSelectElement;
    for (const a of ACTIONS) {
      const opt = el("option", { value: a.value, text: a.label }) as HTMLOptionElement;
      if (a.value === row.action) opt.selected = true;
      sel.append(opt);
    }
    sel.addEventListener("change", () => setAction(i, sel.value as RebaseAction));
    // A native dropdown can't open if the pointer starts a row drag instead.
    sel.addEventListener("mousedown", () => {
      const rowEl = chip.closest(".rebase-row") as HTMLElement | null;
      if (rowEl) rowEl.draggable = false;
    });
    sel.addEventListener("blur", () => {
      const rowEl = chip.closest(".rebase-row") as HTMLElement | null;
      if (rowEl) rowEl.draggable = true;
    });
    chip.append(sel);
    return chip;
  }

  // Show the selected commit's file changes. Fetches (and caches) on demand.
  function renderPreview(host: HTMLElement): void {
    const row = rows[selected];
    if (!row) return;
    host.append(
      el("div", { class: "rebase-preview-head", text: `Changes — ${row.commit.short_sha} ${row.commit.subject}` }),
    );
    const body = el("div", { class: "rebase-preview-body" });
    host.append(body);

    const cached = detailCache.get(row.commit.sha);
    if (cached) {
      renderFiles(body, cached);
      return;
    }
    body.append(el("div", { class: "rebase-preview-loading", text: "Loading changes…" }));
    void fetchCommitDetail(row.commit.sha)
      .then((detail) => {
        detailCache.set(row.commit.sha, detail);
        // Only paint if this row is still the selected one.
        if (rows[selected]?.commit.sha === row.commit.sha) {
          clear(body);
          renderFiles(body, detail);
        }
      })
      .catch(() => {
        clear(body);
        body.append(el("div", { class: "rebase-preview-loading", text: "Couldn't load changes." }));
      });
  }

  function renderFiles(host: HTMLElement, detail: CommitDetail): void {
    if (!detail.files.length) {
      host.append(el("div", { class: "rebase-preview-loading", text: "No file changes." }));
      return;
    }
    for (const file of detail.files) host.append(renderFile(file));
  }

  render();
}

// A small labelled checkbox that reports its state through `onChange`.
function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = el("input", { type: "checkbox" }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return el("label", { class: "rebase-check" }, [input, el("span", { text: label })]);
}
