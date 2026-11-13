// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { confirmReviewPost } from "./review-preview-dialog";

const preview = {
  number: 42,
  login: "you",
  verdict: "request_changes" as const,
  body: "Two things.\n\n**Off-diff:** see `a.ts:40`",
  comments: [
    { path: "src/a.ts", line: 6, side: "RIGHT" as const, commit_id: "c", body: "Off by **one**." },
    { path: "src/b.ts", line: 2, side: "LEFT" as const, commit_id: "c", body: "Why removed?" },
  ],
};

describe("confirmReviewPost", () => {
  it("shows the message and every comment, drawn, and resolves with the choice", async () => {
    const shown = confirmReviewPost(preview);
    const modal = document.querySelector(".review-preview")!;
    expect(modal.querySelector(".modal-sub")!.textContent).toContain("Request changes · 2 line comments · as you");
    expect([...modal.querySelectorAll(".review-preview-where")].map((x) => x.textContent)).toEqual(["src/a.ts:6", "src/b.ts:2 (removed line)"]);
    expect([...modal.querySelectorAll("strong")].map((x) => x.textContent)).toEqual(["Off-diff:", "one"]);
    [...modal.querySelectorAll("button")].find((b) => b.textContent === "Post to GitHub")!.click();
    await expect(shown).resolves.toBe(true);
    expect(document.querySelector(".review-preview")).toBeNull();
  });

  it("resolves false on Cancel and on Escape, and says when there is no message", async () => {
    const a = confirmReviewPost({ ...preview, body: " " });
    expect(document.querySelector(".review-preview-empty")?.textContent).toBe("No message.");
    [...document.querySelectorAll<HTMLButtonElement>(".review-preview button")].find((b) => b.textContent === "Cancel")!.click();
    await expect(a).resolves.toBe(false);
    const b = confirmReviewPost(preview);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(b).resolves.toBe(false);
  });
});
