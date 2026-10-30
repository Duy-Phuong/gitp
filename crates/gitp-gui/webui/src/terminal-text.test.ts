import { describe, expect, it } from "vitest";

import { shellQuote, tabNumber } from "./terminal-text";

describe("tabNumber", () => {
  it("counts from 1", () => {
    expect(tabNumber([])).toBe(1);
    expect(tabNumber([1, 2])).toBe(3);
  });

  it("reuses the lowest free number", () => {
    expect(tabNumber([1, 3])).toBe(2);
    expect(tabNumber([2])).toBe(1);
  });
});

describe("shellQuote", () => {
  it("leaves a plain path alone", () => {
    expect(shellQuote("/Users/me/code/app/src/main.rs")).toBe("/Users/me/code/app/src/main.rs");
    expect(shellQuote("web-ui/a_b.test.ts")).toBe("web-ui/a_b.test.ts");
  });

  it("single-quotes spaces and shell syntax", () => {
    expect(shellQuote("/tmp/my file.txt")).toBe("'/tmp/my file.txt'");
    expect(shellQuote("a$(rm -rf ~)`x`;b&c")).toBe("'a$(rm -rf ~)`x`;b&c'");
    expect(shellQuote("*.log")).toBe("'*.log'");
    expect(shellQuote("~/x")).toBe("'~/x'");
  });

  it("escapes a single quote by closing and reopening", () => {
    expect(shellQuote("it's.txt")).toBe(`'it'\\''s.txt'`);
  });

  it("quotes an empty path rather than dropping it", () => {
    expect(shellQuote("")).toBe("''");
  });
});
