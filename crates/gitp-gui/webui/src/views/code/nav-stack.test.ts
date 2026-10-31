import { describe, expect, it } from "vitest";

import { NavStack } from "./nav-stack";
import type { Location } from "../../types";

const at = (path: string, line: number, col = 0): Location => ({ path, line, col });

describe("NavStack", () => {
  it("push records where you were and where you landed", () => {
    const s = new NavStack();
    s.push(at("a.ts", 10), at("b.ts", 3));
    expect(s.canBack()).toBe(true);
    expect(s.canForward()).toBe(false);
    expect(s.back()).toEqual(at("a.ts", 10));
    expect(s.canBack()).toBe(false);
  });

  it("back then forward round-trips", () => {
    const s = new NavStack();
    s.push(at("a.ts", 1), at("b.ts", 2));
    s.push(null, at("c.ts", 3));
    expect(s.back()).toEqual(at("b.ts", 2));
    expect(s.back()).toEqual(at("a.ts", 1));
    expect(s.back()).toBeNull();
    expect(s.forward()).toEqual(at("b.ts", 2));
    expect(s.forward()).toEqual(at("c.ts", 3));
    expect(s.forward()).toBeNull();
  });

  it("a push after going back drops the forward branch", () => {
    const s = new NavStack();
    s.push(at("a.ts", 1), at("b.ts", 2));
    s.push(null, at("c.ts", 3));
    s.back();
    s.push(null, at("d.ts", 4));
    expect(s.canForward()).toBe(false);
    expect(s.back()).toEqual(at("b.ts", 2));
  });

  it("small caret moves update the current stop instead of adding one", () => {
    const s = new NavStack();
    s.push(null, at("a.ts", 10));
    s.caretMoved(at("a.ts", 20, 4));
    expect(s.canBack()).toBe(false);
    s.push(null, at("b.ts", 1));
    expect(s.back()).toEqual(at("a.ts", 20, 4));
  });

  it("a caret move of more than 10 lines adds a stop", () => {
    const s = new NavStack();
    s.push(null, at("a.ts", 10));
    s.caretMoved(at("a.ts", 21));
    expect(s.canBack()).toBe(true);
    expect(s.back()).toEqual(at("a.ts", 10));
  });

  it("silently() does not record the move it causes", () => {
    const s = new NavStack();
    s.push(null, at("a.ts", 10));
    s.silently(() => s.caretMoved(at("z.ts", 99)));
    expect(s.canBack()).toBe(false);
  });

  it("caps at 100 stops, dropping the oldest", () => {
    const s = new NavStack();
    for (let i = 0; i < 150; i++) s.push(null, at("a.ts", i * 100));
    let n = 0;
    while (s.back()) n++;
    expect(n).toBe(99);
  });

  it("a push to the line you are already on is merged", () => {
    const s = new NavStack();
    s.push(null, at("a.ts", 5, 1));
    s.push(null, at("a.ts", 5, 9));
    expect(s.canBack()).toBe(false);
    s.push(null, at("b.ts", 1));
    expect(s.back()).toEqual(at("a.ts", 5, 9));
  });
});
