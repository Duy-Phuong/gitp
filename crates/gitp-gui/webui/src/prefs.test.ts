import { describe, it, expect } from "vitest";
import { nextToggleTheme, withFavoriteToggled } from "./prefs";

describe("withFavoriteToggled", () => {
  it("stars a repo at the end, so earlier favorites keep their shortcut", () => {
    expect(withFavoriteToggled(["/a", "/b"], "/c")).toEqual(["/a", "/b", "/c"]);
  });

  it("unstars a starred repo and closes the gap", () => {
    expect(withFavoriteToggled(["/a", "/b", "/c"], "/b")).toEqual(["/a", "/c"]);
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
