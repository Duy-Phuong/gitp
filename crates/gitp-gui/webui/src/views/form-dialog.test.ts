// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { openFormDialog, type FormAccess } from "./form-dialog";

afterEach(() => document.body.replaceChildren());

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
const button = (text: string) => buttons().find((b) => b.textContent === text)!;

describe("a field's action button", () => {
  it("sits in its field's row and can read and fill the fields", () => {
    let access: FormAccess | null = null;
    openFormDialog(
      {
        title: "T",
        fields: [
          { label: "Title", value: "a" },
          { label: "Description", multiline: true, action: { label: "Draft", run: (f) => (access = f) } },
        ],
        submitLabel: "Go",
      },
      () => {},
    );
    const draft = button("Draft");
    expect(draft.closest(".rename-row")?.textContent).toContain("Description");
    draft.click();
    expect(access).not.toBeNull();
    const f = access!;
    expect(f.button).toBe(draft);
    expect(f.value(0)).toBe("a");
    f.set(1, "body text");
    expect(document.querySelector("textarea")!.value).toBe("body text");
    expect(f.status.hidden).toBe(true);
    expect(f.isOpen()).toBe(true);
  });

  it("tells onClose once, whichever way the dialog closes", () => {
    for (const how of ["Cancel", "Go"]) {
      const onClose = vi.fn();
      const onSubmit = vi.fn();
      openFormDialog({ title: "T", fields: [{ label: "Title", value: "x" }], submitLabel: "Go", onClose }, onSubmit);
      button(how).click();
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledTimes(how === "Go" ? 1 : 0);
      expect(document.querySelector(".modal-overlay")).toBeNull();
    }
  });
});
