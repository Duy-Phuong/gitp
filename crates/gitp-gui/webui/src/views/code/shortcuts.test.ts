import { describe, expect, it } from "vitest";

import { codeActionFor } from "./shortcuts";

const ev = (key: string, mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {}) =>
  ({ key, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift }) as KeyboardEvent;

describe("codeActionFor", () => {
  it("maps each binding on a Mac", () => {
    expect(codeActionFor(ev("p", { meta: true }), true)).toBe("quickOpen");
    expect(codeActionFor(ev("f", { meta: true, shift: true }), true)).toBe("findInFiles");
    expect(codeActionFor(ev("F12"), true)).toBe("goToDefinition");
    expect(codeActionFor(ev("ArrowLeft", { meta: true, alt: true }), true)).toBe("back");
    expect(codeActionFor(ev("ArrowRight", { meta: true, alt: true }), true)).toBe("forward");
    expect(codeActionFor(ev("F7", { alt: true }), true)).toBe("findUsages");
    expect(codeActionFor(ev("h", { ctrl: true, alt: true }), true)).toBe("callHierarchy");
    expect(codeActionFor(ev("w", { meta: true, shift: true }), true)).toBe("closeTab");
  });

  it("uses Ctrl instead of Cmd elsewhere", () => {
    expect(codeActionFor(ev("p", { ctrl: true }), false)).toBe("quickOpen");
    expect(codeActionFor(ev("p", { meta: true }), false)).toBeNull();
    expect(codeActionFor(ev("ArrowLeft", { ctrl: true, alt: true }), false)).toBe("back");
    expect(codeActionFor(ev("P", { ctrl: true, shift: true }), false)).toBeNull();
  });

  it("ignores unrelated keys", () => {
    expect(codeActionFor(ev("p"), true)).toBeNull();
    expect(codeActionFor(ev("s", { meta: true }), true)).toBeNull();
    expect(codeActionFor(ev("F12", { meta: true }), true)).toBeNull();
    expect(codeActionFor(ev("k", { meta: true }), true)).toBeNull();
  });
});
