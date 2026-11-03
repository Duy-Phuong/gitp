// The Markdown boxes of the pull request view: a textarea that grows with
// what is typed, so nothing scrolls inside it, and a Preview button that
// shows the text rendered the way GitHub will.

import { el } from "../dom";
import { renderGitHubMarkdown } from "./github-markdown";

export function composerArea(attrs: Record<string, string> = {}): HTMLTextAreaElement {
  const area = el("textarea", { spellcheck: "true", ...attrs, class: `pr-composer-input ${attrs.class ?? ""}`.trim() });
  area.addEventListener("input", () => grow(area));
  // A prefilled box (a kept draft, a quote) is sized once it is on the page.
  requestAnimationFrame(() => grow(area));
  return area;
}

export function grow(area: HTMLTextAreaElement): void {
  area.style.height = "auto";
  if (area.scrollHeight) area.style.height = `${area.scrollHeight + 2}px`;
}

// A Preview button for `area`: it swaps the box for the rendered Markdown
// and reads Edit until clicked again. `edit()` goes back to the box, for
// when its text was posted and cleared.
export function previewToggle(area: HTMLTextAreaElement): { button: HTMLButtonElement; edit: () => void } {
  const button = el("button", { class: "btn small ghost", text: "Preview" });
  let preview: HTMLElement | null = null;
  const edit = () => {
    if (!preview) return;
    preview.replaceWith(area);
    preview = null;
    button.textContent = "Preview";
    area.focus();
  };
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    if (preview) return edit();
    preview = el("div", { class: "pr-composer-preview" }, [
      area.value.trim() ? renderGitHubMarkdown(area.value) : el("div", { class: "pr-card-none", text: "Nothing to preview." }),
    ]);
    area.replaceWith(preview);
    button.textContent = "Edit";
  });
  return { button, edit };
}
