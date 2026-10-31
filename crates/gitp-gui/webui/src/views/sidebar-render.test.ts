// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { renderSidebar, type SidebarCallbacks, type SidebarState } from "./sidebar";

const state = (open: number | null): SidebarState => ({
  refs: { head: null, branches: [], remotes: [], tags: [], stashes: [], recent: [] },
  localChanges: 0,
  repoName: "app",
  activeView: "pr",
  filter: "",
  collapsed: new Set(),
  branchSelection: new Set(),
  branchSelectionAnchor: null,
  busyRefs: new Set(),
  worktrees: [],
  worktreeSummaries: [],
  submodules: [],
  remoteList: [],
  pinned: null,
  visibility: { hidden: new Set(), solo: new Set() },
  prs: { repoPath: "/app", repo: "o/app", account: null, filter: "all", list: [], loading: false, error: null, open },
});

// Every callback a no-op: rendering is all this looks at.
const callbacks = new Proxy({}, { get: () => () => {} }) as SidebarCallbacks;

describe("renderSidebar", () => {
  it("keeps the list where it was scrolled to when it is drawn again", () => {
    // Opening a pull request highlights its row, which redraws the sidebar:
    // the list must not jump back to the top.
    const host = document.createElement("div");
    renderSidebar(host, state(null), callbacks);
    host.querySelector<HTMLElement>(".sb-tree")!.scrollTop = 384;

    renderSidebar(host, state(7), callbacks);

    expect(host.querySelector<HTMLElement>(".sb-tree")!.scrollTop).toBe(384);
  });
});
