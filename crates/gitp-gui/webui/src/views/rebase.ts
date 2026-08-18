// Interactive-rebase editor: a modal listing the commits to be replayed
// (oldest at top, matching a git rebase todo). Each commit gets an action
// (pick / edit / reword / squash / fixup / drop), can be reordered, and — when
// selected — previews its file changes. "Rebase" hands the ordered plan plus
// the two option toggles (update dependent branches, backup branch) back to the
// caller.

import { fetchCommitDetail } from "../api";
import { clear, el } from "../dom";
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

// Action, its menu label, and the single-key shortcut (matches the reference).
const ACTIONS: { value: RebaseAction; label: string; key: string }[] = [
  { value: "pick", label: "Pick — use commit", key: "p" },
  { value: "edit", label: "Edit — stop for amending", key: "e" },
  { value: "reword", label: "Reword — edit the message", key: "r" },
  { value: "squash", label: "Squash — meld into previous, keep both messages", key: "s" },
  { value: "fixup", label: "Fixup — meld into previous, discard message", key: "f" },
  { value: "drop", label: "Drop — remove commit", key: "d" },
];
const KEY_TO_ACTION = new Map(ACTIONS.map((a) => [a.key, a.value]));

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
    // Single-key action shortcuts apply to the selected row (unless typing).
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    const action = KEY_TO_ACTION.get(e.key.toLowerCase());
    if (action && rows[selected]) {
      rows[selected].action = action;
      render();
      e.preventDefault();
    }
  };
  document.addEventListener("keydown", onKey, true);

  // The first commit that isn't dropped can't be squash/fixup (nothing before).
  function firstApplied(): Row | undefined {
    return rows.find((r) => r.action !== "drop");
  }

  // Lazily loaded commit detail for the changes preview, keyed by sha.
  const detailCache = new Map<string, CommitDetail>();

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

    const list = el("div", { class: "rebase-list" });
    rows.forEach((row, i) => list.append(renderRow(row, i)));

    const preview = el("div", { class: "rebase-preview" });
    renderPreview(preview);

    const invalid = firstApplied()?.action === "squash" || firstApplied()?.action === "fixup";
    const warn = el("div", {
      class: "rebase-warn",
      text: invalid ? "The first applied commit can't be Squash or Fixup." : "",
    });

    const backupBox = checkbox("Backup current state with temporary branch", backup, (v) => (backup = v));
    backupBox.classList.add("rebase-backup");

    const cancel = el("button", { class: "btn ghost", text: "Cancel" });
    cancel.addEventListener("click", closeRebaseModal);
    const start = el("button", { class: "btn", text: "Rebase" }) as HTMLButtonElement;
    start.disabled = invalid || rows.length === 0;
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
  }

  function renderRow(row: Row, i: number): HTMLElement {
    const wrap = el("div", { class: `rebase-row action-${row.action}${i === selected ? " selected" : ""}` });
    wrap.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, select, input")) return;
      selected = i;
      render();
    });

    const up = el("button", { class: "icon-btn", text: "↑", title: "Move up" }) as HTMLButtonElement;
    up.disabled = i === 0;
    up.addEventListener("click", () => {
      [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
      selected = i - 1;
      render();
    });
    const down = el("button", { class: "icon-btn", text: "↓", title: "Move down" }) as HTMLButtonElement;
    down.disabled = i === rows.length - 1;
    down.addEventListener("click", () => {
      [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]];
      selected = i + 1;
      render();
    });

    const select = el("select", { class: "rebase-action" }) as HTMLSelectElement;
    for (const a of ACTIONS) {
      const opt = el("option", { value: a.value, text: a.label }) as HTMLOptionElement;
      if (a.value === row.action) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener("change", () => {
      row.action = select.value as RebaseAction;
      render();
    });

    const sha = el("span", { class: "rebase-sha", text: row.commit.short_sha });

    // Reword shows an editable message; otherwise just the subject.
    const subject =
      row.action === "reword"
        ? (() => {
            const inp = el("input", {
              class: "rebase-message",
              value: row.message,
              spellcheck: false,
            }) as HTMLInputElement;
            inp.addEventListener("input", () => (row.message = inp.value));
            return inp;
          })()
        : el("span", { class: "rebase-subject", text: row.commit.subject });

    wrap.append(el("span", { class: "rebase-move" }, [up, down]), select, sha, subject);
    return wrap;
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
