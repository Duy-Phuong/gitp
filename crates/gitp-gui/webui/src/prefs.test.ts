import { describe, it, expect } from "vitest";
import { codeCssVars, fontStack, withFavoriteToggled } from "./prefs";

describe("withFavoriteToggled", () => {
  it("stars a repo at the end, so earlier favorites keep their shortcut", () => {
    expect(withFavoriteToggled(["/a", "/b"], "/c")).toEqual(["/a", "/b", "/c"]);
  });

  it("unstars a starred repo and closes the gap", () => {
    expect(withFavoriteToggled(["/a", "/b", "/c"], "/b")).toEqual(["/a", "/c"]);
  });
});

describe("fontStack", () => {
  it("falls back to the given stack when no family is chosen", () => {
    expect(fontStack("  ", "var(--mono)")).toBe("var(--mono)");
  });

  it("quotes one family name with spaces and keeps the fallback after it", () => {
    expect(fontStack("JetBrains Mono", "var(--mono)")).toBe('"JetBrains Mono", var(--mono)');
    expect(fontStack("Menlo", "monospace")).toBe("Menlo, monospace");
  });

  it("uses a typed list or quoted name as written", () => {
    expect(fontStack("Iosevka Term, Menlo", "monospace")).toBe("Iosevka Term, Menlo, monospace");
    expect(fontStack("'Fira Code'", "monospace")).toBe("'Fira Code', monospace");
  });
});

describe("codeCssVars", () => {
  it("turns the Editor & Diff settings into the CSS variables styles.css reads", () => {
    expect(codeCssVars({ font: "Fira Code", size: 14, tabSize: 2, lineNumbers: false })).toEqual({
      "--code-font": '"Fira Code", var(--mono)',
      "--code-size": "14px",
      "--tab-size": "2",
    });
    expect(codeCssVars({ font: "", size: 12, tabSize: 4, lineNumbers: true })["--code-font"]).toBe("var(--mono)");
  });
});
