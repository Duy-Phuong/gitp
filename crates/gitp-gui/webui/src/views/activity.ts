// The Activity view: every git command gitp ran for the repo, newest first —
// when, how long it took, and whether it worked — so a failed hook, a rejected
// push or a slow fetch can still be read after its toast is gone. Click an
// entry for what git printed.
//
// The backend records as git runs; while the view is open it polls for the
// entries newer than the last one it has, which costs nothing when idle.

import { clear, el } from "../dom";
import type { ActivityEntry } from "../types";

export interface ActivityCallbacks {
  // The repo's entries newest first; with `since`, only those after that id.
  fetch: (since: number | null) => Promise<ActivityEntry[]>;
  clear: () => Promise<void>;
  copy: (text: string) => void;
  reportError: (title: string, err: unknown) => void;
}

export interface ActivityHandle {
  // Load the log and keep it current until `stop`.
  start: () => void;
  stop: () => void;
  // Forget the entries — they belong to the repo being switched away from.
  reset: () => void;
}

// How often an open view asks for new entries.
const POLL_MS = 1000;
// The backend keeps this many per repo; the view keeps no more.
const LIMIT = 500;

// `fresh` (newest first, all newer than anything in `known`) on top of
// `known`, capped like the backend's ring.
export function mergeActivity(known: ActivityEntry[], fresh: ActivityEntry[]): ActivityEntry[] {
  return fresh.length ? [...fresh, ...known].slice(0, LIMIT) : known;
}

// "12 ms", "1.8 s", "2m 05s".
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

// How the command ended, in words.
export function exitText(e: ActivityEntry): string {
  if (e.exit_code === null) return "stopped (cancelled, or git could not start)";
  return `exit ${e.exit_code}`;
}

// The entry as plain text, for Copy: the command, when and how it ended, and
// its output.
export function activityText(e: ActivityEntry): string {
  const lines = [`$ ${e.command}`, `# ${new Date(e.started_at).toISOString()} · ${formatDuration(e.duration_ms)} · ${exitText(e)}`];
  if (e.stdout) lines.push(e.stdout);
  if (e.stderr) lines.push(e.stderr);
  return lines.join("\n");
}

export function setupActivity(host: HTMLElement, cb: ActivityCallbacks): ActivityHandle {
  let entries: ActivityEntry[] = [];
  let showQuiet = false;
  const expanded = new Set<number>();
  let timer: number | null = null;
  // Drops a slow poll's result once the view was reset or restarted.
  let generation = 0;
  // Between the handle's `start` and `stop`: a Clear that finishes after the
  // user left the view mustn't start polling again behind it.
  let active = false;

  const quietBox = el("input", { type: "checkbox" }) as HTMLInputElement;
  quietBox.addEventListener("change", () => {
    showQuiet = quietBox.checked;
    render();
  });
  const clearBtn = el("button", { class: "btn small ghost", text: "Clear", title: "Forget this repository's activity" });
  clearBtn.addEventListener("click", () => {
    // Stopped first, so a poll already on its way can't put back what was cleared.
    stop();
    cb.clear().then(
      () => {
        entries = [];
        expanded.clear();
        if (active) start();
      },
      (err) => cb.reportError("Failed to clear the activity log", err),
    );
  });
  const list = el("div", { class: "activity-list" });
  host.append(
    el("div", { class: "log-toolbar" }, [
      el("span", { class: "reflog-title", text: "Activity" }),
      el("label", { class: "activity-quiet", title: "Also list the read-only commands every refresh runs (status, log, diff…)" }, [
        quietBox,
        "Show background commands",
      ]),
      clearBtn,
    ]),
    list,
  );

  function render(): void {
    const keep = list.scrollTop;
    clear(list);
    const shown = showQuiet ? entries : entries.filter((e) => !e.quiet);
    if (!shown.length) {
      const hidden = entries.length - shown.length;
      const text = hidden
        ? `Only background commands so far (${hidden}).`
        : "No git commands yet. Everything gitp runs for this repository is listed here.";
      list.append(el("div", { class: "detail-empty", text }));
      return;
    }
    for (const entry of shown) list.append(row(entry));
    list.scrollTop = keep;
  }

  function row(e: ActivityEntry): HTMLElement {
    const open = expanded.has(e.id);
    const when = new Date(e.started_at);
    const head = el("div", { class: "activity-head", title: `${when.toLocaleString()} · ${exitText(e)}` }, [
      el("span", {
        class: `activity-status ${e.success ? "ok" : "failed"}`,
        text: e.success ? "✓" : "✗",
        "aria-label": e.success ? "Succeeded" : "Failed",
      }),
      el("span", { class: "activity-time", text: when.toLocaleTimeString([], { hour12: false }) }),
      el("span", { class: "activity-command", text: e.command }),
      el("span", { class: "activity-duration", text: formatDuration(e.duration_ms) }),
    ]);
    const r = el("div", { class: `activity-row${open ? " open" : ""}${e.quiet ? " quiet" : ""}` }, [head]);
    head.addEventListener("click", () => {
      if (expanded.has(e.id)) expanded.delete(e.id);
      else expanded.add(e.id);
      render();
    });
    if (open) {
      const copy = el("button", { class: "btn small ghost", text: "Copy", title: "Copy the command and its output" });
      copy.addEventListener("click", () => cb.copy(activityText(e)));
      const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
      r.append(
        el("div", { class: "activity-detail" }, [
          el("div", { class: "activity-detail-bar" }, [el("span", { text: exitText(e) }), copy]),
          el("pre", { class: "activity-output", text: output || "(no output)" }),
        ]),
      );
    }
    return r;
  }

  async function poll(mine: number): Promise<void> {
    let fresh: ActivityEntry[];
    try {
      fresh = await cb.fetch(entries.length ? entries[0].id : null);
    } catch (err) {
      if (mine === generation) {
        stop();
        cb.reportError("Failed to load the activity log", err);
      }
      return;
    }
    if (mine !== generation) return;
    if (fresh.length || !entries.length) {
      entries = mergeActivity(entries, fresh);
      render();
    }
    // Rescheduled after each answer, so a slow one never stacks up behind it.
    timer = window.setTimeout(() => void poll(mine), POLL_MS);
  }

  function start(): void {
    stop();
    void poll(generation);
  }

  function stop(): void {
    generation++;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }

  return {
    start: () => {
      active = true;
      start();
    },
    stop: () => {
      active = false;
      stop();
    },
    reset: () => {
      stop();
      entries = [];
      expanded.clear();
      clear(list);
    },
  };
}
