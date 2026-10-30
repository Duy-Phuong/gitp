import { describe, expect, it } from "vitest";

import { describeLfsPointer, parseLfsPointerDiff } from "./lfs-pointer";
import type { FileDiff } from "./types";

const A = "a".repeat(64);
const B = "b".repeat(64);
const VERSION = "version https://git-lfs.github.com/spec/v1";

function diff(...lines: string[]): FileDiff {
  return {
    path: "art/logo.psd",
    old_path: null,
    status: "Modified",
    hunks: [
      {
        header: "@@ -1,3 +1,3 @@",
        lines: lines.map((l) => ({ origin: l[0], old_lineno: null, new_lineno: null, content: l.slice(1) })),
      },
    ],
  };
}

describe("parseLfsPointerDiff", () => {
  it("reads both sides of a changed pointer", () => {
    expect(parseLfsPointerDiff(diff(` ${VERSION}`, `-oid sha256:${A}`, `-size 10`, `+oid sha256:${B}`, `+size 2048`))).toEqual({
      from: { oid: A, size: 10 },
      to: { oid: B, size: 2048 },
    });
  });

  it("reads an added pointer, and a size left out of the context", () => {
    expect(parseLfsPointerDiff(diff(`+${VERSION}`, `+oid sha256:${B}`, `+size 5`))).toEqual({
      from: null,
      to: { oid: B, size: 5 },
    });
    expect(parseLfsPointerDiff(diff(`-oid sha256:${A}`, `+oid sha256:${B}`))).toEqual({
      from: { oid: A, size: null },
      to: { oid: B, size: null },
    });
  });

  it("is null for ordinary text, or text that only mentions a pointer line", () => {
    expect(parseLfsPointerDiff(diff("-hello", "+world"))).toBeNull();
    expect(parseLfsPointerDiff(diff(`+${VERSION}`, "+oid sha256:short", "+size 5"))).toBeNull();
    expect(parseLfsPointerDiff(diff(`+${VERSION}`, `+oid sha256:${B}`, "+size 5", "+more"))).toBeNull();
    expect(parseLfsPointerDiff({ ...diff(), hunks: [] })).toBeNull();
  });
});

describe("describeLfsPointer", () => {
  it("shortens the id and gives the size", () => {
    expect(describeLfsPointer({ oid: A, size: 2048 })).toBe(`sha256:${"a".repeat(12)}… · 2.0 KB`);
    expect(describeLfsPointer({ oid: A, size: null })).toBe(`sha256:${"a".repeat(12)}…`);
  });
});
