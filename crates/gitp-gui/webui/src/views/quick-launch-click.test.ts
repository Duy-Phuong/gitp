// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { closeQuickLaunch, showQuickLaunch, type QuickStage } from "./quick-launch";

const panelText = () => document.querySelector(".ql-panel")?.textContent ?? null;

const press = (target: Element) => target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

describe("Quick Launch with the mouse", () => {
  afterEach(() => closeQuickLaunch());

  it("opens a command's next list when the command is clicked", async () => {
    const repos: QuickStage = {
      chip: "Open Recent",
      placeholder: "repository",
      sections: [{ title: "Recent Repositories", items: [{ kind: "repo", label: "html-pdf-printer", run: () => {} }] }],
    };
    showQuickLaunch({
      placeholder: "Command",
      sections: [{ title: "Commands", items: [{ kind: "command", label: "Open Recent…", next: () => repos }] }],
    });
    press(document.querySelector(".ql-row")!);
    await Promise.resolve();
    expect(panelText()).toContain("html-pdf-printer");
  });

  it("closes on a click outside the panel", () => {
    showQuickLaunch({ placeholder: "Command", sections: [] });
    press(document.querySelector(".ql-overlay")!);
    expect(panelText()).toBeNull();
  });
});
