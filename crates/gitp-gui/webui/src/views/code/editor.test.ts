import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutoSave, languageFor } from "./editor";

describe("languageFor", () => {
  it("returns a language extension for each of the four languages and nothing otherwise", () => {
    for (const lang of ["java", "javascript", "typescript", "tsx", "python"] as const) {
      expect(languageFor(lang)).not.toEqual([]);
    }
    expect(languageFor(null)).toEqual([]);
  });
});

describe("AutoSave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("an edit marks the file dirty and saves it after 1500 ms idle", async () => {
    const saved: string[] = [];
    const dirty: [string, boolean][] = [];
    const a = new AutoSave({ save: async (p) => void saved.push(p), onDirty: (p, d) => void dirty.push([p, d]) });
    a.edited("a.ts");
    expect(dirty).toEqual([["a.ts", true]]);
    await vi.advanceTimersByTimeAsync(1400);
    expect(saved).toEqual([]);
    a.edited("a.ts"); // typing again restarts the clock
    await vi.advanceTimersByTimeAsync(1400);
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(saved).toEqual(["a.ts"]);
    expect(dirty).toEqual([["a.ts", true], ["a.ts", false]]);
  });

  it("saveNow saves at once and cancels the pending timer", async () => {
    const saved: string[] = [];
    const a = new AutoSave({ save: async (p) => void saved.push(p), onDirty: () => {} });
    a.edited("a.ts");
    await a.saveNow("a.ts");
    expect(saved).toEqual(["a.ts"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(saved).toEqual(["a.ts"]);
  });

  it("a failed save keeps the file dirty and reports the error", async () => {
    const errors: string[] = [];
    const dirty: boolean[] = [];
    const a = new AutoSave({
      save: async () => {
        throw new Error("changed_on_disk");
      },
      onDirty: (_, d) => void dirty.push(d),
      onError: (_, e) => void errors.push(String(e)),
    });
    a.edited("a.ts");
    await a.saveNow("a.ts");
    expect(dirty).toEqual([true]);
    expect(errors).toEqual(["Error: changed_on_disk"]);
  });

  it("saveNow with nothing pending does nothing", async () => {
    const saved: string[] = [];
    const a = new AutoSave({ save: async (p) => void saved.push(p), onDirty: () => {} });
    await a.saveNow("a.ts");
    expect(saved).toEqual([]);
  });

  it("forget drops a pending save", async () => {
    const saved: string[] = [];
    const a = new AutoSave({ save: async (p) => void saved.push(p), onDirty: () => {} });
    a.edited("a.ts");
    a.forget("a.ts");
    await vi.advanceTimersByTimeAsync(2000);
    expect(saved).toEqual([]);
    expect(a.isDirty("a.ts")).toBe(false);
  });

  it("an edit typed while a save is in flight is saved afterwards, not dropped", async () => {
    let release!: () => void;
    const saves: string[] = [];
    const dirty: boolean[] = [];
    const a = new AutoSave({
      save: (p) =>
        new Promise<void>((r) => {
          saves.push(p);
          release = r;
        }),
      onDirty: (_, d) => void dirty.push(d),
    });
    a.edited("a.ts");
    const first = a.saveNow("a.ts");
    a.edited("a.ts"); // typed while the write is on its way
    release();
    await first;
    expect(a.isDirty("a.ts")).toBe(true);
    expect(dirty).toEqual([true]);
    await vi.advanceTimersByTimeAsync(1500);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual(["a.ts", "a.ts"]);
    expect(a.isDirty("a.ts")).toBe(false);
  });

  it("a second saveNow during a save waits for the first instead of racing it", async () => {
    let release!: () => void;
    let calls = 0;
    const a = new AutoSave({
      save: () =>
        new Promise<void>((r) => {
          calls++;
          release = r;
        }),
      onDirty: () => {},
    });
    a.edited("a.ts");
    const first = a.saveNow("a.ts");
    const second = a.saveNow("a.ts");
    expect(calls).toBe(1);
    release();
    await first;
    await second;
    expect(calls).toBe(1);
  });

  it("saveNow resolves false when the save failed", async () => {
    const a = new AutoSave({
      save: async () => {
        throw new Error("changed_on_disk");
      },
      onDirty: () => {},
      onError: () => {},
    });
    a.edited("a.ts");
    expect(await a.saveNow("a.ts")).toBe(false);
    a.forget("a.ts");
    expect(await a.saveNow("a.ts")).toBe(true);
  });
});
