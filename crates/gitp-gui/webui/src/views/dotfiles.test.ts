import { describe, expect, it } from "vitest";

import { summariseApply } from "./dotfiles";

describe("summariseApply", () => {
  it("lists written files and backups on separate lines", () => {
    const out = summariseApply({
      written: ["/h/.gitconfig", "/h/.tigrc"],
      backups: ["/h/.gitconfig.bak-20261017-080910"],
    });
    expect(out.split("\n")).toEqual([
      "Applied template: wrote 2 file(s).",
      "  /h/.gitconfig",
      "  /h/.tigrc",
      "Backed up:",
      "  /h/.gitconfig.bak-20261017-080910",
    ]);
  });

  it("says so when nothing was written", () => {
    expect(summariseApply({ written: [], backups: [] })).toMatch(/no files/);
  });
});
