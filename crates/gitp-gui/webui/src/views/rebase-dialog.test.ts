// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RebaseStep } from "../types";

vi.mock("../api", () => ({
  fetchCommitDetail: (sha: string) =>
    Promise.resolve({
      id: sha,
      summary: `subject ${sha[0]}`,
      message: `subject ${sha[0]}\n\nbody of ${sha[0]}\n`,
      author_name: "",
      author_email: "",
      author_time: 0,
      parents: [],
      files: [],
    }),
}));
vi.mock("./detail", () => ({ renderFile: () => document.createElement("div") }));

const { closeRebaseModal, openRebaseModal } = await import("./rebase");

const commits = ["a", "b", "c", "d"].map((s) => ({ sha: `${s}0000000`, short_sha: s, subject: `subject ${s}` }));
const settle = () => new Promise((r) => setTimeout(r, 0));
const key = (k: string, opts: KeyboardEventInit = {}) =>
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...opts }));
const actions = () => [...document.querySelectorAll(".rebase-action-name")].map((n) => n.textContent);
const rowAt = (i: number) => document.querySelectorAll<HTMLElement>(".rebase-row")[i];
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".rebase-modal button")].find((b) => b.textContent?.startsWith(text))!;

function open() {
  let ran: RebaseStep[] | null = null;
  openRebaseModal("main", "feature", commits, (steps) => (ran = steps));
  return () => ran;
}

describe("the interactive rebase dialog", () => {
  afterEach(() => closeRebaseModal());

  it("sets an action on every selected commit, and undoes and redoes it", () => {
    open();
    key("ArrowDown", { shiftKey: true });
    key("ArrowDown", { shiftKey: true });
    key("d");
    expect(actions()).toEqual(["Drop", "Drop", "Drop", "Pick"]);
    expect(document.querySelector(".rebase-summary")?.textContent).toBe("4 commits → 1 · 3 dropped");
    key("z", { metaKey: true });
    expect(actions()).toEqual(["Pick", "Pick", "Pick", "Pick"]);
    key("z", { metaKey: true, shiftKey: true });
    expect(actions()).toEqual(["Drop", "Drop", "Drop", "Pick"]);
  });

  it("squashes a ⌘-click selection into one and names where each meld goes", () => {
    open();
    rowAt(3).dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    button("Squash 2 into one").click();
    expect(actions()).toEqual(["Pick", "Squash", "Pick", "Pick"]);
    expect(rowAt(1).querySelector(".rebase-into")?.textContent).toBe("↳ into a");
    expect(document.querySelectorAll(".rebase-row .rebase-sha")[1].textContent).toBe("d");
  });

  it("rewords the whole message, body included", async () => {
    open();
    key("r");
    await settle();
    await settle();
    const area = document.querySelector<HTMLTextAreaElement>("textarea.rebase-message")!;
    expect(area.value).toBe("subject a\n\nbody of a");
    expect(area.disabled).toBe(false);
  });

  it("sends a squash group's edited message on its last meld", async () => {
    const ran = open();
    key("ArrowDown");
    key("s");
    await settle();
    await settle();
    const area = document.querySelector<HTMLTextAreaElement>("textarea.rebase-group-message")!;
    expect(area.value).toBe("subject a\n\nbody of a\n\nsubject b\n\nbody of b");
    area.value = "one commit";
    area.dispatchEvent(new Event("input"));
    button("Rebase").click();
    expect(ran()!.map((s) => [s.action, s.message])).toEqual([
      ["pick", null],
      ["squash", "one commit"],
      ["pick", null],
      ["pick", null],
    ]);
  });
});
