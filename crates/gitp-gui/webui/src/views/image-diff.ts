// Image diff: the old and new versions of an image side by side, each with its
// pixel and byte size — where a text diff has nothing to show for a binary
// file. Shared by the commit detail and Local Changes, which each know where
// the two sides live (a revision, the index, the working tree). Each side
// loads on its own; it may be absent (an added or deleted file) or too big to
// preview.

import { el } from "../dom";
import type { FileContent } from "../types";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

// The image type of `path` by its extension, or null when it isn't an image
// the diff can show.
export function imageMime(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (MIME[name.slice(dot + 1).toLowerCase()] ?? null) : null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export type ImageLoad = () => Promise<FileContent | null>;

// A loader that fetches once and gives every later call the same result, so a
// repaint of the diff doesn't fetch the image again.
export function loadOnce(load: ImageLoad): ImageLoad {
  let pending: Promise<FileContent | null> | null = null;
  return () => (pending ??= load());
}

// `before` / `after` load each side, or are null when the file has no such
// side (added / deleted).
export function renderImageDiff(mime: string, before: ImageLoad | null, after: ImageLoad | null): HTMLElement {
  const wrap = el("div", { class: "image-diff" });
  if (before) wrap.append(imageSide(after ? "Before" : "Deleted", mime, before));
  if (after) wrap.append(imageSide(before ? "After" : "Added", mime, after));
  return wrap;
}

function imageSide(label: string, mime: string, load: ImageLoad): HTMLElement {
  const frame = el("div", { class: "image-frame" });
  const meta = el("div", { class: "image-meta", text: "Loading…" });
  load()
    .then((content) => {
      if (!content) {
        meta.textContent = "Not present";
        return;
      }
      const size = formatBytes(content.size);
      if (content.base64 === null) {
        meta.textContent = `${size} — too large to preview`;
        return;
      }
      // A data: URL — the CSP allows them for img-src (tauri.conf.json).
      const img = el("img", { alt: label, src: `data:${mime};base64,${content.base64}` });
      img.addEventListener("load", () => {
        meta.textContent = `${img.naturalWidth} × ${img.naturalHeight} px · ${size}`;
      });
      img.addEventListener("error", () => {
        img.remove();
        meta.textContent = `${size} — can't display (not an image, or a Git LFS pointer)`;
      });
      frame.append(img);
    })
    .catch((err) => {
      meta.textContent = `Can't load: ${String(err)}`;
    });
  return el("div", { class: "image-side" }, [el("div", { class: "image-label", text: label }), frame, meta]);
}
