// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import type { Draft } from "../pr-reviews";
import type { FileDiff } from "../types";

const draft = (over: Partial<Draft> = {}): Draft => ({
  id: 3,
  path: "src/a.ts",
  line: 2,
  side: "RIGHT",
  body: "Use a constant.",
  severity: "minor",
  original: "Use a constant.",
  status: "pending",
  ...over,
});

const options = (over: Partial<import("./draft-cards").DraftCardOptions> = {}): import("./draft-cards").DraftCardOptions => ({
  where: "list",
  note: null,
  fix: null,
  showInDiff: null,
  openCommit: () => undefined,
  changed: () => undefined,
  ...over,
});

const buttons = (node: HTMLElement) => [...node.querySelectorAll("button")].map((b) => b.textContent);

const file: FileDiff = {
  path: "src/a.ts",
  old_path: null,
  status: "Modified",
  hunks: [
    {
      header: "@@ -1,2 +1,3 @@",
      lines: [
        { origin: " ", old_lineno: 1, new_lineno: 1, content: "one" },
        { origin: "+", old_lineno: null, new_lineno: 2, content: "two" },
        { origin: " ", old_lineno: 2, new_lineno: 3, content: "three" },
      ],
    },
  ],
};

describe("draft cards", () => {
  it("approves in the diff and the list card shows it", async () => {
    const { draftCard } = await import("./draft-cards");
    const d = draft();
    const changed = vi.fn();
    const inline = draftCard(d, options({ where: "inline", changed }));
    expect(inline.dataset.draft).toBe("3");
    expect(inline.classList.contains("inline")).toBe(true);
    [...inline.querySelectorAll("button")].find((b) => b.textContent === "Approve")!.click();
    expect(changed).toHaveBeenCalledWith(true);
    expect(buttons(draftCard(d, options()))).toContain("Approved ✓");
    // Typing saves without a redraw.
    const area = inline.querySelector("textarea")!;
    area.value = "Use MAX.";
    area.dispatchEvent(new Event("input"));
    expect(d.body).toBe("Use MAX.");
    expect(changed).toHaveBeenLastCalledWith(false);
  });

  it("shows a fixed draft's commit, with no Fix, and Discard keeps the record", async () => {
    const { draftCard } = await import("./draft-cards");
    const open = vi.fn();
    const d = draft({ status: "fixed", fix: { commit: "abcdef1234567", worktree: "/w", at: 1 } });
    const card = draftCard(d, options({ openCommit: open, fix: { reason: null, run: () => undefined } }));
    expect(buttons(card)).not.toContain("Fix");
    const link = [...card.querySelectorAll("button")].find((b) => b.textContent === "Fixed in abcdef1")!;
    link.click();
    expect(open).toHaveBeenCalledWith("abcdef1234567");
    [...card.querySelectorAll("button")].find((b) => b.textContent === "Discard")!.click();
    expect(d.status).toBe("discarded");
    expect(d.fix?.commit).toBe("abcdef1234567");
    const again = draftCard(d, options());
    [...again.querySelectorAll("button")].find((b) => b.textContent === "Restore")!.click();
    expect(d.status, "back to fixed, not pending").toBe("fixed");
  });

  it("offers Fix with its reason as the title, and Show in diff", async () => {
    const { draftCard } = await import("./draft-cards");
    const run = vi.fn();
    const show = vi.fn();
    const off = draftCard(draft(), options({ fix: { reason: "A fix is running on feat", run }, showInDiff: show }));
    const fix = [...off.querySelectorAll("button")].find((b) => b.textContent === "Fix")!;
    expect(fix.disabled).toBe(true);
    expect(fix.title).toBe("A fix is running on feat");
    const on = draftCard(draft(), options({ fix: { reason: null, run } }));
    [...on.querySelectorAll("button")].find((b) => b.textContent === "Fix")!.click();
    expect(run).toHaveBeenCalled();
    [...off.querySelectorAll("button")].find((b) => b.textContent === "Show in diff")!.click();
    expect(show).toHaveBeenCalled();
    expect(draftCard(draft(), options({ note: "line moved" })).textContent).toContain("line moved");
  });

  it("puts a card under its line, in the unified and the split diff", async () => {
    const { placeDraftCards } = await import("./draft-cards");
    const { renderFile, renderSplitDiff } = await import("./detail");
    for (const render of [renderFile, renderSplitDiff]) {
      const node = render(file);
      const card = document.createElement("div");
      card.className = "pr-draft";
      placeDraftCards(node, file, [{ d: draft(), line: 2, side: "RIGHT" }], () => card);
      const before = card.previousElementSibling as HTMLElement;
      const row = before.closest(".split-row") ?? before;
      expect(row.textContent).toContain("two");
    }
  });
});
