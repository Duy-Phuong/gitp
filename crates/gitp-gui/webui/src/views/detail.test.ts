// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { compareImageSides, signatureText } from "./detail";
import type { CommitSignature, CompareEnd, Comparison } from "../types";

function sig(over: Partial<CommitSignature>): CommitSignature {
  return { status: "Good", signer: "", key: "", detail: "", ...over };
}

describe("signatureText", () => {
  it("names the signer and key of a verified signature", () => {
    const t = signatureText(sig({ signer: "ada@example.com", key: "SHA256:abc" }));
    expect(t.label).toBe("Verified");
    expect(t.who).toBe("ada@example.com · SHA256:abc");
    expect(t.title).toBe(t.who);
  });

  it("explains an unverifiable signature with git's reason", () => {
    const t = signatureText(sig({ status: "Unverifiable", detail: "error: cannot run gpg" }));
    expect(t.label).toBe("Signed (can't verify)");
    expect(t.who).toBe("");
    expect(t.title).toBe("error: cannot run gpg");
  });

  it("shows just the key when git can't name the signer", () => {
    const t = signatureText(sig({ status: "UnknownKey", key: "SHA256:xyz" }));
    expect(t.label).toBe("Unknown key");
    expect(t.who).toBe("SHA256:xyz");
  });
});

describe("compareImageSides", () => {
  const commit = (id: string): CompareEnd => ({ rev: id, id, short_id: id.slice(0, 7), summary: "" });
  const workdir: CompareEnd = { rev: "Working Directory", id: "", short_id: "", summary: "" };
  const empty: CompareEnd = { rev: "Empty Tree", id: "", short_id: "", summary: "" };
  const cmp = (base: CompareEnd, head: CompareEnd, three_dot = false, merge_base: string | null = null): Comparison => ({
    base,
    head,
    three_dot,
    merge_base,
    ahead: 0,
    behind: 0,
    files: [],
  });

  it("reads each commit's tree, or the merge base's for three-dot", () => {
    expect(compareImageSides(cmp(commit("aaa"), commit("bbb")))).toEqual([{ Rev: "aaa" }, { Rev: "bbb" }]);
    expect(compareImageSides(cmp(commit("aaa"), commit("bbb"), true, "mmm"))).toEqual([{ Rev: "mmm" }, { Rev: "bbb" }]);
  });

  it("reads the working directory's side from the files on disk", () => {
    expect(compareImageSides(cmp(commit("aaa"), workdir))).toEqual([{ Rev: "aaa" }, "WorkTree"]);
    expect(compareImageSides(cmp(workdir, commit("bbb")))).toEqual(["WorkTree", { Rev: "bbb" }]);
  });

  it("has nothing to read on an empty tree's side", () => {
    expect(compareImageSides(cmp(empty, commit("bbb")))).toEqual([null, { Rev: "bbb" }]);
  });
});

describe("blockActions", () => {
  // @vitest-environment happy-dom
  it("copies the added lines of a change, or the removed ones of a pure deletion", async () => {
    const { vi } = await import("vitest");
    const { blockActions, renderFile } = await import("./detail");
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async (t: string) => void written.push(t)) }, configurable: true });
    const line = (origin: string, content: string) => ({ origin, old_lineno: 1, new_lineno: 1, content });
    const old = line("-", "old");
    const n1 = line("+", "new 1");
    const n2 = line("+", "new 2");
    const at = new Map([[old, 3], [n1, 4], [n2, 5]]);
    const actions = blockActions([old], [n1, n2], at);
    expect(actions.dataset.lines).toBe("3,4,5");
    actions.querySelector<HTMLElement>(".block-copy")!.click();
    const gone = line("-", "gone");
    blockActions([gone], [], new Map([[gone, 0]])).querySelector<HTMLElement>(".block-copy")!.click();
    await Promise.resolve();
    expect(written).toEqual(["new 1\nnew 2", "gone"]);
    // One button per changed block, none for context.
    const file = renderFile({
      path: "a.ts",
      old_path: null,
      status: "Modified",
      hunks: [{ header: "@@", lines: [line(" ", "ctx"), line("-", "a"), line("+", "b"), line(" ", "ctx"), line("+", "c")] }],
    });
    expect([...file.querySelectorAll<HTMLElement>(".block-actions")].map((b) => b.dataset.lines)).toEqual(["1,2", "4"]);
  });
});
