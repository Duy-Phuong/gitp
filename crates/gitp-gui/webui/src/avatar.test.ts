import { describe, expect, it } from "vitest";

import { authorInitials, CUSTOM_AVATARS, customAvatar } from "./avatar";

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

describe("custom avatars", () => {
  const urls = ["/a.jpg", "/b.jpg", "/c.jpg"];

  it("gives an author the same picture every time, whatever the email's case", () => {
    const first = customAvatar("ada@example.com", urls);
    expect(urls).toContain(first);
    expect(customAvatar(" ADA@example.com ", urls)).toBe(first);
  });

  it("spreads authors over the pictures", () => {
    const picked = new Set(Array.from({ length: 30 }, (_, i) => customAvatar(`dev${i}@example.com`, urls)));
    expect(picked.size).toBe(3);
  });

  it("ships the pictures from src/assets/avatars", () => {
    expect(CUSTOM_AVATARS.length).toBeGreaterThan(20);
  });
});
