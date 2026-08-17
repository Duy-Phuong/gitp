// A collapsible folder tree built from a flat, sorted list of file paths.
// Used by the commit detail's File Tree tab.

import { el } from "../dom";

interface Node {
  name: string;
  path: string;
  isFile: boolean;
  children: Map<string, Node>;
}

export interface FileTreeCallbacks {
  // Folder paths currently collapsed (owned by the caller so it survives re-renders).
  collapsed: Set<string>;
  onToggle: (folderPath: string) => void;
  // Status label for a changed file (e.g. "Modified"), or null if unchanged.
  statusOf: (path: string) => string | null;
  onFileClick: (path: string) => void;
  // Optional: double-click a file (used to stage/unstage in the changes view).
  onFileDblClick?: (path: string) => void;
  // Optional: path of the currently selected file, to highlight its row.
  selectedPath?: string;
}

export function renderFileTree(host: HTMLElement, paths: string[], cb: FileTreeCallbacks): void {
  renderLevel(host, build(paths), 0, cb);
}

// Fold the flat "a/b/c.txt" paths into a nested node tree.
function build(paths: string[]): Node {
  const root: Node = { name: "", path: "", isFile: false, children: new Map() };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    let acc = "";
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: acc, isFile: i === parts.length - 1, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

function renderLevel(host: HTMLElement, node: Node, depth: number, cb: FileTreeCallbacks): void {
  // Folders first, then files, each alphabetical.
  const entries = [...node.children.values()].sort((a, b) =>
    a.isFile !== b.isFile ? (a.isFile ? 1 : -1) : a.name.localeCompare(b.name),
  );
  for (const child of entries) {
    const pad = 8 + depth * 14;
    if (child.isFile) {
      const status = cb.statusOf(child.path);
      const selected = cb.selectedPath === child.path;
      const row = el("div", {
        class: `tree-row tree-file${status ? " changed" : ""}${selected ? " selected" : ""}`,
        title: child.path,
      });
      row.style.paddingLeft = `${pad}px`;
      row.append(
        status
          ? el("span", { class: `status-badge status-${status}`, text: status[0] })
          : el("span", { class: "tree-bullet" }),
      );
      row.append(el("span", { class: "tree-name", text: child.name }));
      if (status) {
        // Single-click must not rebuild this row (the caller updates only the
        // diff/selection), so the node survives and a native double-click fires
        // instantly — no artificial delay.
        row.addEventListener("click", () => cb.onFileClick(child.path));
        if (cb.onFileDblClick) row.addEventListener("dblclick", () => cb.onFileDblClick!(child.path));
      }
      host.append(row);
    } else {
      const collapsed = cb.collapsed.has(child.path);
      // Collapse toggles only when the chevron is clicked, not the whole row.
      const chevron = el("span", {
        class: `tree-chevron${collapsed ? "" : " open"}`,
        text: collapsed ? "▸" : "▾",
      });
      chevron.addEventListener("click", () => cb.onToggle(child.path));
      const row = el("div", { class: "tree-row tree-folder", title: child.path }, [
        chevron,
        el("span", { class: "tree-name", text: child.name }),
      ]);
      row.style.paddingLeft = `${pad}px`;
      host.append(row);
      if (!collapsed) renderLevel(host, child, depth + 1, cb);
    }
  }
}
