import { describe, expect, it, vi, afterEach } from "vitest";

import { formatTime, relativeTime } from "./timeago";

// A fixed "now" so the expectations are about the formatter, not the clock.
const NOW_SECONDS = 1_700_000_000;

function at(secondsAgo: number): string {
  vi.setSystemTime(NOW_SECONDS * 1000);
  return relativeTime(NOW_SECONDS - secondsAgo);
}

describe("relativeTime", () => {
  afterEach(() => vi.useRealTimers());

  it("reads as just now under a minute", () => {
    vi.useFakeTimers();
    expect(at(0)).toBe("just now");
    expect(at(59)).toBe("just now");
  });

  it("switches to whole units as each is reached", () => {
    vi.useFakeTimers();
    expect(at(60)).toBe("1m ago");
    expect(at(3599)).toBe("59m ago");
    expect(at(3600)).toBe("1h ago");
    expect(at(86_399)).toBe("23h ago");
    expect(at(86_400)).toBe("1d ago");
    expect(at(604_800)).toBe("1w ago");
    expect(at(2_592_000)).toBe("1mo ago");
    expect(at(31_536_000)).toBe("1y ago");
  });

  it("truncates rather than rounding up, so a label never overstates the age", () => {
    vi.useFakeTimers();
    // 119s is 1m 59s — "1m ago", not "2m ago".
    expect(at(119)).toBe("1m ago");
  });

  it("treats a future timestamp as just now instead of a negative age", () => {
    vi.useFakeTimers();
    expect(at(-120)).toBe("just now");
  });
});

describe("formatTime", () => {
  afterEach(() => vi.useRealTimers());

  // 2026-10-30 14:05:09 in whatever zone the tests run in: the absolute form
  // is local time, so the instant is built from local fields.
  const local = new Date(2026, 9, 30, 14, 5, 9).getTime() / 1000;

  it("relative is the compact age", () => {
    vi.useFakeTimers();
    vi.setSystemTime((local + 3 * 3600) * 1000);
    expect(formatTime(local, "relative")).toBe("3h ago");
  });

  it("absolute is year-month-day hour:minute, zero-padded, in local time", () => {
    expect(formatTime(local, "absolute")).toBe("2026-10-30 14:05");
    expect(formatTime(new Date(2026, 0, 2, 3, 4).getTime() / 1000, "absolute")).toBe("2026-01-02 03:04");
  });

  it("locale is the locale's own short date and time", () => {
    const expected = new Date(local * 1000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
    expect(formatTime(local, "locale")).toBe(expected);
  });
});
