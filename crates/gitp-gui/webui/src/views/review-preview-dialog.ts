// What "Post N approved" will put on GitHub, before it does: the verdict, the
// review message (with the drafts whose line isn't in the diff, added to it)
// and each line comment, all drawn as GitHub draws Markdown. Post or Cancel.
// Reuses the shared `.modal-overlay` / `.modal` shell.

import { el } from "../dom";
import type { LineComment, ReviewVerdict } from "../types";
import { renderGitHubMarkdown } from "./github-markdown";

const VERDICT_TEXT: Record<ReviewVerdict, string> = {
  comment: "Comment",
  approve: "Approve",
  request_changes: "Request changes",
};

export interface ReviewPreview {
  number: number;
  // Who it posts as; null when not known.
  login: string | null;
  verdict: ReviewVerdict;
  body: string;
  comments: LineComment[];
}

// Resolves true on Post, false on Cancel, Escape or a click outside.
export function confirmReviewPost(p: ReviewPreview): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = el("div", { class: "modal-overlay" });
    const modal = el("div", { class: "modal review-preview", role: "dialog", "aria-label": "Review to post" });
    overlay.append(modal);
    const done = (ok: boolean) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(ok);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        done(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) done(false);
    });

    const n = p.comments.length;
    const list = el("div", { class: "review-preview-body" });
    list.append(el("div", { class: "review-preview-label", text: "Review message" }));
    list.append(
      p.body.trim()
        ? el("div", { class: "review-preview-item" }, [renderGitHubMarkdown(p.body)])
        : el("div", { class: "review-preview-empty", text: "No message." }),
    );
    if (n) list.append(el("div", { class: "review-preview-label", text: `Line comment${n === 1 ? "" : "s"} (${n})` }));
    for (const c of p.comments) {
      list.append(
        el("div", { class: "review-preview-item" }, [
          el("code", { class: "review-preview-where", text: `${c.path}:${c.line}${c.side === "LEFT" ? " (removed line)" : ""}` }),
          renderGitHubMarkdown(c.body),
        ]),
      );
    }
    const cancel = el("button", { class: "btn ghost", text: "Cancel" });
    cancel.addEventListener("click", () => done(false));
    const post = el("button", { class: "btn", text: "Post to GitHub" });
    post.addEventListener("click", () => done(true));
    modal.append(
      el("div", { class: "modal-title", text: `Post this review on #${p.number}?` }),
      el("div", {
        class: "modal-sub",
        text: `${VERDICT_TEXT[p.verdict]} · ${n} line comment${n === 1 ? "" : "s"}${p.login ? ` · as ${p.login}` : ""}. This is what GitHub will show.`,
      }),
      list,
      el("div", { class: "modal-actions" }, [cancel, post]),
    );
    document.body.append(overlay);
    requestAnimationFrame(() => post.focus());
  });
}
