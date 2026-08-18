// Interactive-rebase editor: a modal listing the commits to be replayed
// (oldest at top, matching a git rebase todo), each with an action
// (pick / reword / squash / drop) and up/down reordering. "Start Rebase"
// hands the ordered plan back to the caller.

import { clear, el } from "../dom";
import type { RebaseAction, RebaseCommit, RebaseStep } from "../types";

interface Row {
  commit: RebaseCommit;
  action: RebaseAction;
  message: string; // used only when action === "reword"
}

const ACTIONS: { value: RebaseAction; label: string }[] = [
  { value: "pick", label: "Pick" },
  { value: "reword", label: "Reword" },
  { value: "squash", label: "Squash into previous" },
  { value: "drop", label: "Drop" },
];

let overlay: HTMLElement | null = null;

export function closeRebaseModal(): void {
  overlay?.remove();
  overlay = null;
}

export function openRebaseModal(
  onto: string,
  currentName: string,
  commits: RebaseCommit[],
  onRun: (steps: RebaseStep[]) => void,
): void {
  closeRebaseModal();
  const rows: Row[] = commits.map((commit) => ({ commit, action: "pick", message: commit.subject }));

  overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal rebase-modal" });
  overlay.append(modal);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeRebaseModal();
  });
  document.addEventListener("keydown", onKey, true);

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }
  function close(): void {
    document.removeEventListener("keydown", onKey, true);
    closeRebaseModal();
  }

  // The first commit that isn't dropped can't be a squash (nothing before it).
  function firstApplied(): Row | undefined {
    return rows.find((r) => r.action !== "drop");
  }

  function render(): void {
    clear(modal);
    modal.append(
      el("div", { class: "modal-title", text: `Interactive rebase — ${currentName} onto ${onto}` }),
      el("div", {
        class: "modal-sub",
        text: "Top is applied first. Reorder with the arrows; choose an action per commit.",
      }),
    );

    const list = el("div", { class: "rebase-list" });
    rows.forEach((row, i) => list.append(renderRow(row, i)));
    modal.append(list);

    const invalid = firstApplied()?.action === "squash";
    const warn = el("div", {
      class: "rebase-warn",
      text: invalid ? "The first applied commit can't be “Squash into previous”." : "",
    });

    const cancel = el("button", { class: "btn ghost", text: "Cancel" });
    cancel.addEventListener("click", close);
    const start = el("button", { class: "btn", text: "Start Rebase" }) as HTMLButtonElement;
    start.disabled = invalid || rows.length === 0;
    start.addEventListener("click", () => {
      const steps: RebaseStep[] = rows.map((r) => ({
        sha: r.commit.sha,
        action: r.action,
        message: r.action === "reword" ? r.message : null,
      }));
      close();
      onRun(steps);
    });

    modal.append(warn, el("div", { class: "modal-actions" }, [cancel, start]));
  }

  function renderRow(row: Row, i: number): HTMLElement {
    const wrap = el("div", { class: `rebase-row action-${row.action}` });

    const up = el("button", { class: "icon-btn", text: "↑", title: "Move up" }) as HTMLButtonElement;
    up.disabled = i === 0;
    up.addEventListener("click", () => {
      [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
      render();
    });
    const down = el("button", { class: "icon-btn", text: "↓", title: "Move down" }) as HTMLButtonElement;
    down.disabled = i === rows.length - 1;
    down.addEventListener("click", () => {
      [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]];
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

  render();
  document.body.append(overlay);
}
