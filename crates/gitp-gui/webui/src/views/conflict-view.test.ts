// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConflictSides, ConflictStatus } from "../types";
import { setupConflict, type ConflictCallbacks } from "./conflict";

const STATUS: ConflictStatus = {
  kind: "rebase",
  summary: "Rebasing dev",
  conflicted: ["a.txt"],
  message: "",
  ours_label: "main (rebasing onto)",
  theirs_label: 'your commit abc1234 "fix"',
  step: 2,
  steps: 5,
  clean: [],
};
// One conflict (line 2) and one change only theirs made (line 4).
const SIDES: ConflictSides = {
  base: "a\nbase\nc\nd\n",
  ours: "a\nours\nc\nd\n",
  theirs: "a\ntheirs\nc\nD\n",
  working: "",
  binary: false,
  edited: false,
};

function callbacks(over: Partial<ConflictCallbacks> = {}): ConflictCallbacks {
  return {
    fetchStatus: () => Promise.resolve(structuredClone(STATUS)),
    fetchSides: () => Promise.resolve(SIDES),
    fetchSideCommits: () => Promise.resolve({ ours: [], theirs: [] }),
    suggest: () => Promise.resolve('{"resolutions":[{"id":1,"lines":["both"],"why":"keeps both"}]}'),
    rerere: { get: () => Promise.resolve(false), set: () => Promise.resolve() },
    resolve: () => Promise.resolve(),
    resolveSide: () => Promise.resolve(),
    openInEditor: () => Promise.resolve(),
    openInMergeTool: () => {},
    abort: () => Promise.resolve(""),
    finish: () => Promise.resolve(""),
    confirm: () => Promise.resolve(true),
    setStatus: () => {},
    reportDone: () => {},
    reportError: () => {},
    onDone: () => {},
    ...over,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const text = (host: HTMLElement) => host.textContent ?? "";
const key = (k: string, opts: KeyboardEventInit = {}) =>
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...opts }));

async function open(over: Partial<ConflictCallbacks> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  // happy-dom lays nothing out; the keys need the view to look visible.
  Object.defineProperty(host, "offsetParent", { get: () => document.body });
  const view = setupConflict(host, callbacks(over));
  await view.reload();
  await settle();
  return host;
}

describe("the conflict resolver", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("names the sides, the rebase swap and its progress", async () => {
    const host = await open();
    expect(text(host)).toContain("Commit 2 of 5");
    expect(text(host)).toContain("git swaps the sides");
    expect(text(host)).toContain("Ours · main (rebasing onto)");
    expect(text(host)).toContain('Theirs · your commit abc1234 "fix"');
  });

  it("takes theirs with ] and moves to the next undecided change", async () => {
    const host = await open();
    key("]");
    expect(text(host)).toContain("1 unresolved");
    key("[");
    expect(text(host)).toContain("all 2 resolved");
  });

  it("saves with ⌘S once every change is decided", async () => {
    const resolve = vi.fn(() => Promise.resolve());
    await open({ resolve });
    key("]");
    key("]");
    key("s", { metaKey: true });
    await settle();
    expect(resolve).toHaveBeenCalledWith("a.txt", "a\ntheirs\nc\nD\n");
  });

  it("fills Claude's proposals in purple and keeps Save to the user", async () => {
    const suggest = vi.fn(() => Promise.resolve('{"resolutions":[{"id":1,"lines":["both"],"why":"keeps both"}]}'));
    const host = await open({ suggest });
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Suggest with Claude"))!;
    btn.click();
    await settle();
    await settle();
    expect(suggest).toHaveBeenCalledOnce();
    const purple = host.querySelector(".cf-claude");
    expect(purple?.textContent).toContain("both");
    expect(purple?.getAttribute("title")).toBe("Claude: keeps both");
    expect(text(host)).toContain("Claude resolved 1 conflict");
    expect(text(host)).toContain("1 unresolved"); // the non-conflicting change is still the user's
  });

  it("offers to mark a file resolved when no markers are left on disk", async () => {
    const host = await open({ fetchStatus: () => Promise.resolve({ ...STATUS, clean: ["a.txt"] }) });
    expect(text(host)).toContain("no conflict markers left on disk");
  });

  it("shows the rerere switch with its current state", async () => {
    const host = await open({ rerere: { get: () => Promise.resolve(true), set: () => Promise.resolve() } });
    const box = host.querySelector<HTMLInputElement>(".conflict-rerere input");
    expect(box?.checked).toBe(true);
  });
});

describe("a refresh with nothing new", () => {
  it("keeps the rows under the pointer, so a click in progress lands", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const view = setupConflict(host, callbacks());
    await view.reload();
    await settle();
    const row = host.querySelector(".conflict-file");
    await view.reload();
    expect(row?.isConnected).toBe(true);
    document.body.innerHTML = "";
  });
});
