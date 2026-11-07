// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DiffLine, FileDiff } from "../types";

const line = (origin: string, old_lineno: number | null, new_lineno: number | null, content: string): DiffLine => ({ origin, old_lineno, new_lineno, content });
const file: FileDiff = {
  path: "src/a.ts",
  old_path: null,
  status: "Modified",
  hunks: [{ header: "@@ -1,2 +1,3 @@", lines: [line(" ", 1, 1, "one"), line("+", null, 2, "two"), line(" ", 2, 3, "three")] }],
};

beforeEach(() => {
  vi.resetModules();
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

async function setup(over: { fixing?: number | null; moves?: FileDiff[] | null } = {}) {
  const reviews = await import("../pr-reviews");
  const branches = await import("../branch-reviews");
  const { setupBranchReviewView } = await import("./branch-review");
  const r = reviews.reviewFor("/repo", { branch: "feat" });
  reviews.addDrafts(r, [
    { path: "src/a.ts", line: 2, side: "RIGHT", body: "Two is wrong.", severity: "minor" },
    { path: "src/a.ts", line: 3, side: "RIGHT", body: "Three moved.", severity: null },
  ]);
  r.head = "aaaaaaa1";
  const s = branches.branchState("/repo", "feat");
  s.base = "main";
  s.fixing = over.fixing ?? null;
  // Line 3 of the reviewed head was changed since.
  const moves = over.moves !== undefined ? over.moves : [{ ...file, hunks: [{ header: "@@ -3 +3 @@", lines: [line("-", 3, null, "three"), line("+", null, 3, "3")] }] }];
  s.data = { review: null, head: "bbbbbbb2", base: "main", files: [file], moves, worktree: "/w", dirty: false };
  const host = document.createElement("div");
  document.body.append(host);
  const cb = {
    repoPath: () => "/repo",
    bases: () => ["main", "origin/main", "develop"],
    load: vi.fn(),
    run: vi.fn(),
    cancel: vi.fn(),
    fix: vi.fn(),
    openCommit: vi.fn(),
    clear: vi.fn(),
    changeBase: vi.fn(),
  };
  const view = setupBranchReviewView(host, cb);
  view.show("feat");
  return { host, cb, view, r };
}

const tab = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLElement>(".pr-tab")].find((b) => b.textContent?.startsWith(name))!;

describe("the branch Review panel", () => {
  it("lists the drafts and puts cards under their lines in the Files tab", async () => {
    const { host } = await setup();
    expect(host.textContent).toContain("Reviewed at aaaaaaa · now bbbbbbb");
    const cards = host.querySelectorAll(".pr-draft");
    expect(cards.length).toBe(2);
    expect(cards[1].textContent).toContain("line moved");
    tab(host, "Files").click();
    const inline = host.querySelectorAll(".pr-draft.inline");
    expect(inline.length, "the moved draft gets no card").toBe(1);
    expect((inline[0].previousElementSibling as HTMLElement).textContent).toContain("two");
  });

  it("turns Fix off with its reason while a fix runs, and runs it otherwise", async () => {
    let { host, cb } = await setup({ fixing: 9 });
    let fix = [...host.querySelectorAll("button")].find((b) => b.textContent === "Fix")!;
    expect(fix.disabled).toBe(true);
    expect(fix.title).toBe("A fix is running on feat");
    vi.resetModules();
    ({ host, cb } = await setup());
    const fixes = [...host.querySelectorAll("button")].filter((b) => b.textContent === "Fix");
    expect(fixes.map((b) => b.disabled)).toEqual([false, true]);
    fixes[0].click();
    expect(cb.fix).toHaveBeenCalledWith("feat", expect.objectContaining({ id: 1 }));
  });

  it("shows a draft in the diff from the list", async () => {
    const { host } = await setup();
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Show in diff")!.click();
    expect(tab(host, "Files").classList.contains("active")).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(scrolled).toHaveBeenCalled();
    expect(scrolled.mock.contexts[0]).toBe(host.querySelector('.pr-draft.inline[data-draft="1"]'));
  });

  it("changes the base from Against", async () => {
    const { host, cb } = await setup();
    const against = host.querySelector<HTMLSelectElement>("select.branch-review-against")!;
    expect([...against.options].map((o) => o.value)).toEqual(["main", "origin/main", "develop"]);
    against.value = "develop";
    against.dispatchEvent(new Event("change"));
    expect(cb.changeBase).toHaveBeenCalledWith("feat", "develop");
  });

  it("says when there is nothing to review", async () => {
    const { host, view } = await setup();
    const branches = await import("../branch-reviews");
    branches.branchState("/repo", "feat").data!.files = [];
    view.redraw();
    tab(host, "Files").click();
    expect(host.textContent).toContain("Nothing to review: feat has no changes against main.");
  });

  it("keeps its scroll when a card's Approve redraws it, and a tab switch starts at the top", async () => {
    const { host, view } = await setup();
    host.querySelector<HTMLElement>(".pr-body")!.scrollTop = 120;
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Approve")!.click();
    view.redraw(); // as main.ts does on every review change
    expect(host.querySelector<HTMLElement>(".pr-body")!.scrollTop).toBe(120);
    tab(host, "Files").click();
    expect(host.querySelector<HTMLElement>(".pr-body")!.scrollTop).toBe(0);
  });
});
