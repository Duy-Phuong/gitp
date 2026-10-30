import { describe, expect, it } from "vitest";

import { authorInitials } from "./avatar";

describe("authorInitials", () => {
  it("takes the first and last word's first letters", () => {
    expect(authorInitials("Ada King Lovelace")).toBe("AL");
    expect(authorInitials("  grace   hopper ")).toBe("GH");
  });

  it("is one letter for a one-word name and ? for none", () => {
    expect(authorInitials("linus")).toBe("L");
    expect(authorInitials("")).toBe("?");
  });

  it("keeps a non-BMP first letter whole", () => {
    expect(authorInitials("𝒜da Lovelace")).toBe("𝒜L");
  });
});
