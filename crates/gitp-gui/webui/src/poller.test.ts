// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pausePollingFor, startPolling } from "./poller";

const stops: (() => void)[] = [];
function poll(key: string, ms: number, tick: () => Promise<void> | void) {
  const stop = startPolling(key, ms, tick);
  stops.push(stop);
  return stop;
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

// Each test an hour after the last, so no pause carries over.
let clock = Date.now();
beforeEach(() => {
  vi.useFakeTimers({ now: (clock += 3_600_000) });
  setHidden(false);
  window.dispatchEvent(new Event("focus"));
});
afterEach(() => {
  stops.splice(0).forEach((s) => s());
  vi.useRealTimers();
});

describe("the poller", () => {
  it("ticks every interval, not at the start", async () => {
    const tick = vi.fn();
    poll("a", 1000, tick);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("pauses while the window is unfocused and ticks at once on refocus", async () => {
    const tick = vi.fn();
    poll("a", 1000, tick);
    window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("pauses while the document is hidden and ticks when it shows", async () => {
    const tick = vi.fn();
    poll("a", 1000, tick);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).not.toHaveBeenCalled();
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("keeps one timer per key: a new start replaces the old", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = poll("a", 1000, first);
    poll("a", 1000, second);
    stopFirst(); // the replaced one's stop leaves the new one alone
    await vi.advanceTimersByTimeAsync(2000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("stops", async () => {
    const tick = vi.fn();
    const stop = poll("a", 1000, tick);
    stop();
    await vi.advanceTimersByTimeAsync(3000);
    window.dispatchEvent(new Event("focus"));
    expect(tick).not.toHaveBeenCalled();
  });

  it("skips the ticks inside a pause", async () => {
    const tick = vi.fn();
    poll("a", 1000, tick);
    pausePollingFor(2500);
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick).toHaveBeenCalledTimes(1); // the one at 3 s
  });

  it("does not start a tick while the previous one is still running", async () => {
    let finish = () => {};
    const tick = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    poll("a", 1000, tick);
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("survives a tick that throws", async () => {
    const tick = vi.fn(() => {
      throw new Error("boom");
    });
    poll("a", 1000, tick);
    await vi.advanceTimersByTimeAsync(2000);
    expect(tick).toHaveBeenCalledTimes(2);
  });
});
