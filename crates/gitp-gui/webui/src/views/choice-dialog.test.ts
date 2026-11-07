// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { askConfirmList } from "./choice-dialog";

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>(".modal-actions button")];

describe("askConfirmList", () => {
  it("lists every name and resolves true on the confirm button", async () => {
    const names = Array.from({ length: 38 }, (_, i) => `feature/b${i}`);
    const answer = askConfirmList("Delete 38 branches?", "sub", names, "note", "Delete");
    expect(document.querySelectorAll(".list-confirm-names li")).toHaveLength(38);
    buttons().find((b) => b.textContent === "Delete")!.click();
    expect(await answer).toBe(true);
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });

  it("resolves false on Escape", async () => {
    const answer = askConfirmList("Delete?", "sub", ["a"], "", "Delete");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await answer).toBe(false);
  });
});
