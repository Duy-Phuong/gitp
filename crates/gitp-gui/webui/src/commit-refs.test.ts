import { describe, it, expect } from "vitest";
import { mergeTipRefs } from "./commit-refs";
import type { BranchRef } from "./types";

function branch(name: string, target: string, is_head = false): BranchRef {
  return { name, target, is_head, ahead: 0, behind: 0, has_upstream: true };
}

describe("mergeTipRefs", () => {
  it("merges a local branch and its remote copy on the same commit into one badge", () => {
    const tips = mergeTipRefs(
      [branch("dev", "c1")],
      [{ remote: "origin", name: "origin/dev", target: "c1" }],
      [],
    );
    expect(tips.get("c1")).toEqual([
      { name: "dev", kind: "branch", head: false, local: true, remotes: ["origin/dev"] },
    ]);
  });

  it("keeps them apart when the remote copy is on another commit", () => {
    const tips = mergeTipRefs(
      [branch("dev", "c1")],
      [{ remote: "origin", name: "origin/dev", target: "c2" }],
      [],
    );
    expect(tips.get("c1")?.[0]).toMatchObject({ name: "dev", local: true, remotes: [] });
    expect(tips.get("c2")?.[0]).toMatchObject({ name: "dev", local: false, remotes: ["origin/dev"] });
  });

  it("strips only the remote's own prefix from a slashed branch name", () => {
    const tips = mergeTipRefs(
      [branch("feature/a", "c1")],
      [
        { remote: "origin", name: "origin/feature/a", target: "c1" },
        { remote: "upstream", name: "upstream/feature/a", target: "c1" },
      ],
      [],
    );
    expect(tips.get("c1")).toEqual([
      {
        name: "feature/a",
        kind: "branch",
        head: false,
        local: true,
        remotes: ["origin/feature/a", "upstream/feature/a"],
      },
    ]);
  });

  it("puts the checked-out branch first and tags last", () => {
    const tips = mergeTipRefs(
      [branch("other", "c1"), branch("main", "c1", true)],
      [{ remote: "origin", name: "origin/remote-only", target: "c1" }],
      [{ name: "v1.0", target: "c1", message: null }],
    );
    expect(tips.get("c1")?.map((t) => t.name)).toEqual(["main", "other", "remote-only", "v1.0"]);
  });

  it("carries an annotated tag's message for the badge tooltip", () => {
    const tips = mergeTipRefs([], [], [{ name: "v2.0", target: "c1", message: "Release 2" }]);
    expect(tips.get("c1")?.[0]).toMatchObject({ name: "v2.0", kind: "tag", message: "Release 2" });
  });
});
