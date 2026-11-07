// Interactive-rebase editor: a modal listing the commits to be replayed
// (oldest at top, matching a git rebase todo). Each commit gets an action
// (pick / edit / reword / squash / fixup / drop), can be reordered by drag, by
// the arrow buttons, or with Alt+↑/↓, and — when focused — previews its file
// changes. "Rebase" hands the ordered plan plus the two option toggles (update
// dependent branches, backup branch) back to the caller.
//
// Several rows can be selected (Shift/⌘-click, Shift+↑/↓, ⌘A): an action key
// or a chip sets them all, Alt+↑/↓ moves them together, and "Squash into one"
// gathers them into one commit. The plan shows what it produces — each
// squash/fixup names the commit it melds into, the header counts "9 commits →
// 5", and a group with a squash has an editable combined message. Autosquash
// moves "fixup! X" commits under X. Every edit can be undone and redone.
//
// The action control is a coloured chip with a native <select> laid over it at
// zero opacity: closed it shows just "Squash" in the action's colour, so the
// sha and subject — the parts you actually scan down the list — keep the room;
// open it's the platform dropdown with the full one-line explanations, so
// keyboard and screen-reader behaviour stay native.
//
// The same editor plans an interactive multi-commit cherry-pick
// (openCherryPickModal): the selected commits onto HEAD, with only the actions
// that make sense there (pick / reword / squash / drop) and no branch options.
//
// The modal itself is built once. An edit rebuilds the list (keeping its
// scroll) and the combined-message box; the file preview is redrawn only when
// the focused commit changes.

import { fetchCommitDetail } from "../api";
import { clear, el, svg } from "../dom";
import {
  autosquash,
  autosquashCount,
  defaultGroupMessage,
  groupHead,
  groups,
  moveRows,
  planProblem,
  planSteps,
  planSummary,
  squashIntoOne,
  type PlanRow,
} from "../rebase-plan";
import type { CommitDetail, RebaseAction, RebaseCommit, RebaseStep } from "../types";
import { renderFile } from "./detail";

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
const ACTION_NAME = new Map(ACTIONS.map((a) => [a.value, a.name]));
// What each step of a cherry-pick plan can do: no edit stop (there's no
// rebase to pause) and no fixup.
const CHERRY_PICK_ACTIONS: RebaseAction[] = ["pick", "reword", "squash", "drop"];

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

// Plan a cherry-pick of `commits` (oldest first) onto `currentName`.
export function openCherryPickModal(
  currentName: string,
  commits: RebaseCommit[],
  onRun: (steps: RebaseStep[]) => void,
): void {
  openRebaseModal("", currentName, commits, (steps) => onRun(steps), true);
}

// A plan as undo and redo keep it.
interface Snapshot {
  rows: PlanRow[];
  groupMessages: Map<string, string>;
}

