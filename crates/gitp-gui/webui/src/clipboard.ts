// Copying text (a SHA, a branch name) to the clipboard.

import { el } from "./dom";
import { setStatus } from "./report";

// Copy `text` to the clipboard. Uses the async clipboard API, falling back to a
// hidden textarea for webviews where it's unavailable.
export async function copyText(text: string, note: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el("textarea", { text });
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      ta.remove();
    }
  }
  setStatus(note);
}
