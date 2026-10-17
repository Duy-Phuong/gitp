import { describe, expect, it } from "vitest";

import { formatGitProgress } from "./git-progress";
import type { GitProgress } from "./types";

function p(phase: string, percent: number | null, detail: string): GitProgress {
  return { op: "fetch", phase, percent, detail, cancellable: true };
}

describe("formatGitProgress", () => {
  it("shows the phase and percentage", () => {
    expect(formatGitProgress(p("Compressing objects", 66, "(2/3)"))).toBe("Compressing objects 66%");
  });

  it("adds the transfer rate when git reports one", () => {
    expect(formatGitProgress(p("Receiving objects", 45, "(450/1000), 1.2 MiB | 2.0 MiB/s"))).toBe(
      "Receiving objects 45% · 2.0 MiB/s",
    );
  });

  it("drops git's trailing 'done.' from the rate", () => {
    expect(formatGitProgress(p("Writing objects", 100, "(3/3), 272 bytes | 272.00 KiB/s, done."))).toBe(
      "Writing objects 100% · 272.00 KiB/s",
    );
  });

  it("shows a counter with no total as just the phase", () => {
    expect(formatGitProgress(p("Enumerating objects", null, "5, done."))).toBe("Enumerating objects");
  });

  it("shows 0% rather than hiding it", () => {
    expect(formatGitProgress(p("Counting objects", 0, "(1/102)"))).toBe("Counting objects 0%");
  });
});
