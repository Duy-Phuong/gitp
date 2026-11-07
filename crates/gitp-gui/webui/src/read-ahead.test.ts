// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readAhead, resetReadAhead, takeReadAhead, whenPointedAt } from "./read-ahead";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  resetReadAhead();
  vi.useRealTimers();
});

describe("reading a pull request ahead", () => {
  it("opening takes the read started ahead, once", async () => {
    const fetch = vi.fn(async () => "detail");
    readAhead("r#7", fetch);
    readAhead("r#7", fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(takeReadAhead("r#7")).resolves.toBe("detail");
    expect(takeReadAhead("r#7")).toBeNull();
  });

  it("a read for another pull request, or an old one, is not taken", () => {
    readAhead("r#7", async () => "seven");
    expect(takeReadAhead("r#8")).toBeNull();
    readAhead("r#9", async () => "nine");
    vi.advanceTimersByTime(10_001);
    expect(takeReadAhead("r#9")).toBeNull();
  });

  it("a read ahead that failed is not taken: opening reads again", async () => {
    readAhead("r#7", async () => {
      throw new Error("offline");
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(takeReadAhead("r#7")).toBeNull();
  });

  it("starts only when the pointer rests on the row", () => {
    const row = document.createElement("div");
    const start = vi.fn();
    whenPointedAt(row, start);
    row.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(100);
    row.dispatchEvent(new Event("mouseleave"));
    vi.advanceTimersByTime(500);
    expect(start).not.toHaveBeenCalled();
    row.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(150);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
