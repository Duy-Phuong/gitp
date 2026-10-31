import { describe, expect, it } from "vitest";

import { BUILT_IN, formatKeys, matches, SHORTCUTS, shortcutFor, type Keys } from "./shortcuts";

function key(
  k: string,
  mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {},
  code = "",
): KeyboardEvent {
  return {
    key: k,
    code,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
  } as unknown as KeyboardEvent;
}

describe("matches", () => {
  const push: Keys = { key: "p", shift: true };

  it("takes Cmd on a Mac and Ctrl elsewhere, with Shift as asked", () => {
    // Shift+P arrives as an upper-case key.
    expect(matches(push, key("P", { meta: true, shift: true }), true)).toBe(true);
    expect(matches(push, key("P", { ctrl: true, shift: true }), false)).toBe(true);
    expect(matches(push, key("P", { ctrl: true, shift: true }), true)).toBe(false);
    expect(matches(push, key("p", { meta: true }), true)).toBe(false);
  });

  it("ignores a chord with Alt or both modifiers held", () => {
    expect(matches(push, key("P", { meta: true, shift: true, alt: true }), true)).toBe(false);
    expect(matches(push, key("P", { meta: true, ctrl: true, shift: true }), true)).toBe(false);
  });

  it("binds Ctrl on every platform when asked", () => {
    const terminal: Keys = { key: "`", modifier: "ctrl" };
    expect(matches(terminal, key("`", { ctrl: true }), true)).toBe(true);
    expect(matches(terminal, key("`", { meta: true }), true)).toBe(false);
  });

  it("matches punctuation by key or by code, for layouts where the key differs", () => {
    const sheet: Keys = { key: "/" };
    expect(matches(sheet, key("/", { meta: true }), true)).toBe(true);
    expect(matches(sheet, key("-", { meta: true }, "Slash"), true)).toBe(true);
    expect(matches(sheet, key("-", { meta: true }, "Minus"), true)).toBe(false);
  });
});

describe("formatKeys", () => {
  it("spells a binding the way each platform does", () => {
    expect(formatKeys({ key: "p", shift: true }, true)).toBe("⌘⇧P");
    expect(formatKeys({ key: "p", shift: true }, false)).toBe("Ctrl+Shift+P");
    expect(formatKeys({ key: "`", modifier: "ctrl" }, true)).toBe("⌃`");
    expect(formatKeys({ key: "`", modifier: "ctrl" }, false)).toBe("Ctrl+`");
    expect(formatKeys({ key: "," }, true)).toBe("⌘,");
  });
});

describe("the pack", () => {
  it("has no two shortcuts on the same keys", () => {
    const seen = new Map<string, string>();
    for (const [id, def] of Object.entries(SHORTCUTS)) {
      const spelled = formatKeys(def.keys, true);
      expect(seen.get(spelled), `${id} and ${seen.get(spelled)} both on ${spelled}`).toBeUndefined();
      seen.set(spelled, id);
    }
  });

  it("stays clear of the keys bound elsewhere", () => {
    // Undo / Redo, Quick Launch, favorites, zoom, and the clipboard.
    const reserved = ["⌘Z", "⌘⇧Z", "⌘Y", "⌘K", "⌘C", "⌘V", "⌘X", "⌘A", "⌘W", "⌘Q", "⌘=", "⌘-", "⌘0"];
    for (const def of Object.values(SHORTCUTS)) {
      expect(reserved).not.toContain(formatKeys(def.keys, true));
    }
    const builtIn = BUILT_IN.map((b) => b.mac);
    for (const def of Object.values(SHORTCUTS)) {
      expect(builtIn).not.toContain(formatKeys(def.keys, true));
    }
  });

  it("finds the shortcut a key event is for", () => {
    expect(shortcutFor(key("P", { meta: true, shift: true }), true)).toBe("push");
    expect(shortcutFor(key("f", { meta: true }), true)).toBe("searchCommits");
    expect(shortcutFor(key("F", { meta: true, shift: true }), true)).toBe("fetch");
    expect(shortcutFor(key("`", { ctrl: true }), false)).toBe("terminal");
    expect(shortcutFor(key("k", { meta: true }), true)).toBeNull();
  });
});
