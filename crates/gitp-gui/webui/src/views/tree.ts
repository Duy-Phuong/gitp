// A collapsible folder tree built from a flat, sorted list of file paths.
// Used by the commit detail's File Tree tab.

import { chevronIcon, el, statusBadge } from "../dom";

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
  // Optional: right-click a changed file (opens the changes-view context menu).
  onFileContextMenu?: (path: string, e: MouseEvent) => void;
  // Optional: path of the currently selected file, to highlight its row.
  selectedPath?: string;
  // Optional multi-select checkboxes (changes view). When `checkable`, each file
  // row gets a checkbox and each folder a tri-state one that toggles its whole
  // subtree. `onToggleCheck` receives the affected file paths and the new state.
  checkable?: boolean;
  checkedPaths?: Set<string>;
  onToggleCheck?: (paths: string[], checked: boolean) => void;
}

export function renderFileTree(host: HTMLElement, paths: string[], cb: FileTreeCallbacks): void {
  renderLevel(host, build(paths), 0, cb);
}

// A folder checkbox's state from its changed descendants: fully checked only
// when every one is checked, indeterminate (dash) when some but not all are.
export function folderCheckState(
  files: string[],
  checked: Set<string>,
): { checked: boolean; indeterminate: boolean } {
  const on = files.filter((p) => checked.has(p)).length;
  return { checked: on > 0 && on === files.length, indeterminate: on > 0 && on < files.length };
}

// A checkbox that stops its click/dblclick from reaching the row (which would
// select the file or toggle the folder). `indeterminate` renders the dash state.
function checkbox(checked: boolean, indeterminate: boolean, onChange: (checked: boolean) => void) {
  const box = el("input", { type: "checkbox", class: "tree-check" }) as HTMLInputElement;
  box.checked = checked;
  box.indeterminate = indeterminate;
  box.addEventListener("click", (e) => e.stopPropagation());
  box.addEventListener("dblclick", (e) => e.stopPropagation());
  box.addEventListener("change", () => onChange(box.checked));
  return box;
}

// The paths of all changed files beneath `node` (folders have a checkbox only
// over their changed descendants, matching the file rows that show one).
function changedFilesUnder(node: Node, cb: FileTreeCallbacks): string[] {
  const out: string[] = [];
  const walk = (n: Node) => {
    for (const c of n.children.values()) {
      if (c.isFile) {
        if (cb.statusOf(c.path)) out.push(c.path);
      } else walk(c);
    }
  };
  walk(node);
  return out;
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
      if (cb.checkable && status) {
        row.append(
          checkbox(cb.checkedPaths?.has(child.path) ?? false, false, (on) =>
            cb.onToggleCheck?.([child.path], on),
          ),
        );
      }
      row.append(
        status ? statusBadge(status) : el("span", { class: "tree-bullet" }),
      );
      row.append(el("span", { class: "tree-name", text: child.name }));
      if (status) {
        // Single-click must not rebuild this row (the caller updates only the
        // diff/selection), so the node survives and a native double-click fires
        // instantly — no artificial delay.
        row.addEventListener("click", () => cb.onFileClick(child.path));
        if (cb.onFileDblClick) row.addEventListener("dblclick", () => cb.onFileDblClick!(child.path));
        if (cb.onFileContextMenu) {
          row.addEventListener("contextmenu", (e) => cb.onFileContextMenu!(child.path, e));
        }
      }
      host.append(row);
    } else {
      const collapsed = cb.collapsed.has(child.path);
      // Collapse toggles only when the chevron is clicked, not the whole row.
      const chevron = el("span", { class: `tree-chevron${collapsed ? "" : " open"}` });
      chevron.append(chevronIcon());
      chevron.addEventListener("click", () => cb.onToggle(child.path));
      const row = el("div", { class: "tree-row tree-folder", title: child.path });
      row.style.paddingLeft = `${pad}px`;
      if (cb.checkable) {
        // A folder checkbox reflects and toggles its whole subtree of changed
        // files: empty / dash (some) / full.
        const files = changedFilesUnder(child, cb);
        const st = folderCheckState(files, cb.checkedPaths ?? new Set());
        row.append(
          checkbox(st.checked, st.indeterminate, (check) => cb.onToggleCheck?.(files, check)),
        );
      }
      row.append(chevron, el("span", { class: "tree-name", text: child.name }));
      host.append(row);
      if (!collapsed) renderLevel(host, child, depth + 1, cb);
    }
  }
}
