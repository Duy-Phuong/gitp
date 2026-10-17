import { describe, expect, it } from "vitest";

import { describeSubmoduleChange, parseSubmoduleDiff } from "./submodule-diff";
import type { FileDiff } from "./types";

const A = "a".repeat(40);
const B = "b".repeat(40);

function diff(...lines: string[]): FileDiff {
  return {
    path: "lib",
    old_path: null,
    status: "Modified",
    hunks: [
      {
        header: "@@ -1 +1 @@",
        lines: lines.map((l) => ({ origin: l[0], old_lineno: null, new_lineno: null, content: l.slice(1) })),
      },
    ],
  };
}

describe("parseSubmoduleDiff", () => {
  it("reads the recorded commit before and after", () => {
    const c = parseSubmoduleDiff(diff(`-Subproject commit ${A}`, `+Subproject commit ${B}`));
    expect(c).toEqual({ from: A, to: B, dirty: false });
    expect(describeSubmoduleChange(c!)).toBe("aaaaaaa → bbbbbbb");
  });

  it("notices local changes inside the submodule", () => {
    const c = parseSubmoduleDiff(diff(`-Subproject commit ${A}`, `+Subproject commit ${A}-dirty`));
    expect(c).toEqual({ from: A, to: A, dirty: true });
    expect(describeSubmoduleChange(c!)).toBe("aaaaaaa with local changes");
  });

  it("handles a submodule being added or removed", () => {
    expect(describeSubmoduleChange(parseSubmoduleDiff(diff(`+Subproject commit ${B}`))!)).toBe("added at bbbbbbb");
    expect(describeSubmoduleChange(parseSubmoduleDiff(diff(`-Subproject commit ${A}`))!)).toBe(
      "removed (was aaaaaaa)",
    );
  });

  it("leaves ordinary files alone, even ones mentioning a subproject", () => {
    expect(parseSubmoduleDiff(diff(" context", `+Subproject commit ${B}`))).toBeNull();
    expect(parseSubmoduleDiff(diff("-old line", "+new line"))).toBeNull();
    expect(parseSubmoduleDiff({ ...diff(), hunks: [] })).toBeNull();
  });
});
