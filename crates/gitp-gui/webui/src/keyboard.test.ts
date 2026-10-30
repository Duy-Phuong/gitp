import { afterEach, describe, expect, it, vi } from "vitest";

// keyboard.ts wires the whole app; only its key predicates are under test.
vi.mock("./shell", () => ({}));
vi.mock("./repo-actions", () => ({}));
vi.mock("./quick-launch-commands", () => ({}));
vi.mock("./prefs", () => ({}));
vi.mock("./report", () => ({}));

const { opensQuickLaunch } = await import("./keyboard");

// Just enough of a focused element and of `document` for the predicate.
class FakeElement {
  isContentEditable = false;
  constructor(private readonly inTerminal = false) {}
  closest(selector: string): FakeElement | null {
    return selector === "#terminal-host" && this.inTerminal ? this : null;
  }
}

function withPage(dialogOpen: boolean): void {
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("document", {
    querySelector: (selector: string) => (dialogOpen && selector.includes(".modal-overlay") ? {} : null),
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
    expect(opensQuickLaunch({ ...cmdK(), key: "j" } as KeyboardEvent)).toBe(false);
  });
});
