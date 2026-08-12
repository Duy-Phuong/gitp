// Local Changes view: the uncommitted working-tree diffs, rendered with the
// same file/hunk components as commit detail.

import { clear, el } from "../dom";
import type { FileDiff } from "../types";
import { renderFile } from "./detail";

export function renderChanges(host: HTMLElement, files: FileDiff[]): void {
  clear(host);

  if (files.length === 0) {
    host.append(el("div", { class: "detail-empty", text: "No local changes — working tree is clean." }));
    return;
  }

  const count = files.length;
  host.append(
    el("h2", { class: "detail-summary", text: `Local Changes · ${count} file${count === 1 ? "" : "s"}` }),
  );
  for (const file of files) {
    host.append(renderFile(file));
  }
}
