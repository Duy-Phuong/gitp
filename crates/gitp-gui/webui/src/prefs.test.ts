import { describe, it, expect } from "vitest";
import { nextToggleTheme, parseTabAliases, steppedZoom, withFavoriteToggled, withTabAlias, ZOOM_LEVELS } from "./prefs";

describe("withFavoriteToggled", () => {
  it("stars a repo at the end, so earlier favorites keep their shortcut", () => {
    expect(withFavoriteToggled(["/a", "/b"], "/c")).toEqual(["/a", "/b", "/c"]);
  });

  it("unstars a starred repo and closes the gap", () => {
    expect(withFavoriteToggled(["/a", "/b", "/c"], "/b")).toEqual(["/a", "/c"]);
  });
});

describe("tab aliases", () => {
  it("names a tab and drops the name again", () => {
    const named = withTabAlias({}, "/a", "  Work  ");
    expect(named).toEqual({ "/a": "Work" });
    expect(withTabAlias(named, "/a", null)).toEqual({});
    expect(withTabAlias(named, "/a", "   "), "a blank name resets too").toEqual({});
  });

  it("leaves the other tabs' names alone", () => {
    expect(withTabAlias({ "/a": "A", "/b": "B" }, "/b", "Bee")).toEqual({ "/a": "A", "/b": "Bee" });
  });

  it("reads back only well-formed names", () => {
    expect(parseTabAliases(null)).toEqual({});
    expect(parseTabAliases("not json")).toEqual({});
    expect(parseTabAliases('["/a"]')).toEqual({});
    expect(parseTabAliases('{"/a":"A","/b":3}')).toEqual({ "/a": "A" });
  });
});

describe("steppedZoom", () => {
  it("walks the preset levels", () => {
    expect(steppedZoom(1, 1)).toBe(1.1);
    expect(steppedZoom(1.1, 1)).toBe(1.25);
    expect(steppedZoom(1, -1)).toBe(0.9);
    expect(steppedZoom(1.25, -1)).toBe(1.1);
  });

  it("stays put at either end", () => {
    expect(steppedZoom(ZOOM_LEVELS[ZOOM_LEVELS.length - 1], 1)).toBe(2);
    expect(steppedZoom(ZOOM_LEVELS[0], -1)).toBe(0.8);
  });

  it("snaps an in-between level to the next preset", () => {
    expect(steppedZoom(1.05, 1)).toBe(1.1);
    expect(steppedZoom(1.05, -1)).toBe(1);
  });
});

describe("nextToggleTheme", () => {
  it("goes to Light from any dark theme", () => {
    expect(nextToggleTheme("dark", false, "dark")).toBe("light");
    expect(nextToggleTheme("gitkraken-neon", false, "gitkraken-neon")).toBe("light");
  });

  it("goes back from Light to the dark theme last chosen", () => {
    expect(nextToggleTheme("light", true, "gitkraken")).toBe("gitkraken");
  });

  it("reads System as whatever the OS is showing", () => {
    expect(nextToggleTheme("system", true, "dark")).toBe("light");
    expect(nextToggleTheme("system", false, "gitkraken")).toBe("gitkraken");
  });
});
