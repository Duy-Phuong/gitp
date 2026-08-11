// Commit detail: metadata, message, and per-file diffs.

import { clear, el } from "../dom";
import type { CommitDetail, FileDiff } from "../types";

export function renderDetailEmpty(host: HTMLElement): void {
  clear(host);
  host.append(el("div", { class: "detail-empty", text: "Select a commit to view its changes." }));
}

export function renderDetail(host: HTMLElement, detail: CommitDetail): void {
  clear(host);

  host.append(el("h2", { class: "detail-summary", text: detail.summary }));

  const body = detail.message.split("\n").slice(1).join("\n").trim();
  if (body) host.append(el("div", { class: "detail-body", text: body }));

  const when = new Date(detail.author_time * 1000).toLocaleString();
  const meta = el("div", { class: "detail-meta" });
  meta.append(
    el("span", { text: `${detail.author_name} <${detail.author_email}>` }),
    el("span", { text: `  ·  ${when}  ·  ` }),
    el("span", { class: "sha", text: detail.id.slice(0, 10) }),
  );
  host.append(meta);

  if (detail.files.length === 0) {
    host.append(el("div", { class: "detail-empty", text: "No file changes." }));
    return;
  }
  for (const file of detail.files) {
    host.append(renderFile(file));
  }
}

function renderFile(file: FileDiff): HTMLElement {
  const container = el("div", { class: "file" });

  const head = el("div", { class: "file-head" });
  head.append(el("span", { class: `status-badge status-${file.status}`, text: file.status }));
  const label = file.old_path && file.old_path !== file.path
    ? `${file.old_path} → ${file.path}`
    : file.path;
  head.append(el("span", { text: label }));
  container.append(head);

  for (const hunk of file.hunks) {
    container.append(el("div", { class: "hunk-header", text: hunk.header }));
    for (const line of hunk.lines) {
      const cls =
        line.origin === "+" ? "diff-line add" : line.origin === "-" ? "diff-line del" : "diff-line";
      container.append(el("div", { class: cls, text: `${line.origin} ${line.content}` }));
    }
  }
  return container;
}
