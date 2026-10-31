// The Local History view: the snapshots gitp took of the working tree as it
// changed, newest first, each with the files that were uncommitted in it.
// Open a snapshot to see those files; a file's version can be viewed or put
// back on disk, which Undo reverses. This is the safety net for an edit that
// was never committed and then lost — overwritten, discarded, deleted, or
// gone with a crash.

import { clear, el, statusBadge } from "../dom";
import { fullTime, relativeTime } from "../timeago";
import type { FileVersion, Snapshot, SnapshotFile } from "../types";

export interface LocalHistoryCallbacks {
  fetch: () => Promise<Snapshot[]>;
  versions: (path: string) => Promise<FileVersion[]>;
  // The text of a file in a snapshot, for the viewer.
  content: (snapshot: string, path: string) => Promise<string>;
  // Writes the version to disk after the user confirms; true once done.
  restore: (snapshot: string, path: string) => Promise<boolean>;
  snapshotNow: () => Promise<string | null>;
  clear: () => Promise<boolean>;
  reportError: (title: string, err: unknown) => void;
}

export interface LocalHistoryHandle {
  // Load the snapshots and show them.
  start: () => void;
  stop: () => void;
  // Forget them — they belong to the repository being switched away from.
  reset: () => void;
  // Show one file's versions across the snapshots.
  showFile: (path: string) => void;
}

/// The status badge of a snapshot file, from git's letter.
export function statusOf(file: SnapshotFile): string {
  switch (file.status) {
    case "A":
      return "Added";
    case "D":
      return "Deleted";
    case "R":
      return "Renamed";
    default:
      return "Modified";
  }
}

/// One line for a snapshot: how many files, and the kinds. Exported for its test.
export function snapshotSummary(s: Snapshot): string {
  const n = s.files.length;
  if (n === 0) return "No uncommitted files";
  const counts = new Map<string, number>();
  for (const f of s.files) counts.set(f.status, (counts.get(f.status) ?? 0) + 1);
  const parts = [
    ["M", "modified"],
    ["A", "new"],
    ["D", "deleted"],
    ["R", "renamed"],
  ]
    .filter(([k]) => counts.has(k))
    .map(([k, label]) => `${counts.get(k)} ${label}`);
  return `${n} file${n === 1 ? "" : "s"} · ${parts.join(", ")}`;
}

