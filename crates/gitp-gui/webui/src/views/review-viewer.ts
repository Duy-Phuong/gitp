// The saved review page of a pull request, read inside gitp: the whole page,
// diagrams included, in a sandboxed frame. Its "Explain more" runs the
// explanation in the background, like a review board request, and the page
// is read again when it is done, at that finding. The ✓ Fixed marks come from
// the page itself (review-bridge.js). Closing the viewer keeps an explanation
// running; it shows again on the next opening.

import { el } from "../dom";

export interface ReviewViewerDeps {
  // The URL the frame loads the page from.
  pageUrl: (number: number) => Promise<string>;
  explain: (repo: string, number: number, finding: string) => Promise<void>;
  openUrl: (url: string) => void;
  openInBrowser: () => void;
}

interface Explaining {
  running: Set<string>;
  failed: Record<string, string>;
}

// Per repository and pull request.
const explaining = new Map<string, Explaining>();
const stateOf = (repo: string, number: number): Explaining => {
  const key = `${repo}\n${number}`;
  let s = explaining.get(key);
  if (!s) {
    s = { running: new Set(), failed: {} };
    explaining.set(key, s);
  }
  return s;
};

let close: (() => void) | null = null;

export function openReviewViewer(repo: string, number: number, title: string, deps: ReviewViewerDeps): void {
  close?.();
  const state = stateOf(repo, number);
  const frame = el("iframe", { class: "review-viewer-frame", title: `Review of #${number}` });
  // Scripts only: no same origin, no forms, no popups, no top navigation.
  frame.setAttribute("sandbox", "allow-scripts");
  let scrollTo: string | null = null;

  const send = () =>
    frame.contentWindow?.postMessage({ gitpReview: true, running: [...state.running], failed: state.failed, scrollTo }, "*");
  const load = async () => {
    try {
      frame.src = await deps.pageUrl(number);
    } catch (err) {
      frame.srcdoc = `<p style="font-family:sans-serif">Couldn't read the review: ${String(err).replace(/[<&]/g, "")}</p>`;
    }
  };

  const onMessage = (e: MessageEvent) => {
    const msg = e.data as { gitpReview?: boolean; kind?: string; finding?: string; url?: string } | null;
    if (e.source !== frame.contentWindow || !msg?.gitpReview) return;
    if (msg.kind === "ready") {
      send();
      scrollTo = null;
    } else if (msg.kind === "open" && msg.url) {
      deps.openUrl(msg.url);
    } else if (msg.kind === "explain" && msg.finding && !state.running.has(msg.finding)) {
      const finding = msg.finding;
      state.running.add(finding);
      delete state.failed[finding];
      send();
      deps
        .explain(repo, number, finding)
        .then(
          () => {
            state.running.delete(finding);
            if (close !== stop) return;
            // Read the page again, with the new explanation, at its finding.
            scrollTo = finding;
            void load();
          },
          (err: unknown) => {
            state.running.delete(finding);
            state.failed[finding] = String(err).split("\n")[0];
            if (close === stop) send();
          },
        );
    }
  };

  const reload = el("button", { class: "btn small", text: "Reload", title: "Read the review file again" });
  reload.addEventListener("click", () => void load());
  const browser = el("button", { class: "btn small", text: "Open in Browser" });
  browser.addEventListener("click", deps.openInBrowser);
  const done = el("button", { class: "btn small", text: "Close" });
  const overlay = el("div", { class: "modal-overlay" }, [
    el("div", { class: "modal review-viewer", role: "dialog", "aria-label": `Review of #${number}` }, [
      el("div", { class: "review-viewer-head" }, [
        el("span", { class: "modal-title", text: `Review of #${number}` }),
        el("span", { class: "review-viewer-sub", text: title }),
        el("span", { class: "spacer" }),
        reload,
        browser,
        done,
      ]),
      frame,
    ]),
  ]);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") stop();
  };
  function stop(): void {
    overlay.remove();
    window.removeEventListener("message", onMessage);
    document.removeEventListener("keydown", onKey, true);
    close = null;
  }
  close = stop;
  done.addEventListener("click", stop);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) stop();
  });
  window.addEventListener("message", onMessage);
  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  void load();
}
