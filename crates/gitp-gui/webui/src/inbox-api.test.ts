import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InboxRepo } from "./inbox";

type Handler = (e: { payload: { id: number; result: InboxRepo } }) => void;
const tauri = vi.hoisted(() => ({
  handler: null as null | ((e: { payload: unknown }) => void),
  unlisten: () => {},
  invoke: (_cmd: string, _args: Record<string, unknown>): Promise<unknown> => Promise.resolve([]),
}));
vi.mock("./api", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, cb: Handler) => {
    tauri.handler = cb as never;
    return () => tauri.unlisten();
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: Record<string, unknown>) => tauri.invoke(cmd, args) }));

import { loadInbox } from "./inbox-api";

const repo = (path: string): InboxRepo => ({ path, repo: "o/n", prs: [], error: null });

beforeEach(() => {
  tauri.unlisten = vi.fn();
});

describe("loadInbox", () => {
  it("hands each repository over as its event comes, ignoring other runs', and the late ones from the answer", async () => {
    const got: string[] = [];
    tauri.invoke = async (cmd, args) => {
      expect(cmd).toBe("inbox");
      expect(args.paths).toEqual(["/a", "/b", "/c"]);
      const id = args.id as number;
      tauri.handler!({ payload: { id, result: repo("/a") } });
      tauri.handler!({ payload: { id: id + 100, result: repo("/x") } });
      tauri.handler!({ payload: { id, result: repo("/b") } });
      return [repo("/a"), repo("/b"), repo("/c")];
    };
    await loadInbox(["/a", "/b", "/c"], (r) => got.push(r.path));
    expect(got).toEqual(["/a", "/b", "/c"]);
    expect(tauri.unlisten).toHaveBeenCalled();
  });

  it("stops listening when the call fails", async () => {
    tauri.invoke = async () => {
      throw new Error("boom");
    };
    await expect(loadInbox(["/a"], () => {})).rejects.toThrow("boom");
    expect(tauri.unlisten).toHaveBeenCalled();
  });
});
