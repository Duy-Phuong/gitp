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

  it("shows the review's Explained simply and Explain more answers above the comment, with Explain more", async () => {
    const { draftCard } = await import("./draft-cards");
    const run = vi.fn();
    const d = draft({ explained: "The loop has **no** limit.", finding: "f2", explanations: ["First.", "Second."] });
    const card = draftCard(d, options({ explain: { running: false, failed: null, run } }));
    const folds = [...card.querySelectorAll<HTMLDetailsElement>(".pr-draft-fold")];
    expect(folds.map((f) => f.querySelector(".pr-draft-fold-title")!.textContent)).toEqual(["Explained simply", "Explained more 1", "Explained more 2"]);
    // Explain more sits in the title of the box it adds to.
    expect(folds[0].querySelector("summary button")?.textContent).toBe("Explain more");
    expect(folds.map((f) => f.open)).toEqual([true, false, true]);
    expect(folds[0].querySelector("strong")?.textContent).toBe("no");
    // In this order: the explanations, then the comment to paste.
    const label = card.querySelector(".pr-draft-label")!;
    expect(label.textContent).toBe("Comment to paste");
    expect(card.querySelector(".pr-draft-explain")!.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(label.nextElementSibling?.classList.contains("pr-draft-text")).toBe(true);
    [...card.querySelectorAll("button")].find((b) => b.textContent === "Explain more")!.click();
    expect(run).toHaveBeenCalled();

    const running = draftCard(d, options({ explain: { running: true, failed: "no saved review", run } }));
    const b = [...running.querySelectorAll("button")].find((x) => x.textContent === "Explaining…")!;
    expect(b.disabled).toBe(true);
    expect(running.textContent).toContain("Couldn't explain: no saved review");
  });

  it("keeps the inline card and a draft with nothing to explain as they were", async () => {
    const { draftCard } = await import("./draft-cards");
    const d = draft({ explained: "Why." });
    expect(draftCard(d, options({ where: "inline" })).querySelector(".pr-draft-explain")).toBeNull();
    expect(draftCard(draft(), options()).querySelector(".pr-draft-explain, .pr-draft-label")).toBeNull();
  });

  it("shows a file's name first and its folder dimmed", async () => {
    const { draftCard } = await import("./draft-cards");
    const where = draftCard(draft({ path: "a/b/c.java", line: 7 }), options()).querySelector(".pr-draft-where")!;
    expect(where.querySelector(".pr-draft-file")!.textContent).toBe("c.java:7");
    expect(where.querySelector(".pr-draft-dir")!.textContent).toBe("a/b/");
  });

  it("shows a fix round's notes under the comment, and folds a draft they say is fixed", async () => {
    const { draftCard, fixState } = await import("./draft-cards");
    expect(fixState("**Fix status:** pushed in abc · re-check: ✅ fixed")).toEqual({ label: "✅ fixed", tone: "done" });
    expect(fixState("**Fix status:** proposed")).toEqual({ label: "proposed", tone: "open" });
    expect(fixState("**Fix status:** pushed in abc · re-check: ⏳ still open")!.tone).toBe("warn");
    expect(fixState("no status")).toBeNull();

    const open = draftCard(draft({ id: 41, fixNotes: "**Fix check:** confirmed\n\n**Fix status:** proposed" }), options());
    const notes = open.querySelector<HTMLDetailsElement>(".pr-draft-fix-notes")!;
    expect(notes.open).toBe(true);
    expect(notes.querySelector("strong")?.textContent).toBe("Fix check:");
    expect(open.querySelector(".pr-draft-text")!.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(open.querySelector(".pr-draft-label")?.textContent).toBe("Comment to paste");

    const changed = vi.fn();
    const d = draft({ id: 42, fixNotes: "**Fix status:** pushed in abc · re-check: ✅ fixed" });
    const folded = draftCard(d, options({ changed }));
    expect(folded.classList.contains("folded")).toBe(true);
    expect(folded.querySelector("textarea")).toBeNull();
    expect(folded.querySelector(".pr-draft-fix-badge")!.textContent).toBe("✅ fixed");
    // Discard is the main button; Approve is still there.
    const discard = [...folded.querySelectorAll("button")].find((b) => b.textContent === "Discard")!;
    expect(discard.classList.contains("ghost")).toBe(false);
    expect(buttons(folded)).toContain("Approve");
    [...folded.querySelectorAll("button")].find((b) => b.textContent === "Show")!.click();
    expect(changed).toHaveBeenCalledWith(true);
    const shown = draftCard(d, options());
    expect(shown.querySelector("textarea")).not.toBeNull();
    expect(buttons(shown)).toContain("Hide");
  });
});
