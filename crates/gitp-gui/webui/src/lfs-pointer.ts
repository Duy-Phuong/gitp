// A file stored with Git LFS. What git keeps for it is a small pointer —
//
//   version https://git-lfs.github.com/spec/v1
//   oid sha256:4d7a…
//   size 12345
//
// — so its diff is those lines. Recognised here so it can be shown as what it
// is, the content's id and size, rather than as a three-line text edit.

import { el } from "./dom";
import { formatBytes } from "./views/image-diff";
import type { FileDiff } from "./types";

export interface LfsPointer {
  oid: string;
  // Null when the diff doesn't show the size line (it was unchanged and
  // outside the context lines).
  size: number | null;
}

export interface LfsPointerChange {
  // Null for a file being added (from) or deleted (to).
  from: LfsPointer | null;
  to: LfsPointer | null;
}

const POINTER_LINE = /^(?:version https:\/\/git-lfs\.github\.com\/spec\/v1|oid sha256:([0-9a-f]{64})|size (\d+)|ext-\d+-\w+ sha256:[0-9a-f]{64})$/;

// The LFS pointers `file`'s diff is between, or null when it isn't a pointer
// file's diff.
export function parseLfsPointerDiff(file: FileDiff): LfsPointerChange | null {
  const lines = file.hunks.flatMap((h) => h.lines);
  const old: Partial<LfsPointer> = {};
  const now: Partial<LfsPointer> = {};
  let seen = false;
  for (const line of lines) {
    // git2's "no newline at end of file" markers carry no content of their own.
    if (line.origin !== "+" && line.origin !== "-" && line.origin !== " ") continue;
    const m = POINTER_LINE.exec(line.content);
    if (!m) return null;
    seen = true;
    const sides = line.origin === "-" ? [old] : line.origin === "+" ? [now] : [old, now];
    for (const side of sides) {
      if (m[1]) side.oid = m[1];
      if (m[2]) side.size = Number(m[2]);
    }
  }
  if (!seen) return null;
  const pointer = (p: Partial<LfsPointer>): LfsPointer | null => (p.oid ? { oid: p.oid, size: p.size ?? null } : null);
  const change = { from: pointer(old), to: pointer(now) };
  return change.from || change.to ? change : null;
}

// "sha256:4d7a1b2c3d4e… · 1.2 MB" for one side.
export function describeLfsPointer(p: LfsPointer): string {
  const size = p.size === null ? "" : ` · ${formatBytes(p.size)}`;
  return `sha256:${p.oid.slice(0, 12)}…${size}`;
}

// Shown in place of the diff: the file is in LFS, and which content each side
// points at.
export function lfsPointerPanel(path: string, c: LfsPointerChange): HTMLElement {
  const sides: [string, LfsPointer | null][] = [
    ["Before", c.from],
    ["After", c.to],
  ];
  return el("div", { class: "submodule-change" }, [
    el("div", { class: "submodule-change-title", text: `${path} is stored in Git LFS` }),
    ...sides
      .filter(([, p]) => p)
      .map(([label, p]) => el("div", { class: "submodule-change-ids", text: `${label}: ${describeLfsPointer(p!)}` })),
    el("div", {
      class: "submodule-change-note",
      text: "Git records a pointer to the content, not the content itself, so there is no text to compare.",
    }),
  ]);
}
