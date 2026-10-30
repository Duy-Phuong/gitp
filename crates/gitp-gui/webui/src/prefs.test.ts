import { describe, it, expect } from "vitest";
import { withFavoriteToggled } from "./prefs";

describe("withFavoriteToggled", () => {
  it("stars a repo at the end, so earlier favorites keep their shortcut", () => {
    expect(withFavoriteToggled(["/a", "/b"], "/c")).toEqual(["/a", "/b", "/c"]);
  });

  it("unstars a starred repo and closes the gap", () => {
    expect(withFavoriteToggled(["/a", "/b", "/c"], "/b")).toEqual(["/a", "/c"]);
  });
});
