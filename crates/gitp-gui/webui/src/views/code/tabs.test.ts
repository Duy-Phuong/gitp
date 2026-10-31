import { describe, expect, it, vi } from "vitest";

import { Tabs } from "./tabs";

const info = { dirty: false, changedOnDisk: false, deleted: false, mtime: 1, crlf: false };

describe("Tabs", () => {
  it("open activates the tab and does not duplicate it", () => {
    const t = new Tabs();
    t.open("a.ts", info);
    t.open("b.ts", info);
    t.open("a.ts", info);
    expect(t.list().map((x) => x.path)).toEqual(["a.ts", "b.ts"]);
    expect(t.active()).toBe("a.ts");
  });

  it("close activates the neighbour on the left, else the right", () => {
    const t = new Tabs();
    t.open("a.ts", info);
    t.open("b.ts", info);
    t.open("c.ts", info);
    expect(t.close("c.ts")).toBe("b.ts");
    expect(t.active()).toBe("b.ts");
    t.open("a.ts", info);
    expect(t.close("a.ts")).toBe("b.ts");
    expect(t.close("b.ts")).toBeNull();
    expect(t.list()).toEqual([]);
    expect(t.active()).toBeNull();
  });

  it("closing an inactive tab keeps the active one", () => {
    const t = new Tabs();
    t.open("a.ts", info);
    t.open("b.ts", info);
    expect(t.close("a.ts")).toBe("b.ts");
  });

  it("flags round-trip", () => {
    const t = new Tabs();
    t.open("a.ts", info);
    t.setDirty("a.ts", true);
    t.setChangedOnDisk("a.ts", true);
    t.setDeleted("a.ts", true);
    t.setMtime("a.ts", 42);
    expect(t.get("a.ts")).toEqual({ path: "a.ts", dirty: true, changedOnDisk: true, deleted: true, mtime: 42, crlf: false });
    t.setDirty("missing.ts", true); // harmless
  });

  it("onChange fires once per mutation with the list and the active path", () => {
    const t = new Tabs();
    const cb = vi.fn();
    t.onChange(cb);
    t.open("a.ts", info);
    t.setDirty("a.ts", true);
    t.close("a.ts");
    expect(cb).toHaveBeenCalledTimes(3);
    expect(cb).toHaveBeenLastCalledWith([], null);
  });
});
