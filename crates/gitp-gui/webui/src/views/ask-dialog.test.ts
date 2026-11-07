// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { closeAskDialog, openAskDialog } from "./ask-dialog";

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the Explain with Claude dialog", () => {
  it("shows the answer as Markdown, with Copy", async () => {
    const copy = vi.fn();
    openAskDialog("Explain abc", () => Promise.resolve("## Why\n\nBecause."), { copy, reportDone: vi.fn(), reportError: vi.fn() });
    expect(document.querySelector(".ask-wait")).not.toBeNull();
    await settle();
    expect(document.querySelector(".ask-body h2")?.textContent).toBe("Why");
    const button = [...document.querySelectorAll<HTMLButtonElement>(".ask-dialog button")].find((b) => b.textContent === "Copy")!;
    button.click();
    expect(copy).toHaveBeenCalledWith("## Why\n\nBecause.");
    closeAskDialog();
  });

  it("says the answer is ready when it lands after the dialog closed", async () => {
    let answer: (s: string) => void = () => {};
    const reportDone = vi.fn();
    openAskDialog("Summary of feature", () => new Promise((r) => (answer = r)), { copy: vi.fn(), reportDone, reportError: vi.fn() });
    closeAskDialog();
    answer("text");
    await settle();
    expect(reportDone).toHaveBeenCalledWith("Summary of feature: ready in Claude jobs.");
  });
});
