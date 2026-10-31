// The Code tab's file tree: folders before files, case-insensitive, lazy —
// only an expanded folder's children are in the DOM. Gitignored paths never
// reach it (the backend's walk skipped them), so a build directory is simply
// absent, as an IDE's "excluded" folder.

import { chevronIcon, clear, el } from "../../dom";
import type { FileEntry, Lang } from "../../types";

export interface TreeNode {
  name: string;
  path: string;
  lang: Lang | null;
  // Folders have children; files don't.
  children?: TreeNode[];
}

export interface ExplorerState {
  expanded: Set<string>;
  selected: string | null;
}

export interface ExplorerCallbacks {
  open: (path: string) => void;
  toggle: (path: string) => void;
}

export function buildTree(files: FileEntry[]): TreeNode {
  const root: TreeNode = { name: "", path: "", lang: null, children: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = node.children!.find((c) => c.path === path && c.children);
      if (!next) {
        next = { name: parts[i], path, lang: null, children: [] };
        node.children!.push(next);
      }
      node = next;
    }
    node.children!.push({ name: parts[parts.length - 1], path: f.path, lang: f.lang });
  }
  sortTree(root);
  return root;
}

function sortTree(node: TreeNode): void {
  if (!node.children) return;
  node.children.sort((a, b) => {
    const folder = Number(!!b.children) - Number(!!a.children);
    return folder || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
  for (const c of node.children) sortTree(c);
}

/// Expand every ancestor of `path` and select it.
export function revealPath(state: ExplorerState, path: string): void {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) state.expanded.add(parts.slice(0, i).join("/"));
  state.selected = path;
}

/// Arrow keys move the selection over the visible rows without opening
/// anything; Right/Left expand/collapse or step in/out a level, Enter opens
/// a file or toggles a folder. Mutates `state`; the caller re-renders.
export function explorerKey(tree: TreeNode, state: ExplorerState, key: string): "ignored" | "moved" | { open: string } {
  if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Enter"].includes(key)) return "ignored";
  const rows: { node: TreeNode; parent: TreeNode | null }[] = [];
  const walk = (node: TreeNode, parent: TreeNode | null) => {
    for (const child of node.children ?? []) {
      rows.push({ node: child, parent });
      if (child.children && state.expanded.has(child.path)) walk(child, child);
    }
  };
  walk(tree, null);
  if (!rows.length) return "ignored";
  const i = rows.findIndex((r) => r.node.path === state.selected);
  if (i < 0) {
    state.selected = rows[0].node.path;
    return "moved";
  }
  const { node, parent } = rows[i];
  const open = !!node.children && state.expanded.has(node.path);
  switch (key) {
    case "ArrowDown":
      state.selected = rows[Math.min(i + 1, rows.length - 1)].node.path;
      break;
    case "ArrowUp":
      state.selected = rows[Math.max(i - 1, 0)].node.path;
      break;
    case "ArrowRight":
      if (!node.children) break;
      if (!open) state.expanded.add(node.path);
      else if (node.children.length) state.selected = node.children[0].path;
      break;
    case "ArrowLeft":
      if (open) state.expanded.delete(node.path);
      else if (parent) state.selected = parent.path;
      break;
    case "Enter":
      if (!node.children) return { open: node.path };
      if (!state.expanded.delete(node.path)) state.expanded.add(node.path);
      break;
  }
  return "moved";
}

export function renderExplorer(host: HTMLElement, tree: TreeNode, state: ExplorerState, cb: ExplorerCallbacks): void {
  clear(host);
  const frag = document.createDocumentFragment();
  const walk = (node: TreeNode, depth: number) => {
    for (const child of node.children ?? []) {
      const folder = !!child.children;
      const open = folder && state.expanded.has(child.path);
      const row = el(
        "div",
        {
          class: `code-row${folder ? " code-row-folder" : " code-row-file"}${state.selected === child.path ? " selected" : ""}${open ? " open" : ""}`,
          "data-path": child.path,
          title: child.path,
          style: `--depth:${depth}`,
        },
        [el("span", { class: "code-row-chevron" }, folder ? [chevronIcon()] : []), el("span", { class: "code-row-name" }, [child.name])],
      );
      row.addEventListener("click", () => (folder ? cb.toggle(child.path) : cb.open(child.path)));
      frag.append(row);
      if (open) walk(child, depth + 1);
    }
  };
  walk(tree, 0);
  host.append(frag);
}
