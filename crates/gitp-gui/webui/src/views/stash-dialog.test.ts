import { afterEach, describe, expect, it, vi } from "vitest";
import { submitsOnEnter } from "./stash-dialog";

// Just enough of a focused element for the predicate.
class FakeElement {
  constructor(private readonly tag: string) {}
  matches(selector: string): boolean {
    return selector.split(",").some((s) => s.trim() === this.tag);
  }
}

const key = (k: string, target: unknown, isComposing = false) =>
  ({ key: k, target, isComposing }) as unknown as KeyboardEvent;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("submitsOnEnter", () => {
  it("submits on Enter in the message field or a checkbox", () => {
    vi.stubGlobal("HTMLElement", FakeElement);
    expect(submitsOnEnter(key("Enter", new FakeElement("input")))).toBe(true);
    expect(submitsOnEnter(key("Enter", null))).toBe(true);
  });

  it("leaves Enter on a focused button to that button, so Cancel cancels", () => {
    vi.stubGlobal("HTMLElement", FakeElement);
    expect(submitsOnEnter(key("Enter", new FakeElement("button")))).toBe(false);
  });

  it("ignores the Enter that confirms an IME composition", () => {
    vi.stubGlobal("HTMLElement", FakeElement);
    expect(submitsOnEnter(key("Enter", new FakeElement("input"), true))).toBe(false);
  });

  it("ignores other keys", () => {
    vi.stubGlobal("HTMLElement", FakeElement);
    expect(submitsOnEnter(key("a", new FakeElement("input")))).toBe(false);
  });
});
