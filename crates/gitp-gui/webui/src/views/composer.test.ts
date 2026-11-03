// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { composerArea, previewToggle } from "./composer";

describe("composerArea", () => {
  it("keeps the given class and attributes", () => {
    const area = composerArea({ class: "pr-draft-text", placeholder: "Reply" });
    expect(area.className).toBe("pr-composer-input pr-draft-text");
    expect(area.placeholder).toBe("Reply");
    expect(area.getAttribute("spellcheck")).toBe("true");
  });
});

describe("previewToggle", () => {
  it("swaps the box for the rendered Markdown and back", () => {
    const area = composerArea();
    area.value = "**bold** text";
    const box = document.createElement("div");
    box.append(area);
    const { button, edit } = previewToggle(area);

    button.click();
    const preview = box.querySelector(".pr-composer-preview");
    expect(preview?.querySelector("strong")?.textContent).toBe("bold");
    expect(box.contains(area)).toBe(false);
    expect(button.textContent).toBe("Edit");

    button.click();
    expect(box.contains(area)).toBe(true);
    expect(box.querySelector(".pr-composer-preview")).toBeNull();
    expect(button.textContent).toBe("Preview");

    button.click();
    edit();
    expect(box.contains(area)).toBe(true);
  });

  it("says so when there is nothing to preview", () => {
    const area = composerArea();
    document.body.append(area);
    previewToggle(area).button.click();
    expect(document.querySelector(".pr-composer-preview")?.textContent).toBe("Nothing to preview.");
  });
});
