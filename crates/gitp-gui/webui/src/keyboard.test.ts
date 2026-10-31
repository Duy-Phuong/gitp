import { afterEach, describe, expect, it, vi } from "vitest";

// keyboard.ts wires the whole app; only its key predicates are under test.
vi.mock("./shell", () => ({}));
vi.mock("./repo-actions", () => ({}));
vi.mock("./quick-launch-commands", () => ({}));
vi.mock("./prefs", () => ({}));
vi.mock("./report", () => ({}));
vi.mock("./terminal-panel", () => ({}));
vi.mock("./new-repo-actions", () => ({}));
vi.mock("./views/shortcuts-dialog", () => ({}));

const { opensQuickLaunch, packShortcutAllowed } = await import("./keyboard");

// Just enough of a focused element and of `document` for the predicate.
class FakeElement {
  isContentEditable = false;
  constructor(private readonly inTerminal = false) {}
  closest(selector: string): FakeElement | null {
    return selector === "#terminal-host" && this.inTerminal ? this : null;
  }
}

function withPage(dialogOpen: boolean, open: string[] = dialogOpen ? [".modal-overlay"] : []): void {
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("document", {
    querySelector: (selector: string) => (open.some((cls) => selector.includes(cls)) ? {} : null),
  });
}

const cmdK = (target: unknown = new FakeElement()) =>
  ({ metaKey: true, ctrlKey: false, key: "k", target }) as unknown as KeyboardEvent;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("opensQuickLaunch", () => {
  it("opens the palette from anywhere, even while typing in a field", () => {
    withPage(false);
    expect(opensQuickLaunch(cmdK())).toBe(true);
    expect(opensQuickLaunch(cmdK(null))).toBe(true);
  });

  it("leaves the key to the embedded terminal", () => {
    withPage(false);
    expect(opensQuickLaunch(cmdK(new FakeElement(true)))).toBe(false);
  });

  it("doesn't open over a dialog, whose Enter would then run too", () => {
    withPage(true);
    expect(opensQuickLaunch(cmdK())).toBe(false);
  });

  it("ignores other keys", () => {
    withPage(false);
    expect(opensQuickLaunch({ ...cmdK(), key: "j" })).toBe(false);
  });
});

describe("packShortcutAllowed", () => {
  const anywhere = {} as KeyboardEvent;
  const inField = { target: Object.assign(new FakeElement(), { tagName: "INPUT" }) } as unknown as KeyboardEvent;
  const inTerminal = { target: new FakeElement(true) } as unknown as KeyboardEvent;

  it("fires from the page, not while typing or in the terminal", () => {
    withPage(false);
    expect(packShortcutAllowed(anywhere, "push")).toBe(true);
    expect(packShortcutAllowed(inField, "push")).toBe(false);
    expect(packShortcutAllowed(inTerminal, "push")).toBe(false);
  });

  it("leaves the keyboard to an open dialog or the palette", () => {
    withPage(true);
    expect(packShortcutAllowed(anywhere, "push")).toBe(false);
    expect(packShortcutAllowed(anywhere, "cheatSheet")).toBe(false);
    withPage(false, [".ql-overlay"]);
    expect(packShortcutAllowed(anywhere, "push")).toBe(false);
  });

  it("lets Cmd+/ close the cheat sheet it opened", () => {
    withPage(false, [".modal-overlay", ".shortcuts-dialog"]);
    expect(packShortcutAllowed(anywhere, "cheatSheet")).toBe(true);
    expect(packShortcutAllowed(anywhere, "push")).toBe(false);
  });
});