export function setupLocalHistory(host: HTMLElement, cb: LocalHistoryCallbacks): LocalHistoryHandle {
  let snapshots: Snapshot[] = [];
  const open = new Set<string>();
  // The file whose versions are shown instead of the snapshot list.
  let fileView: { path: string; versions: FileVersion[] | null } | null = null;
  let generation = 0;

  const snapshotBtn = el("button", { class: "btn small ghost", text: "Snapshot Now", title: "Take a snapshot of the working tree as it is" });
  snapshotBtn.addEventListener("click", () => {
    void cb.snapshotNow().then(
      (id) => {
        if (id) void load();
      },
      (err) => cb.reportError("Couldn't take a snapshot", err),
    );
  });
  const clearBtn = el("button", { class: "btn small ghost", text: "Clear", title: "Delete every snapshot of this repository" });
  clearBtn.addEventListener("click", () => {
    void cb.clear().then((ok) => {
      if (ok) {
        snapshots = [];
        open.clear();
        render();
      }
    });
  });
  const title = el("span", { class: "reflog-title", text: "Local History" });
  const back = el("button", { class: "btn small ghost hidden", text: "← All snapshots" });
  back.addEventListener("click", () => {
    fileView = null;
    render();
  });
  const list = el("div", { class: "lh-list" });
  host.append(el("div", { class: "log-toolbar" }, [back, title, el("span", { class: "spacer" }), snapshotBtn, clearBtn]), list);

  async function load(): Promise<void> {
    const mine = ++generation;
    try {
      const loaded = await cb.fetch();
      if (mine !== generation) return;
      snapshots = loaded;
      render();
    } catch (err) {
      if (mine !== generation) return;
      cb.reportError("Couldn't read the local history", err);
    }
  }

  function render(): void {
    clear(list);
    back.classList.toggle("hidden", !fileView);
    title.textContent = fileView ? `Versions of ${fileView.path}` : "Local History";
    if (fileView) return renderFile(fileView);
    if (!snapshots.length) {
      list.append(
        el("div", {
          class: "detail-empty",
          text: "No snapshots yet. gitp snapshots the working tree about twenty seconds after files change, so an edit that is overwritten, discarded or lost can be brought back from here.",
        }),
      );
      return;
    }
    for (const s of snapshots) list.append(snapshotRow(s));
  }

  function snapshotRow(s: Snapshot): HTMLElement {
    const isOpen = open.has(s.id);
    const head = el("div", { class: "lh-head" }, [
      el("span", { class: `lh-chevron${isOpen ? " open" : ""}`, text: "▸" }),
      el("span", { class: "lh-time", text: relativeTime(s.time / 1000), title: fullTime(s.time / 1000) }),
      el("span", { class: "lh-summary", text: snapshotSummary(s) }),
      el("code", { class: "lh-head-sha", text: s.head.slice(0, 7), title: `HEAD was ${s.head} when this snapshot was taken` }),
    ]);
    head.addEventListener("click", () => {
      if (open.has(s.id)) open.delete(s.id);
      else open.add(s.id);
      render();
    });
    const row = el("div", { class: `lh-row${isOpen ? " open" : ""}` }, [head]);
    if (isOpen) {
      const files = el("div", { class: "lh-files" });
      for (const f of s.files) files.append(fileRow(s, f));
      row.append(files);
    }
    return row;
  }

  function fileRow(s: Snapshot, f: SnapshotFile): HTMLElement {
    const row = el("div", { class: "lh-file" }, [
      statusBadge(statusOf(f)),
      el("span", { class: "lh-path", text: f.from ? `${f.from} → ${f.path}` : f.path }),
      el("span", { class: "spacer" }),
    ]);
    if (f.status !== "D") {
      row.append(
        smallButton("View", () => void showContent(s.id, f.path)),
        smallButton("Restore", () => void cb.restore(s.id, f.path)),
      );
    }
    row.append(smallButton("Versions", () => showFile(f.path)));
    return row;
  }

  function renderFile(view: { path: string; versions: FileVersion[] | null }): void {
    if (!view.versions) {
      list.append(el("div", { class: "detail-empty", text: "Loading versions…" }));
      return;
    }
    if (!view.versions.length) {
      list.append(el("div", { class: "detail-empty", text: `No snapshot holds a version of ${view.path} that differs from a commit.` }));
      return;
    }
    for (const v of view.versions) {
      list.append(
        el("div", { class: "lh-version" }, [
          el("span", { class: "lh-time", text: relativeTime(v.time / 1000), title: fullTime(v.time / 1000) }),
          el("span", { class: "lh-size", text: `${v.size} bytes` }),
          el("span", { class: "spacer" }),
          smallButton("View", () => void showContent(v.snapshot, view.path)),
          smallButton("Restore", () => void cb.restore(v.snapshot, view.path)),
        ]),
      );
    }
  }

  async function showContent(snapshot: string, path: string): Promise<void> {
    try {
      const text = await cb.content(snapshot, path);
      const overlay = el("div", { class: "modal-overlay" });
      const close = el("button", { class: "btn", text: "Close" });
      const restore = el("button", { class: "btn commit-btn", text: "Restore this version" });
      const modal = el("div", { class: "modal lh-viewer", role: "dialog", "aria-label": `${path} in a snapshot` }, [
        el("div", { class: "modal-title", text: path }),
        el("pre", { class: "lh-content", text }),
        el("div", { class: "modal-actions" }, [close, restore]),
      ]);
      overlay.append(modal);
      const dismiss = () => overlay.remove();
      close.addEventListener("click", dismiss);
      restore.addEventListener("click", () => {
        dismiss();
        void cb.restore(snapshot, path);
      });
      overlay.addEventListener("mousedown", (e) => {
        if (e.target === overlay) dismiss();
      });
      document.body.append(overlay);
      close.focus();
    } catch (err) {
      cb.reportError(`Couldn't read ${path} from the snapshot`, err);
    }
  }

  function showFile(path: string): void {
    fileView = { path, versions: null };
    render();
    const mine = ++generation;
    void cb.versions(path).then(
      (versions) => {
        if (mine !== generation || !fileView || fileView.path !== path) return;
        fileView = { path, versions };
        render();
      },
      (err) => cb.reportError(`Couldn't read the versions of ${path}`, err),
    );
  }

  function smallButton(text: string, onClick: () => void): HTMLElement {
    const b = el("button", { class: "btn small ghost", text });
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  return {
    start: () => void load(),
    stop: () => {
      generation++;
    },
    reset: () => {
      generation++;
      snapshots = [];
      open.clear();
      fileView = null;
      clear(list);
    },
    showFile: (path) => {
      showFile(path);
    },
  };
}
