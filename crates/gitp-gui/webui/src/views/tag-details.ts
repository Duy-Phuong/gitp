// Read-only "Show Tag Details" modal: what the tag is, who made it, and what it
// points at.
//
// A lightweight tag is only a ref, so it has no tagger and no message. Rather
// than showing empty fields, the modal says so — otherwise a blank Tagger row
// reads as missing data instead of the absence being the actual answer.

import { clear, el } from "../dom";
import type { TagDetail } from "../types";

export function openTagDetailsModal(name: string, load: Promise<TagDetail>): void {
  const overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal tag-details-modal" });
  overlay.append(modal);

  let closed = false;
  const close = () => {
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey, true);

  const body = el("div", { class: "tag-details-body" }, [
    el("div", { class: "tag-details-loading", text: "Loading tag…" }),
  ]);
  const closeBtn = el("button", { class: "btn", text: "Close" });
  closeBtn.addEventListener("click", close);

  modal.append(
    el("div", { class: "modal-title", text: name }),
    body,
    el("div", { class: "modal-actions" }, [el("span", { class: "spacer" }), closeBtn]),
  );
  document.body.append(overlay);
  requestAnimationFrame(() => closeBtn.focus());

  load
    .then((d) => {
      if (closed) return;
      clear(body);
      body.append(fields(d));
      if (d.message) {
        body.append(el("div", { class: "tag-details-message", text: d.message.trim() }));
      }
    })
    .catch((err) => {
      if (closed) return;
      clear(body);
      body.append(el("div", { class: "tag-details-loading", text: `Couldn't read the tag: ${String(err)}` }));
    });
}

function fields(d: TagDetail): HTMLElement {
  const rows = el("div", { class: "tag-details-grid" });
  const add = (label: string, value: string, cls = "") => {
    rows.append(
      el("span", { class: "tag-details-label", text: label }),
      el("span", { class: `tag-details-value ${cls}`.trim(), text: value }),
    );
  };

  add("Type", d.annotated ? "Annotated tag" : "Lightweight tag");
  if (d.annotated) {
    const who = [d.tagger_name, d.tagger_email && `<${d.tagger_email}>`].filter(Boolean).join(" ");
    if (who) add("Tagger", who);
    if (d.tagger_time != null) add("Tagged", new Date(d.tagger_time * 1000).toLocaleString());
  } else {
    // Say why the tagger/message rows aren't here, so their absence reads as
    // the answer rather than as a gap.
    add("Tagger", "— lightweight tags record no tagger or message");
  }
  add("Commit", d.target, "sha");
  if (d.target_summary) add("Subject", d.target_summary);
  return rows;
}
