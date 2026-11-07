// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { openFormDialog } from "./views/form-dialog";
import { prDraftAction } from "./pr-draft-action";
import type { PrDraft } from "./types";

afterEach(() => document.body.replaceChildren());

const PREFILLED: PrDraft = { title: "Feature x", body: "## Why\n" };
const DRAFT: PrDraft = { title: "Add x", body: "x is added.\n\n## Checks\n- [ ] x" };

interface Deferred {
  resolve: (d: PrDraft) => void;
  reject: (e: unknown) => void;
}

// The dialog as Create Pull Request opens it: Into, Title, Description.
function open(confirmAnswer = true) {
  const runs: { base: string; d: Deferred }[] = [];
  const deps = {
    prefilled: PREFILLED,
    fields: { base: 0, title: 1, body: 2 },
    draft: (base: string) =>
      new Promise<PrDraft>((resolve, reject) => runs.push({ base, d: { resolve, reject } })),
    cancel: vi.fn(),
    confirm: vi.fn(async () => confirmAnswer),
  };
  const draft = prDraftAction(deps);
  openFormDialog(
    {
      title: "Create",
      fields: [
        { label: "Into", choices: [{ value: "main", label: "main" }, { value: "dev", label: "dev" }], value: "main" },
        { label: "Title", value: PREFILLED.title },
        { label: "Description", value: PREFILLED.body, multiline: true, action: draft.action },
      ],
      submitLabel: "Create",
      onClose: draft.close,
    },
    () => {},
  );
  const button = document.querySelector<HTMLButtonElement>(".form-field-action")!;
  const title = document.querySelectorAll<HTMLInputElement>("input")[0];
  const body = document.querySelector("textarea")!;
  const status = document.querySelector<HTMLElement>(".form-field-status")!;
  return { runs, deps, button, title, body, status };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("Draft with Claude in Create Pull Request", () => {
  it("fills a pre-filled dialog without asking, thinking meanwhile", async () => {
    const t = open();
    t.button.click();
    expect(t.button.textContent).toBe("Cancel");
    expect(t.status.textContent).toBe("Claude is thinking…");
    expect(t.runs[0].base).toBe("main");
    t.runs[0].d.resolve(DRAFT);
    await settle();
    expect([t.title.value, t.body.value]).toEqual([DRAFT.title, DRAFT.body]);
    expect(t.deps.confirm).not.toHaveBeenCalled();
    expect(t.button.textContent).toBe("Draft with Claude");
    expect(t.status.hidden).toBe(true);
  });

  it("keeps a typed title and asks before replacing a typed description", async () => {
    const t = open(false);
    t.title.value = "My title";
    t.body.value = "My words";
    (document.querySelector("select") as HTMLSelectElement).value = "dev";
    t.button.click();
    expect(t.runs[0].base).toBe("dev");
    t.runs[0].d.resolve(DRAFT);
    await settle();
    expect(t.deps.confirm).toHaveBeenCalledTimes(1);
    expect([t.title.value, t.body.value]).toEqual(["My title", "My words"]);
  });

  it("replaces Claude's own last draft without asking", async () => {
    const t = open();
    t.button.click();
    t.runs[0].d.resolve(DRAFT);
    await settle();
    t.button.click();
    t.runs[1].d.resolve({ title: "Second", body: "Second body" });
    await settle();
    expect([t.title.value, t.body.value]).toEqual(["Second", "Second body"]);
    expect(t.deps.confirm).not.toHaveBeenCalled();
  });

  it("cancels on Cancel and shows nothing", async () => {
    const t = open();
    t.button.click();
    t.button.click();
    expect(t.deps.cancel).toHaveBeenCalledTimes(1);
    t.runs[0].d.reject("operation cancelled");
    await settle();
    expect(t.button.textContent).toBe("Draft with Claude");
    expect(t.status.hidden).toBe(true);
    expect(t.body.value).toBe(PREFILLED.body);
  });

  it("shows a failure with Try again, which runs again", async () => {
    const t = open();
    t.button.click();
    t.runs[0].d.reject("The pull request draft command failed (exit code 1).");
    await settle();
    expect(t.status.hidden).toBe(false);
    expect(t.status.textContent).toContain("exit code 1");
    const retry = [...t.status.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    retry.click();
    expect(t.runs.length).toBe(2);
    expect(t.status.textContent).toBe("Claude is thinking…");
  });

  it("cancels a running draft when the dialog closes, and drops its result", async () => {
    const t = open();
    t.button.click();
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Cancel" && b !== t.button)!.click();
    expect(t.deps.cancel).toHaveBeenCalledTimes(1);
    t.runs[0].d.resolve(DRAFT);
    await settle();
    expect(t.deps.confirm).not.toHaveBeenCalled();
  });
});
