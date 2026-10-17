// The status bar, the global progress bar, and the toasts / error dialogs that
// report how an action went.

import { onPendingChange } from "./api";
import { clear, el, $ } from "./dom";
import { showErrorDialog, type MessageDialogAction } from "./views/message-dialog";
import { toast } from "./views/toast";

// Render a status message. In-progress messages end with an ellipsis (e.g.
// "Pushing…", "Checking out main…"); those show a spinner so any slow action
// has clear in-app feedback instead of relying on the OS wait cursor.
export function setStatus(message: string): void {
  const slot = $("#status-message");
  const busy = message.trimEnd().endsWith("…") || message.trimEnd().endsWith("...");
  clear(slot);
  if (busy) slot.append(el("span", { class: "status-spinner", "aria-hidden": "true" }));
  slot.append(el("span", { class: "status-text", text: message }));
  $("#statusbar").classList.toggle("busy", busy);
  trackStatusElapsed(busy ? slot : null);
}

// Once a busy status has been up for a couple of seconds, append how long
// ("Pushing… 7s"). A pull over a slow link can sit for half a minute; without
// a moving number there's no way to tell "still working" from "hung".
let statusElapsedTimer: number | null = null;

function trackStatusElapsed(slot: HTMLElement | null): void {
  if (statusElapsedTimer !== null) {
    window.clearInterval(statusElapsedTimer);
    statusElapsedTimer = null;
  }
  if (!slot) return;
  const started = Date.now();
  const suffix = el("span", { class: "status-elapsed" });
  statusElapsedTimer = window.setInterval(() => {
    const secs = Math.round((Date.now() - started) / 1000);
    if (secs < 2) return;
    if (!suffix.isConnected) slot.append(suffix);
    suffix.textContent = ` ${secs}s`;
  }, 1000);
}

// --- Global progress bar ---------------------------------------------------
// Driven by the API layer's in-flight count (see onPendingChange in api.ts):
// the bar appears once any backend call has run for 300 ms and hides when the
// last one returns. Button spinners and status messages cover the actions that
// set them; this covers everything — view loads, diffs, snapshots, dialogs'
// data — without each call site opting in.
const PROGRESS_DELAY_MS = 300;

export function watchPending(): void {
  const bar = $("#global-progress");
  let showTimer: number | null = null;
  onPendingChange((count) => {
    if (count > 0) {
      if (showTimer === null && !bar.classList.contains("active")) {
        showTimer = window.setTimeout(() => {
          showTimer = null;
          bar.classList.add("active");
          bar.setAttribute("aria-hidden", "false");
        }, PROGRESS_DELAY_MS);
      }
    } else {
      if (showTimer !== null) {
        window.clearTimeout(showTimer);
        showTimer = null;
      }
      bar.classList.remove("active");
      bar.setAttribute("aria-hidden", "true");
    }
  });
}

// --- Reporting outcomes ----------------------------------------------------
//
// The status bar keeps saying what the app is doing, but on its own it's one
// line in the corner furthest from where you're looking. Every outcome worth
// noticing also goes to a toast:
//
//   readFailed  — a read/refresh that failed. Sticky toast; no modal, because
//                 there's no decision to make and nothing was changed.
//   opFailed    — an operation that mutates the repo failed. Sticky toast plus
//                 the modal, which is where git's full output and any recovery
//                 actions (Pull / Force Push / Resolve Conflicts) live.
//   reportDone  — an async outcome ("Pull complete", "Deleted 2 branches")
//                 that would otherwise land silently in the status line.
//
// Synchronous chatter ("3 commits match", "Jumped to main") stays on the
// status line alone — a toast per keystroke-settled search is noise.

export function readFailed(title: string, err: unknown): void {
  const detail = String(err);
  setStatus(`${title}: ${detail}`);
  toast(title, {
    kind: "error",
    onDetails: () => showErrorDialog(title, detail),
  });
}

export function opFailed(
  title: string,
  err: unknown,
  actions?: MessageDialogAction | MessageDialogAction[],
): void {
  const detail = String(err);
  setStatus(`${title}: ${detail}`);
  showErrorDialog(title, detail, actions);
  toast(title, { kind: "error", onDetails: () => showErrorDialog(title, detail, actions) });
}

export function reportDone(message: string): void {
  setStatus(message);
  // Git's own output can run to several lines (a pull summary, a stash listing)
  // and a toast clips it — offer the full text rather than truncating silently.
  const clipped = message.includes("\n");
  toast(message, {
    kind: "success",
    onDetails: clipped ? () => showErrorDialog("Result", message) : undefined,
  });
}
