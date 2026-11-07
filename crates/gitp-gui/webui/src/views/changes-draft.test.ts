// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { setupChanges, type ChangesCallbacks, type ChangesHandle } from "./changes";
import type { CommitDetail, FileDiff, StatusLists } from "../types";
import type { CommitDraft } from "../claude-drafts";

afterEach(() => document.body.replaceChildren());

const file = (path: string): FileDiff => ({ path, old_path: null, status: "Modified", hunks: [] });
const settle = () => new Promise((r) => setTimeout(r, 0));
const DRAFT: CommitDraft = { subject: "feat: drafted", body: "Why it changed." };

interface Run {
  amend: boolean;
  resolve: (d: CommitDraft) => void;
  reject: (e: unknown) => void;
}

// The commit box with `staged` files, every other callback a quiet stub.
async function box(staged: FileDiff[], opts: { confirm?: boolean; head?: CommitDetail } = {}) {
  const runs: Run[] = [];
  const stubs: Partial<ChangesCallbacks> = {
    fetchStatus: async (): Promise<StatusLists> => ({ staged, unstaged: [] }),
    fetchFileDiff: async () => null,
    fetchHead: async () => opts.head ?? null,
    fetchCommitTemplate: async () => null,
    fetchSigningConfig: () => new Promise(() => {}),
    pushAfterCommit: () => false,
    confirm: vi.fn(async () => opts.confirm ?? true),
    draftMessage: (amend: boolean) => new Promise<CommitDraft>((resolve, reject) => runs.push({ amend, resolve, reject })),
    cancelDraft: vi.fn(),
    setStatus: vi.fn(),
  };
  const cb = new Proxy(stubs, {
    get: (t, k: string) => (k in t ? t[k as keyof ChangesCallbacks] : () => undefined),
  }) as ChangesCallbacks;
  const host = document.createElement("div");
  document.body.append(host);
  const handle: ChangesHandle = setupChanges(host, cb);
  await handle.reload();
  const q = <T extends Element>(sel: string) => host.querySelector<T>(sel)!;
  return {
    runs,
    stubs,
    handle,
    button: () => q<HTMLButtonElement>(".commit-draft-btn"),
    subject: () => q<HTMLInputElement>(".commit-subject"),
    body: () => q<HTMLTextAreaElement>(".commit-body"),
    status: () => host.querySelector<HTMLElement>(".commit-draft-status"),
    type(subject: string) {
      this.subject().value = subject;
      this.subject().dispatchEvent(new Event("input"));
    },
  };
}

describe("Draft with Claude in the commit box", () => {
  it("is disabled until something is staged", async () => {
    const b = await box([]);
    expect(b.button().disabled).toBe(true);
    expect(b.button().title).toBe("Stage something first");
    b.handle.draftMessage();
    expect(b.runs).toHaveLength(0);
    expect(b.stubs.setStatus).toHaveBeenCalledWith("Stage something first.");
  });

  it("fills an empty box without asking: first line to Subject, the rest to Description", async () => {
    const b = await box([file("a.ts")]);
    b.button().click();
    expect(b.button().textContent).toBe("Cancel");
    expect(b.status()?.textContent).toBe("Claude is thinking…");
    expect(b.runs[0].amend).toBe(false);
    b.runs[0].resolve(DRAFT);
    await settle();
    expect([b.subject().value, b.body().value]).toEqual([DRAFT.subject, DRAFT.body]);
    expect(b.stubs.confirm).not.toHaveBeenCalled();
    expect(b.button().textContent).toBe("Draft with Claude");
    expect(b.status()).toBeNull();
  });

  it("asks before replacing typed text, and keeps it on No", async () => {
    const b = await box([file("a.ts")], { confirm: false });
    b.button().click();
    b.type("mine"); // typed while Claude thinks
    b.runs[0].resolve(DRAFT);
    await settle();
    expect(b.stubs.confirm).toHaveBeenCalledTimes(1);
    expect(b.subject().value).toBe("mine");
  });

  it("replaces its own last draft without asking", async () => {
    const b = await box([file("a.ts")]);
    b.button().click();
    b.runs[0].resolve(DRAFT);
    await settle();
    b.button().click();
    b.runs[1].resolve({ subject: "fix: again", body: "" });
    await settle();
    expect(b.subject().value).toBe("fix: again");
    expect(b.stubs.confirm).not.toHaveBeenCalled();
  });

  it("cancels on Cancel and shows no error", async () => {
    const b = await box([file("a.ts")]);
    b.button().click();
    b.button().click();
    expect(b.stubs.cancelDraft).toHaveBeenCalledTimes(1);
    b.runs[0].reject("operation cancelled");
    await settle();
    expect(b.status()).toBeNull();
    expect(b.button().textContent).toBe("Draft with Claude");
  });

  it("shows a failure with Try again, which runs again", async () => {
    const b = await box([file("a.ts")]);
    b.button().click();
    b.runs[0].reject("The commit message command failed (exit code 1).");
    await settle();
    expect(b.status()?.textContent).toContain("exit code 1");
    [...b.status()!.querySelectorAll("button")].find((x) => x.textContent === "Try again")!.click();
    expect(b.runs).toHaveLength(2);
  });

  it("drops an answer that comes back after a repo switch, and cancels the run", async () => {
    const b = await box([file("a.ts")]);
    b.button().click();
    b.handle.reset();
    expect(b.stubs.cancelDraft).toHaveBeenCalledTimes(1);
    b.runs[0].resolve(DRAFT);
    await settle();
    expect(b.subject().value).toBe("");
  });

  it("drops a draft still running when a commit lands, and cancels it", async () => {
    const b = await box([file("a.ts")]);
    b.button().click();
    b.type("feat: mine");
    b.stubs.commit = async () => "Committed.";
    document.querySelector<HTMLButtonElement>(".commit-btn")!.click();
    await settle();
    await settle();
    expect(b.stubs.cancelDraft).toHaveBeenCalledTimes(1);
    b.runs[0].resolve(DRAFT);
    await settle();
    expect(b.subject().value).toBe("");
    expect(b.button().textContent).toBe("Draft with Claude");
  });

  it("drafts for an amend and asks before replacing HEAD's message", async () => {
    const head = { summary: "old subject", message: "old subject\n\nold body", files: [] } as unknown as CommitDetail;
    const b = await box([], { head, confirm: true });
    const amend = [...document.querySelectorAll<HTMLInputElement>(".commit-amend input")][0];
    amend.checked = true;
    amend.dispatchEvent(new Event("change"));
    await settle();
    expect(b.subject().value).toBe("old subject");
    expect(b.button().disabled).toBe(false);
    b.button().click();
    expect(b.runs[0].amend).toBe(true);
    b.runs[0].resolve(DRAFT);
    await settle();
    expect(b.stubs.confirm).toHaveBeenCalledTimes(1);
    expect(b.subject().value).toBe(DRAFT.subject);
  });
});