export function openRebaseModal(
  onto: string,
  currentName: string,
  commits: RebaseCommit[],
  onRun: (steps: RebaseStep[], opts: RebaseOptions) => void,
  cherryPick = false,
): void {
  closeRebaseModal();
  const actions = cherryPick ? ACTIONS.filter((a) => CHERRY_PICK_ACTIONS.includes(a.value)) : ACTIONS;
  const keyToAction = new Map(actions.map((a) => [a.key, a.value]));
  const initialRows = (): PlanRow[] =>
    commits.map((commit) => ({ commit, action: "pick", message: commit.subject, loaded: false }));
  let rows = initialRows();
  // A squash group's edited message, by its head commit's sha.
  let groupMessages = new Map<string, string>();
  // The selected rows, and the one the keys and the preview follow.
  let selected = new Set<number>([0]);
  let focus = 0;
  let anchor = 0;
  let updateRefs = false;
  let backup = false;
  const undoStack: Snapshot[] = [];
  const redoStack: Snapshot[] = [];

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
    // Typing a message must not be read as an action shortcut, and a text
    // field keeps its own ⌘Z. A focused <select> owns its arrow keys too.
    const target = e.target as HTMLElement;
    const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
    if (typing) return;
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === "z") {
      if (e.shiftKey) redo();
      else undo();
      e.preventDefault();
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      redo();
      e.preventDefault();
      return;
    }
    if (mod && e.key.toLowerCase() === "a") {
      selected = new Set(rows.map((_, i) => i));
      paintSelection();
      e.preventDefault();
      return;
    }

    // Alt+↑/↓ moves the selected commits, Shift+↑/↓ widens the selection,
    // plain ↑/↓ moves it — the whole plan can be built from the keyboard.
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (target.tagName === "SELECT") return;
      const dir = e.key === "ArrowUp" ? -1 : 1;
      if (e.altKey) moveSelected(dir);
      else if (e.shiftKey) extendTo(focus + dir);
      else selectOnly(focus + dir);
      e.preventDefault();
      return;
    }

    if (mod || e.altKey) return;
    const action = keyToAction.get(e.key.toLowerCase());
    if (action && rows[focus]) {
      setActions(action);
      e.preventDefault();
    }
  };
  document.addEventListener("keydown", onKey, true);

  // Lazily loaded commit detail for the preview and the full messages.
  const detailCache = new Map<string, CommitDetail>();
  function loadDetail(sha: string): Promise<CommitDetail> {
    const cached = detailCache.get(sha);
    if (cached) return Promise.resolve(cached);
    return fetchCommitDetail(sha).then((d) => {
      detailCache.set(sha, d);
      return d;
    });
  }
  // Fill a row's full message (subject and body) from its commit, once.
  function loadMessage(row: PlanRow): Promise<void> {
    if (row.loaded) return Promise.resolve();
    return loadDetail(row.commit.sha).then(
      (d) => {
        if (row.loaded) return;
        // A reword typed before the message arrived keeps what was typed.
        if (row.message === row.commit.subject) row.message = d.message.trimEnd();
        row.loaded = true;
      },
      () => {},
    );
  }

  // Long-lived pieces of the modal, built once by render() and updated in place.
  let list!: HTMLElement;
  let toolbar!: HTMLElement;
  let summary!: HTMLElement;
  let groupBox!: HTMLElement;
  let files!: HTMLElement;
  let warn!: HTMLElement;
  let start!: HTMLButtonElement;
  let rowEls: HTMLElement[] = [];
  // The row index a drag started from, or -1 when no drag is in progress.
  let dragFrom = -1;
  // The commit the file preview shows, so a redraw keeps it when it's the same.
  let previewSha = "";

  // --- undo / redo ----------------------------------------------------------

  const snapshot = (): Snapshot => ({
    rows: rows.map((r) => ({ ...r })),
    groupMessages: new Map(groupMessages),
  });
  // Call before every edit: the plan as it was goes on the undo stack.
  function record(): void {
    undoStack.push(snapshot());
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }
  function restore(s: Snapshot): void {
    rows = s.rows;
    groupMessages = s.groupMessages;
    focus = Math.min(focus, rows.length - 1);
    selected = new Set([focus]);
    anchor = focus;
    refresh();
  }
  function undo(): void {
    const s = undoStack.pop();
    if (!s) return;
    redoStack.push(snapshot());
    restore(s);
  }
  function redo(): void {
    const s = redoStack.pop();
    if (!s) return;
    undoStack.push(snapshot());
    restore(s);
  }

  // --- building -------------------------------------------------------------

  function render(): void {
    clear(modal);

    // Header: what's being rebased, onto what, what the plan produces, and the
    // update-refs toggle — or, for a cherry-pick, how many commits land.
    summary = el("span", { class: "rebase-summary" });
    const header = el("div", { class: "rebase-header" }, [
      el("span", { class: "rebase-onto" }, [
        el("span", { class: "rebase-branch", text: cherryPick ? `${commits.length} commits` : currentName }),
        el("span", { class: "rebase-onto-sep", text: "onto" }),
        el("span", { class: "rebase-target", text: cherryPick ? currentName : onto }),
      ]),
      summary,
      ...(cherryPick ? [] : [checkbox("Update dependent branches", updateRefs, (v) => (updateRefs = v))]),
    ]);

    toolbar = el("div", { class: "rebase-toolbar" });
    list = el("div", { class: "rebase-list" });
    groupBox = el("div", { class: "rebase-group" });
    files = el("div", { class: "rebase-preview-files" });
    const preview = el("div", { class: "rebase-preview" }, [groupBox, files]);
    warn = el("div", { class: "rebase-warn" });

    const backupBox = checkbox("Backup current state with temporary branch", backup, (v) => (backup = v));
    backupBox.classList.add("rebase-backup");

    // Back to the order the editor opened with, every commit picked.
    const reset = el("button", { class: "btn ghost", text: "Reset" });
    reset.addEventListener("click", () => {
      record();
      rows = initialRows();
      groupMessages = new Map();
      focus = 0;
      anchor = 0;
      selected = new Set([0]);
      refresh();
    });
    const cancel = el("button", { class: "btn ghost", text: "Cancel" });
    cancel.addEventListener("click", closeRebaseModal);
    start = el("button", { class: "btn", text: cherryPick ? "Cherry-pick" : "Rebase" });
    start.addEventListener("click", () => {
      const steps = planSteps(rows, groupMessages);
      closeRebaseModal();
      onRun(steps, { updateRefs, backup });
    });

    const keys = actions.map((a) => a.key.toUpperCase()).join(" ");
    modal.append(
      header,
      el("div", {
        class: "rebase-hint",
        text: `Shift/⌘-click to select several · drag or Alt+↑/↓ to move · ${keys} to set an action · ⌘Z / ⇧⌘Z to undo / redo`,
      }),
      toolbar,
      list,
      preview,
      warn,
      el("div", { class: "modal-actions rebase-actions" }, [
        ...(cherryPick ? [] : [backupBox]),
        el("span", { class: "spacer" }),
        reset,
        cancel,
        start,
      ]),
    );
    refresh();
  }

  // Redraw what depends on the plan: the list (keeping its scroll), the
  // toolbar, the summary, the combined message, the warning — and the file
  // preview only when the focused commit changed.
  function refresh(): void {
    const scroll = list.scrollTop;
    clear(list);
    const heads = groups(rows);
    rowEls = rows.map((row, i) => {
      const node = renderRow(row, i, heads);
      list.append(node);
      return node;
    });
    list.scrollTop = scroll;
    renderToolbar();
    renderSummary();
    renderGroupBox();
    const sha = rows[focus]?.commit.sha ?? "";
    if (sha !== previewSha) {
      previewSha = sha;
      renderFiles();
    }
    refreshValidity();
  }

  function renderToolbar(): void {
    clear(toolbar);
    const btn = (label: string, title: string, onClick: () => void, disabled: boolean) => {
      const b = el("button", { class: "btn ghost small", text: label, title });
      b.disabled = disabled;
      b.addEventListener("click", onClick);
      return b;
    };
    const many = selected.size >= 2;
    toolbar.append(
      btn(
        many ? `Squash ${selected.size} into one` : "Squash into one",
        "Gather the selected commits under the first of them and squash the rest into it",
        () => {
          const out = squashIntoOne(rows, selected);
          if (!out) return;
          record();
          rows = out.rows;
          selected = out.selected;
          focus = Math.min(...out.selected);
          anchor = focus;
          refresh();
        },
        !many,
      ),
    );
    const n = autosquashCount(rows);
    if (n) {
      toolbar.append(
        btn(
          `Autosquash (${n})`,
          'Move each "fixup! X" / "squash! X" commit under X and meld it in, like git rebase --autosquash',
          () => {
            const out = autosquash(rows);
            if (!out) return;
            record();
            rows = out;
            selected = new Set([focus]);
            refresh();
          },
          false,
        ),
      );
    }
    toolbar.append(
      el("span", { class: "spacer" }),
      btn("↶ Undo", "Undo the last change to the plan (⌘Z)", undo, !undoStack.length),
      btn("↷ Redo", "Redo it (⇧⌘Z)", redo, !redoStack.length),
    );
  }

  function renderSummary(): void {
    const s = planSummary(rows);
    const extra = [s.melded ? `${s.melded} melded` : "", s.dropped ? `${s.dropped} dropped` : ""].filter(Boolean);
    summary.textContent = `${s.before} commit${s.before === 1 ? "" : "s"} → ${s.after}${extra.length ? ` · ${extra.join(" · ")}` : ""}`;
    summary.title = "How many commits the plan replays, and how many it produces";
  }

  // Reordering or re-actioning can make the first applied commit a squash/fixup,
  // which git refuses, and a message can be emptied — say so and block the run.
  function refreshValidity(): void {
    const problem = planProblem(rows, groupMessages, cherryPick ? "Squash" : "Squash or Fixup");
    warn.textContent = problem ?? "";
    start.disabled = problem !== null || rows.length === 0;
  }

  // --- selection ------------------------------------------------------------

  function paintSelection(): void {
    rowEls.forEach((node, i) => {
      node.classList.toggle("selected", selected.has(i));
      node.classList.toggle("focused", i === focus);
    });
    renderToolbar();
    renderGroupBox();
    const sha = rows[focus]?.commit.sha ?? "";
    if (sha !== previewSha) {
      previewSha = sha;
      renderFiles();
    }
  }
  function selectOnly(i: number): void {
    if (i < 0 || i >= rows.length) return;
    focus = i;
    anchor = i;
    selected = new Set([i]);
    paintSelection();
    rowEls[i]?.scrollIntoView({ block: "nearest" });
  }
  function extendTo(i: number): void {
    if (i < 0 || i >= rows.length) return;
    focus = i;
    selected = new Set();
    for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) selected.add(k);
    paintSelection();
    rowEls[i]?.scrollIntoView({ block: "nearest" });
  }
  function toggle(i: number): void {
    if (selected.has(i) && selected.size > 1) selected.delete(i);
    else selected.add(i);
    focus = i;
    anchor = i;
    paintSelection();
  }

  // --- edits ----------------------------------------------------------------

  // Set `action` on every selected row (or only row `i`, when it isn't one of
  // them, as a chip of an unselected row does).
  function setActions(action: RebaseAction, i = focus): void {
    const targets = selected.has(i) ? [...selected] : [i];
    if (targets.every((k) => rows[k].action === action)) return;
    record();
    for (const k of targets) rows[k] = { ...rows[k], action };
    if (action === "reword") {
      for (const k of targets) {
        const row = rows[k];
        void loadMessage(row).then(() => refresh());
      }
    }
    refresh();
  }

  function moveSelected(delta: number): void {
    const out = moveRows(rows, selected, delta < 0 ? -1 : 1);
    if (!out) return;
    record();
    rows = out.rows;
    selected = out.selected;
    focus += delta;
    anchor += delta;
    refresh();
    rowEls[focus]?.scrollIntoView({ block: "nearest" });
  }

  // Move one row (a drag, or its own arrow buttons) to `to`.
  function moveOne(from: number, to: number): void {
    if (to < 0 || to >= rows.length || to === from) return;
    record();
    const [row] = rows.splice(from, 1);
    rows.splice(to, 0, row);
    focus = to;
    anchor = to;
    selected = new Set([to]);
    refresh();
    rowEls[to]?.scrollIntoView({ block: "nearest" });
  }

  // --- rows -----------------------------------------------------------------

  function renderRow(row: PlanRow, i: number, heads: Map<number, number[]>): HTMLElement {
    const head = groupHead(rows, i);
    const cls = [
      "rebase-row",
      `action-${row.action}`,
      selected.has(i) ? "selected" : "",
      i === focus ? "focused" : "",
      head >= 0 ? "meld" : "",
      heads.has(i) ? "group-head" : "",
    ].filter(Boolean);
    const wrap = el("div", { class: cls.join(" "), draggable: "true" });
    wrap.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, select, input, textarea")) return;
      if (e.shiftKey) extendTo(i);
      else if (e.metaKey || e.ctrlKey) toggle(i);
      else selectOnly(i);
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
      moveOne(from, to);
    });

    const gripBtn = el("span", { class: "rebase-grip", title: "Drag to reorder" });
    gripBtn.append(grip());

    const up = el("button", { class: "rebase-move-btn up", title: "Move up (Alt+↑)", "aria-label": "Move up" });
    up.append(chevron());
    up.disabled = i === 0;
    up.addEventListener("click", () => moveOne(i, i - 1));

    const down = el("button", { class: "rebase-move-btn", title: "Move down (Alt+↓)", "aria-label": "Move down" });
    down.append(chevron());
    down.disabled = i === rows.length - 1;
    down.addEventListener("click", () => moveOne(i, i + 1));

    wrap.append(gripBtn, el("span", { class: "rebase-move" }, [up, down]), actionChip(row, i));
    wrap.append(el("span", { class: "rebase-sha", text: row.commit.short_sha }));

    // Reword edits the whole message, subject and body; otherwise the subject.
    if (row.action === "reword") {
      const area = el("textarea", { class: "rebase-message", spellcheck: "false" });
      area.value = row.message;
      area.rows = Math.min(8, Math.max(2, row.message.split("\n").length));
      if (!row.loaded) {
        area.disabled = true;
        area.placeholder = "Loading the message…";
      }
      let before: Snapshot | null = null;
      area.addEventListener("focus", () => (before = snapshot()));
      area.addEventListener("input", () => {
        row.message = area.value;
        refreshValidity();
      });
      area.addEventListener("change", () => {
        if (before) {
          undoStack.push(before);
          redoStack.length = 0;
          before = null;
          renderToolbar();
        }
      });
      // Typing in the message shouldn't be interrupted by a drag starting.
      area.addEventListener("mousedown", () => (wrap.draggable = false));
      area.addEventListener("blur", () => (wrap.draggable = true));
      wrap.append(area);
    } else {
      wrap.append(el("span", { class: "rebase-subject", text: row.commit.subject }));
    }

    if (head >= 0) {
      wrap.append(
        el("span", {
          class: "rebase-into",
          text: `↳ into ${rows[head].commit.short_sha}`,
          title: `${ACTION_NAME.get(row.action)} into ${rows[head].commit.short_sha} ${rows[head].commit.subject}`,
        }),
      );
    }
    return wrap;
  }

  function clearDropMarks(): void {
    for (const node of rowEls) node.classList.remove("drop-above", "drop-below");
  }

  // The action control: a coloured chip showing the short name, with the native
  // <select> laid over it invisibly so the platform dropdown (and its full
  // explanations, keyboard handling, and accessibility) is what actually opens.
  function actionChip(row: PlanRow, i: number): HTMLElement {
    const chip = el("span", { class: `rebase-action-chip act-${row.action}` });
    chip.append(el("span", { class: "rebase-action-name", text: ACTION_NAME.get(row.action) ?? row.action }), chevron());

    const sel = el("select", {
      class: "rebase-action-select",
      "aria-label": `Action for ${row.commit.short_sha}`,
    });
    for (const a of actions) {
      const opt = el("option", { value: a.value, text: a.label });
      if (a.value === row.action) opt.selected = true;
      sel.append(opt);
    }
    sel.addEventListener("change", () => setActions(sel.value as RebaseAction, i));
    // A native dropdown can't open if the pointer starts a row drag instead.
    sel.addEventListener("mousedown", () => {
      const rowEl = chip.closest<HTMLElement>(".rebase-row");
      if (rowEl) rowEl.draggable = false;
    });
    sel.addEventListener("blur", () => {
      const rowEl = chip.closest<HTMLElement>(".rebase-row");
      if (rowEl) rowEl.draggable = true;
    });
    chip.append(sel);
    return chip;
  }

  // --- the focused commit: its group's message, and its changes --------------

  // When the focused commit is in a group with a squash, the message the
  // combined commit gets: git's combination until it is edited here.
  function renderGroupBox(): void {
    clear(groupBox);
    const heads = groups(rows);
    const head = heads.has(focus) ? focus : groupHead(rows, focus);
    const melds = head >= 0 ? (heads.get(head) ?? []) : [];
    if (head < 0 || !melds.some((k) => rows[k].action === "squash")) return;
    const members = [head, ...melds].map((k) => rows[k]);
    const sha = rows[head].commit.sha;
    const edited = groupMessages.get(sha);

    const area = el("textarea", { class: "rebase-group-message", spellcheck: "false" });
    const fill = () => {
      area.value =
        edited ??
        defaultGroupMessage(
          rows[head].message,
          melds.map((k) => ({ action: rows[k].action, message: rows[k].message })),
        );
      area.rows = Math.min(10, Math.max(3, area.value.split("\n").length));
    };
    fill();
    if (edited === undefined && members.some((r) => !r.loaded)) {
      area.disabled = true;
      void Promise.all(members.map(loadMessage)).then(() => {
        if (groupBox.contains(area)) renderGroupBox();
      });
    }
    let before: Snapshot | null = null;
    area.addEventListener("focus", () => (before = snapshot()));
    area.addEventListener("input", () => {
      groupMessages.set(sha, area.value);
      refreshValidity();
    });
    area.addEventListener("change", () => {
      if (before) {
        undoStack.push(before);
        redoStack.length = 0;
        before = null;
        renderGroupBox();
        renderToolbar();
      }
    });

    const title = el("div", { class: "rebase-group-title" }, [
      el("span", {
        text: `Message of the combined commit · ${rows[head].commit.short_sha} + ${melds.length} more`,
      }),
    ]);
    if (edited !== undefined) {
      const reset = el("button", { class: "btn ghost small", text: "Use git's default" });
      reset.addEventListener("click", () => {
        record();
        groupMessages.delete(sha);
        renderGroupBox();
        renderToolbar();
        refreshValidity();
      });
      title.append(reset);
    }
    groupBox.append(title, area);
  }

  // Show the focused commit's file changes. Fetches (and caches) on demand.
  function renderFiles(): void {
    clear(files);
    const row = rows[focus];
    if (!row) return;
    files.append(el("div", { class: "rebase-preview-head", text: `Changes — ${row.commit.short_sha} ${row.commit.subject}` }));
    const body = el("div", { class: "rebase-preview-body" });
    files.append(body);
    const paint = (detail: CommitDetail) => {
      clear(body);
      if (!detail.files.length) body.append(el("div", { class: "rebase-preview-loading", text: "No file changes." }));
      for (const file of detail.files) body.append(renderFile(file));
    };
    const cached = detailCache.get(row.commit.sha);
    if (cached) {
      paint(cached);
      return;
    }
    body.append(el("div", { class: "rebase-preview-loading", text: "Loading changes…" }));
    loadDetail(row.commit.sha)
      .then((detail) => {
        // Only paint if this commit is still the focused one.
        if (rows[focus]?.commit.sha === row.commit.sha) paint(detail);
      })
      .catch(() => {
        clear(body);
        body.append(el("div", { class: "rebase-preview-loading", text: "Couldn't load changes." }));
      });
  }

  render();
}

// A small labelled checkbox that reports its state through `onChange`.
function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = el("input", { type: "checkbox" });
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return el("label", { class: "rebase-check" }, [input, el("span", { text: label })]);
}
