// Local workspaces: named groups of repository folders, for the Workspaces
// screen (views/workspaces.ts). Not the "workspace" of prefs.ts's
// saveWorkspace, which is the set of open tabs.
//
// Kept in localStorage like the recent and favorite repos. The list is edited
// through the pure `with…` helpers, which return a new list, then saved whole.

import type { RepoSummary } from "./types";

export interface LocalWorkspace {
  name: string;
  // Absolute folder paths, in the order they were added.
  repos: string[];
}

const LOCAL_WORKSPACES_KEY = "gitp-workspaces";

export function loadLocalWorkspaces(): LocalWorkspace[] {
  return parseLocalWorkspaces(localStorage.getItem(LOCAL_WORKSPACES_KEY));
}

export function saveLocalWorkspaces(list: LocalWorkspace[]): void {
  localStorage.setItem(LOCAL_WORKSPACES_KEY, JSON.stringify(list));
}

// Whatever is stored, as a well-formed list: entries without a name are
// dropped, and so is anything in `repos` that isn't a path.
export function parseLocalWorkspaces(raw: string | null): LocalWorkspace[] {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((w: unknown) => {
    const { name, repos } = (w ?? {}) as { name?: unknown; repos?: unknown };
    if (typeof name !== "string" || !name) return [];
    const paths = Array.isArray(repos) ? repos.filter((p): p is string => typeof p === "string") : [];
    return [{ name, repos: paths }];
  });
}

// Why `name` can't name a workspace (empty, or another one's name), or null.
// `current` is the workspace being renamed, which may keep its own name.
export function workspaceNameError(list: LocalWorkspace[], name: string, current?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "A workspace needs a name.";
  if (trimmed !== current && list.some((w) => w.name === trimmed)) return `There is already a workspace called ${trimmed}.`;
  return null;
}

export function withWorkspaceAdded(list: LocalWorkspace[], name: string): LocalWorkspace[] {
  return [...list, { name: name.trim(), repos: [] }];
}

export function withWorkspaceRenamed(list: LocalWorkspace[], from: string, to: string): LocalWorkspace[] {
  return list.map((w) => (w.name === from ? { ...w, name: to.trim() } : w));
}

export function withWorkspaceDeleted(list: LocalWorkspace[], name: string): LocalWorkspace[] {
  return list.filter((w) => w.name !== name);
}

// Append `paths` to workspace `name`, skipping any it already has.
export function withReposAdded(list: LocalWorkspace[], name: string, paths: string[]): LocalWorkspace[] {
  return list.map((w) => {
    if (w.name !== name) return w;
    const repos = [...w.repos];
    for (const p of paths) if (!repos.includes(p)) repos.push(p);
    return { ...w, repos };
  });
}

export function withReposRemoved(list: LocalWorkspace[], name: string, paths: string[]): LocalWorkspace[] {
  return list.map((w) => (w.name === name ? { ...w, repos: w.repos.filter((p) => !paths.includes(p)) } : w));
}

// Point a missing repo at the folder it was moved to (Locate…), in place. If
// the new folder is already in the workspace the old entry simply goes.
export function withRepoMoved(list: LocalWorkspace[], name: string, from: string, to: string): LocalWorkspace[] {
  return list.map((w) => {
    if (w.name !== name) return w;
    const repos = w.repos.includes(to) ? w.repos.filter((p) => p !== from) : w.repos.map((p) => (p === from ? to : p));
    return { ...w, repos };
  });
}

// The folder's own name, as a repo tab shows it.
export function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

// A row's name: the folder's, or "<repo> · <worktree folder>" for a linked
// worktree, so it reads as part of its repository.
export function repoLabel(path: string, worktreeOf: string | null | undefined): string {
  return worktreeOf ? `${folderName(worktreeOf)} · ${folderName(path)}` : folderName(path);
}

// `paths` grouped by the repository they belong to (the same `commonDir`), in
// order of first appearance; a path whose common dir isn't known is a group of
// its own. Worktrees share their repository's objects and remote-tracking
// refs, so a bulk fetch fetches each group once, from its first path.
export function groupBySharedRepo(paths: string[], commonDir: (path: string) => string | undefined): string[][] {
  const groups: string[][] = [];
  const byDir = new Map<string, string[]>();
  for (const p of paths) {
    const dir = commonDir(p);
    const group = dir ? byDir.get(dir) : undefined;
    if (group) {
      group.push(p);
      continue;
    }
    const fresh = [p];
    groups.push(fresh);
    if (dir) byDir.set(dir, fresh);
  }
  return groups;
}

// A repo's state in a few characters: "↑2 ↓1 · 3 changed", "in sync",
// "no upstream".
export function summaryText(s: RepoSummary): string {
  if (s.missing) return "missing";
  const parts: string[] = [];
  if (!s.has_upstream) parts.push("no upstream");
  else if (s.ahead || s.behind) parts.push([s.ahead ? `↑${s.ahead}` : "", s.behind ? `↓${s.behind}` : ""].filter(Boolean).join(" "));
  else parts.push("in sync");
  if (s.changes) parts.push(`${s.changes} changed`);
  return parts.join(" · ");
}

// Run `worker` over `items`, at most `limit` at a time, in order. Once
// `stopped()` turns true no further item starts (the running ones finish or
// are cancelled by the caller). Resolves when every started item has settled;
// a worker's rejection is its own business and doesn't stop the others.
export async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  stopped: () => boolean = () => false,
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length && !stopped()) {
      const item = items[next++];
      try {
        await worker(item);
      } catch {
        // reported by the worker
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}
