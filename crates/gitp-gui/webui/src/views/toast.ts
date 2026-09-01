// A stack of auto-dismissing notifications in the top-right corner.
//
// The status bar is a single line in the bottom-left corner: it says what the
// app is doing right now, but a result that lands there while you're reading
// the diff pane is easy to miss entirely. Toasts carry the same outcomes to a
// place that catches the eye, without a modal's demand to be dismissed before
// anything else can happen.
//
// Errors are sticky — an error that scrolled itself away before being read is
// the failure this exists to prevent — and carry a Details button when git
// gave output worth reading in full.

import { el, svg } from "../dom";

export type ToastKind = "info" | "success" | "error";

export interface ToastOptions {
  kind?: ToastKind;
  // Git's full output, shown by the Details button (which the caller wires to
  // the message dialog). Ignored when `onDetails` is absent.
  detail?: string;
  onDetails?: () => void;
}

// How long a toast stays before fading, per kind. Errors never auto-dismiss.
const DISMISS_MS: Record<ToastKind, number> = { info: 4500, success: 4500, error: 0 };

// Past this many, the oldest toast is evicted so a burst (a bulk cherry-pick
// reporting each commit) can't fill the viewport.
const MAX_VISIBLE = 4;

let stack: HTMLElement | null = null;

function host(): HTMLElement {
  if (!stack || !stack.isConnected) {
    stack = el("div", { class: "toast-stack", role: "status", "aria-live": "polite" });
    document.body.append(stack);
  }
  // Re-measured per toast: the action bar and repo tabs appear only once a repo
  // is open, so a fixed offset would either overlap them or float below nothing.
  stack.style.top = `${topOffset()}px`;
  return stack;
}

// The bottom of the lowest piece of app chrome currently showing, so a toast
// never covers the toolbar buttons it might be telling you to press again.
function topOffset(): number {
  for (const sel of ["#repo-tabs", "#action-bar", ".topbar"]) {
    const rect = document.querySelector(sel)?.getBoundingClientRect();
    if (rect && rect.height > 0) return Math.round(rect.bottom) + 8;
  }
  return 12;
}

export function toast(message: string, opts: ToastOptions = {}): void {
  const kind = opts.kind ?? "info";
  const parent = host();

  // A repeat of the message already on top counts up instead of stacking —
  // otherwise a retried action reads as several distinct failures.
  const top = parent.lastElementChild as HTMLElement | null;
  if (top?.dataset.message === message && top.dataset.kind === kind) {
    const n = Number(top.dataset.count ?? "1") + 1;
    top.dataset.count = String(n);
    const badge = top.querySelector(".toast-count");
    if (badge) badge.textContent = `×${n}`;
    else top.querySelector(".toast-message")?.after(el("span", { class: "toast-count", text: `×${n}` }));
    // Same message, but not necessarily the same output — a second failed push
    // has its own stderr, and Details has to show *that* one, not the first.
    setDetails(top, opts.onDetails);
    restartTimer(top, kind);
    return;
  }

  const node = el("div", { class: `toast toast-${kind}`, "data-message": message, "data-kind": kind });
  node.append(kindIcon(kind), el("span", { class: "toast-message", text: message }));

  const close = el("button", { class: "toast-close", title: "Dismiss", "aria-label": "Dismiss" });
  close.append(el("span", { text: "×" }));
  close.addEventListener("click", () => dismiss(node));
  node.append(close);
  setDetails(node, opts.onDetails);

  // Hovering holds a toast open — you shouldn't lose a message by reaching for
  // its own Details button.
  node.addEventListener("mouseenter", () => clearTimer(node));
  node.addEventListener("mouseleave", () => restartTimer(node, kind));

  parent.append(node);
  while (parent.children.length > MAX_VISIBLE) dismiss(parent.firstElementChild as HTMLElement);

  // Enter transition: the class lands on the next frame so the transition runs.
  requestAnimationFrame(() => node.classList.add("in"));
  restartTimer(node, kind);
}

export function clearToasts(): void {
  if (!stack) return;
  for (const node of [...stack.children]) clearTimer(node as HTMLElement);
  stack.replaceChildren();
}

// Add, replace, or drop a toast's Details button. Replacing means rebuilding
// it: the handler closes over the detail text it was given, so rebinding by
// hand would leave the previous listener attached as well.
function setDetails(node: HTMLElement, onDetails: (() => void) | undefined): void {
  node.querySelector(".toast-details")?.remove();
  if (!onDetails) return;
  const details = el("button", { class: "toast-details", text: "Details" });
  details.addEventListener("click", onDetails);
  // Before the close button, so Details doesn't shift as a count badge appears.
  const close = node.querySelector(".toast-close");
  if (close) close.before(details);
  else node.append(details);
}

const timers = new WeakMap<HTMLElement, number>();

function clearTimer(node: HTMLElement): void {
  const id = timers.get(node);
  if (id !== undefined) {
    clearTimeout(id);
    timers.delete(node);
  }
}

function restartTimer(node: HTMLElement, kind: ToastKind): void {
  clearTimer(node);
  const ms = DISMISS_MS[kind];
  if (ms > 0) timers.set(node, window.setTimeout(() => dismiss(node), ms));
}

function dismiss(node: HTMLElement | null): void {
  if (!node) return;
  clearTimer(node);
  node.classList.remove("in");
  node.classList.add("out");
  // Remove on the transition rather than a matching timeout, so a reduced-motion
  // user (no transition, so no transitionend) still needs the fallback below.
  let done = false;
  const drop = () => {
    if (done) return;
    done = true;
    node.remove();
  };
  node.addEventListener("transitionend", drop, { once: true });
  window.setTimeout(drop, 400);
}

function kindIcon(kind: ToastKind): SVGElement {
  const paths =
    kind === "error"
      ? ["M12 8v5", "M12 16.5v.01", "M12 3l9 16H3z"]
      : kind === "success"
        ? ["M20 6L9 17l-5-5"]
        : ["M12 8v.01", "M12 11v5", "M12 3a9 9 0 100 18 9 9 0 000-18z"];
  const s = svg("svg", { viewBox: "0 0 24 24", class: "toast-icon" });
  for (const d of paths) {
    s.append(
      svg("path", {
        d,
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      }),
    );
  }
  return s;
}
