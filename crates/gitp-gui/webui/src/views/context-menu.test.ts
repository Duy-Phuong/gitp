import { describe, expect, it } from "vitest";

import { clampMenu } from "./context-menu";

describe("clampMenu", () => {
  it("opens at the cursor when the menu fits", () => {
    expect(clampMenu(100, 200, 180, 120, 1000, 800)).toEqual({ left: 100, top: 200 });
  });

  it("pulls a menu that runs off the right or bottom edge back on screen", () => {
    expect(clampMenu(900, 700, 180, 120, 1000, 800)).toEqual({ left: 816, top: 676 });
  });

  it("keeps a menu taller than the window at the top, not above it", () => {
    expect(clampMenu(100, 700, 180, 900, 1000, 800)).toEqual({ left: 100, top: 4 });
  });
});
