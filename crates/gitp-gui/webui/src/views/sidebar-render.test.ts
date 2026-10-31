// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { renderSidebar, type SidebarCallbacks, type SidebarState } from "./sidebar";
import type { BranchRef, PullRequest } from "../types";

const pr = (number: number, title: string, author = "octocat", head = "feature/x"): PullRequest => ({
  number,
  title,
  author,
  is_draft: false,
  review_decision: null,
  checks: null,
  head,
  base: "main",
  updated_at: "",
  url: "",
  labels: [],
});

const branch = (name: string): BranchRef =>
  ({ name, target: "abc", is_head: false, upstream: null, ahead: 0, behind: 0, has_upstream: false }) as unknown as BranchRef;

const state = (open: number | null, query = ""): SidebarState => ({
  refs: { head: null, branches: [branch("main"), branch("date-fix")], remotes: [], tags: [], stashes: [], recent: [] },
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
  prs: {
    repoPath: "/app",
    repo: "o/app",
    account: { installed: true, signed_in: true, login: "me", scopes: [], message: null },
    filter: "all",
    list: [pr(42, "Retry the identity check"), pr(39, "Fix the date format", "hubot", "fix/dates")],
    loading: false,
    error: null,
    open,
    query,
  },
});

// Every callback a no-op but those a test records.
const callbacks = (over: Partial<SidebarCallbacks> = {}) =>
  new Proxy(over, { get: (o, k: string) => (o as Record<string, unknown>)[k] ?? (() => {}) }) as SidebarCallbacks;

const prRows = (host: HTMLElement) => [...host.querySelectorAll(".sb-pr .sb-leaf-label")].map((l) => l.textContent);

describe("renderSidebar", () => {
  it("keeps the list where it was scrolled to when it is drawn again", () => {
    // Opening a pull request highlights its row, which redraws the sidebar:
    // the list must not jump back to the top.
    const host = document.createElement("div");
    renderSidebar(host, state(null), callbacks());
    host.querySelector<HTMLElement>(".sb-tree")!.scrollTop = 384;

    renderSidebar(host, state(7), callbacks());

    expect(host.querySelector<HTMLElement>(".sb-tree")!.scrollTop).toBe(384);
  });

  it("searches the pull requests by number, title, author or branch, leaving the rest of the list alone", () => {
    const host = document.createElement("div");
    const typed: string[] = [];
    renderSidebar(host, state(null), callbacks({ onPrSearch: (text) => typed.push(text) }));
    const search = host.querySelector<HTMLInputElement>(".sb-pr-search")!;
    search.value = "date";
    search.dispatchEvent(new Event("input"));
    expect(typed).toEqual(["date"]);

    for (const [query, want] of [
      ["date", ["#39 Fix the date format"]],
      ["42", ["#42 Retry the identity check"]],
      ["#39", ["#39 Fix the date format"]],
      ["HUBOT", ["#39 Fix the date format"]],
      ["fix/dates", ["#39 Fix the date format"]],
      ["", ["#42 Retry the identity check", "#39 Fix the date format"]],
    ] as const) {
      renderSidebar(host, state(null, query), callbacks());
      expect(prRows(host), query).toEqual(want);
    }
    // The branches aren't filtered by it: "date" matches one, "42" none.
    renderSidebar(host, state(null, "42"), callbacks());
    expect(host.textContent).toContain("date-fix");
    expect(host.querySelector<HTMLInputElement>(".sb-pr-search")!.value).toBe("42");
  });

  it("offers to open a number the list doesn't have, closed or merged ones included", () => {
    const host = document.createElement("div");
    const opened: number[] = [];
    renderSidebar(host, state(null, "#3531"), callbacks({ onPrOpenNumber: (n) => opened.push(n) }));
    const open = host.querySelector<HTMLElement>(".sb-pr-open")!;
    expect(open.textContent).toContain("Open #3531");
    expect(host.textContent).not.toContain("No matches");
    open.click();
    expect(opened).toEqual([3531]);

    renderSidebar(host, state(null, "42"), callbacks());
    expect(host.querySelector(".sb-pr-open")).toBeNull();
    renderSidebar(host, state(null, "retry 2"), callbacks());
    expect(host.querySelector(".sb-pr-open")).toBeNull();
  });

  it("keeps typing in the search box when the sidebar is drawn again", () => {
    const host = document.createElement("div");
    document.body.append(host);
    renderSidebar(host, state(null, "da"), callbacks());
    host.querySelector<HTMLInputElement>(".sb-pr-search")!.focus();
    renderSidebar(host, state(null, "dat"), callbacks());
    expect(document.activeElement).toBe(host.querySelector(".sb-pr-search"));
    host.remove();
  });
});
