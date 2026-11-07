// @vitest-environment happy-dom
// A refresh runs on any click (external-refresh.ts). When it brings nothing
// new, the views keep their rows, so a click in progress lands on the row it
// started on.
import { describe, expect, it } from "vitest";
import type { FileDiff, ReflogEntry } from "../types";
import { setupChanges, type ChangesCallbacks } from "./changes";
import { setupReflog, type ReflogCallbacks } from "./reflog";

const settle = () => new Promise((r) => setTimeout(r, 0));
// Every callback the test doesn't name does nothing.
const quiet = <T extends object>(given: Partial<T>) =>
  new Proxy(given, { get: (t, k: string) => (t as Record<string, unknown>)[k] ?? (() => Promise.resolve(undefined)) }) as T;

const file = (path: string): FileDiff => ({ path, old_path: null, status: "Modified", hunks: [] }) as unknown as FileDiff;

describe("an unchanged refresh", () => {
  it("keeps the Local Changes rows", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const status = { staged: [], unstaged: [file("a.txt"), file("b.txt")] };
    const view = setupChanges(host, quiet<ChangesCallbacks>({ fetchStatus: () => Promise.resolve(structuredClone(status)) }));
    view.applyStatus(structuredClone(status));
    await settle();
    const row = host.querySelector(".tree-row, .file-row");
    expect(row).not.toBeNull();
    view.applyStatus(structuredClone(status));
    expect(row!.isConnected).toBe(true);
    view.applyStatus({ staged: [], unstaged: [file("a.txt")] });
    expect(row!.isConnected).toBe(false);
    host.remove();
  });

  it("keeps the Reflog rows", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const entry: ReflogEntry = { index: 0, selector: "HEAD@{0}", new_id: "b", short_id: "b", old_id: "a", message: "commit: x", committer: "me", time: 1 } as ReflogEntry;
    const view = setupReflog(host, quiet<ReflogCallbacks>({ fetch: () => Promise.resolve([entry]) }));
    await view.reload();
    const row = host.querySelector("[class*=reflog-row], tr, li");
    expect(row).not.toBeNull();
    await view.reload();
    expect(row!.isConnected).toBe(true);
    host.remove();
  });
});
