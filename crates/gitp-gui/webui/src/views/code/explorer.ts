// The Code tab's file tree: folders before files, case-insensitive, lazy —
// only an expanded folder's children are in the DOM. Gitignored paths never
// reach it (the backend's walk skipped them), so a build directory is simply
// absent, as an IDE's "excluded" folder.

import { clear, el } from "../../dom";
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
          class: `code-row${folder ? " folder" : " file"}${state.selected === child.path ? " selected" : ""}${open ? " open" : ""}`,
          "data-path": child.path,
          title: child.path,
          style: `--depth:${depth}`,
        },
        [el("span", { class: "code-row-chevron" }, [folder ? (open ? "▾" : "▸") : ""]), el("span", { class: "code-row-name" }, [child.name])],
      );
      row.addEventListener("click", () => (folder ? cb.toggle(child.path) : cb.open(child.path)));
      frag.append(row);
      if (open) walk(child, depth + 1);
    }
  };
  walk(tree, 0);
  host.append(frag);
}
