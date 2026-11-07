// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pausePollingFor, startPolling } from "./poller";

let hidden = false;
const stops: (() => void)[] = [];
const start = (key: string, ms: number, tick: () => Promise<void> | void) => {
  const stop = startPolling(key, ms, tick);
  stops.push(stop);
  return stop;
};
const blur = () => window.dispatchEvent(new Event("blur"));
const focus = () => window.dispatchEvent(new Event("focus"));
const setHidden = (h: boolean) => {
  hidden = h;
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  focus();
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  pausePollingFor(0);
  vi.useRealTimers();
});

describe("startPolling", () => {
  it("ticks every interval while focused", async () => {
    const tick = vi.fn();
    start("a", 1000, tick);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("stops when its stop function is called", async () => {
    const tick = vi.fn();
    const stop = start("a", 1000, tick);
    stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick).not.toHaveBeenCalled();
  });

  it("pauses while the window is blurred and polls at once on focus", async () => {
    const tick = vi.fn();
    start("a", 1000, tick);
    blur();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).not.toHaveBeenCalled();
    focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    // Then on the interval again, counted from the refocus.
    await vi.advanceTimersByTimeAsync(999);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("does not tick on a focus while already focused", async () => {
    const tick = vi.fn();
    start("a", 1000, tick);
    focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).not.toHaveBeenCalled();
  });

  it("pauses while the document is hidden", async () => {
    const tick = vi.fn();
    start("a", 1000, tick);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).not.toHaveBeenCalled();
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("a new start with the same key replaces the old", async () => {
    const first = vi.fn();
    const second = vi.fn();
    start("a", 1000, first);
    start("a", 1000, second);
    await vi.advanceTimersByTimeAsync(2000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("keys run side by side", async () => {
    const a = vi.fn();
    const b = vi.fn();
    start("a", 1000, a);
    start("b", 2000, b);
    await vi.advanceTimersByTimeAsync(4000);
    expect(a).toHaveBeenCalledTimes(4);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("a stale stop does not stop the replacement", async () => {
    const second = vi.fn();
    const staleStop = start("a", 1000, vi.fn());
    start("a", 1000, second);
    staleStop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not start a tick while the last is still running", async () => {
    let release: () => void = () => undefined;
    const tick = vi.fn(() => new Promise<void>((r) => (release = r)));
    start("a", 1000, tick);
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("a failing tick does not stop polling", async () => {
    const tick = vi.fn(() => Promise.reject(new Error("offline")));
    start("a", 1000, tick);
    await vi.advanceTimersByTimeAsync(2000);
    expect(tick).toHaveBeenCalledTimes(2);
  });
});

describe("pausePollingFor", () => {
  it("skips ticks of every key until it ends", async () => {
    const a = vi.fn();
    const b = vi.fn();
    start("a", 1000, a);
    start("b", 1000, b);
    pausePollingFor(10_000);
    await vi.advanceTimersByTimeAsync(9000);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    // A refocus during the pause doesn't poll either.
    blur();
    focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(a).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });
});
