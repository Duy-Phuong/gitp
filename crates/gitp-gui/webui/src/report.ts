// The status bar, the global progress bar, and the toasts / error dialogs that
// report how an action went.

import { cancelNetworkOp, isCancelled, onGitProgress, onNetworkChange, onPendingChange } from "./api";
import { clear, el, $ } from "./dom";
import { formatGitProgress } from "./git-progress";
import type { GitProgress } from "./types";
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
  syncCancel();
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

// --- Network progress and Cancel -------------------------------------------
// While a fetch / pull / push runs, git's own progress replaces guesswork: the
// busy status gains the phase and percentage ("Pushing… Writing objects 45%"),
// the global bar turns determinate, and a Cancel button stops it. Cancel only
// shows alongside a busy status — a silent background fetch has nothing on
// screen to cancel. Nor once the operation reaches a local write (a pull's merge
// or rebase), which the backend won't interrupt.
let networkBusy = false;
let localStep = false;

export function watchNetwork(): void {
  const bar = $("#global-progress");
  $("#status-cancel").addEventListener("click", cancelNetworkAction);
  onNetworkChange((count) => {
    networkBusy = count > 0;
    if (!networkBusy) {
      localStep = false;
      bar.classList.remove("determinate");
      bar.style.removeProperty("--progress");
    }
    syncCancel();
  });
  void onGitProgress((p) => showGitProgress(bar, p));
}

// Whether Cancel is on offer — the status-bar button is showing.
export function canCancelNetwork(): boolean {
  return !$("#status-cancel").classList.contains("hidden");
}

export function cancelNetworkAction(): void {
  const cancel = $<HTMLButtonElement>("#status-cancel");
  if (cancel.disabled) return;
  cancel.disabled = true;
  setStatusProgress("Cancelling…");
  void cancelNetworkOp();
}

function showGitProgress(bar: HTMLElement, p: GitProgress): void {
  if (!networkBusy || !$("#statusbar").classList.contains("busy")) return;
  if (!p.cancellable) {
    localStep = true;
    syncCancel();
  } else if ($<HTMLButtonElement>("#status-cancel").disabled) {
    // Once Cancel is pressed, "Cancelling…" stays until git is gone.
    return;
  }
  setStatusProgress(formatGitProgress(p), p.detail);
  bar.classList.toggle("determinate", p.percent !== null);
  if (p.percent !== null) bar.style.setProperty("--progress", `${p.percent}%`);
}

// Put `text` after the busy status message, replacing any earlier progress.
// A new setStatus clears the slot, so it never outlives its operation.
function setStatusProgress(text: string, title = ""): void {
  const message = document.querySelector("#status-message .status-text");
  if (!message) return;
  let span = message.nextElementSibling;
  if (!span?.classList.contains("status-progress")) {
    span = el("span", { class: "status-progress" });
    message.after(span);
  }
  span.textContent = text;
  span.setAttribute("title", title);
}

function syncCancel(): void {
  const cancel = $<HTMLButtonElement>("#status-cancel");
  const show = networkBusy && !localStep && $("#statusbar").classList.contains("busy");
  if (show && cancel.classList.contains("hidden")) cancel.disabled = false;
  cancel.classList.toggle("hidden", !show);
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
  if (isCancelled(err)) return reportCancelled(title);
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
  if (isCancelled(err)) return reportCancelled(title);
  const detail = String(err);
  setStatus(`${title}: ${detail}`);
  showErrorDialog(title, detail, actions);
  toast(title, { kind: "error", onDetails: () => showErrorDialog(title, detail, actions) });
}

// A cancelled network operation isn't a failure — the user asked for it — so it
// gets a neutral toast and no dialog: "Push failed" becomes "Push cancelled."
function reportCancelled(title: string): void {
  const message = `${title.replace(/ failed$/, "")} cancelled.`;
  setStatus(message);
  toast(message, { kind: "info" });
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
