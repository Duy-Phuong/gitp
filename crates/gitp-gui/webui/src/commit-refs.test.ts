import { describe, it, expect } from "vitest";
import { branchReach, ghostBranch, mergeTipRefs, rebuildCommitRefs, refLabelsAt } from "./commit-refs";
import { EMPTY_REFS, state } from "./app-state";
import type { BranchRef, CommitRow } from "./types";

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

function commit(id: string, parents: string[]): CommitRow {
  return { id, short_id: id, summary: id, author_name: "a", author_email: "a@x", time: 0, parents, lane: 0, color: 0 };
}

// main: m2 -> m1 -> base; feature: f1 -> base, with origin/feature one behind
// at base. Newest first, children before parents.
function loadGraph(): void {
  state.rows = [commit("m2", ["m1"]), commit("f1", ["base"]), commit("m1", ["base"]), commit("base", [])];
  state.refs = {
    ...EMPTY_REFS,
    branches: [branch("main", "m2", true), branch("feature", "f1")],
    remotes: [{ remote: "origin", name: "origin/feature", target: "base" }],
  };
  rebuildCommitRefs();
}

describe("ghostBranch", () => {
  it("names the nearest branch containing a commit no ref points at", () => {
    loadGraph();
    expect(ghostBranch(refLabelsAt("m1"))).toBe("main");
  });

  it("is null on a commit that has a badge of its own", () => {
    loadGraph();
    expect(ghostBranch(refLabelsAt("m2"))).toBe(null);
    expect(ghostBranch(refLabelsAt("f1"))).toBe(null);
  });

  it("prefers the nearer branch over the checked-out one", () => {
    state.rows = [commit("m3", ["m2"]), commit("m2", ["m1"]), commit("f1", ["m1"]), commit("m1", [])];
    state.refs = { ...EMPTY_REFS, branches: [branch("main", "m3", true), branch("feature", "f1")] };
    rebuildCommitRefs();
    expect(ghostBranch(refLabelsAt("m2"))).toBe("main");
    expect(ghostBranch(refLabelsAt("m1"))).toBe("feature");
  });
});

describe("branchReach", () => {
  it("keeps a local branch's commits, from the containment bitsets", () => {
    loadGraph();
    const on = branchReach({ kind: "local", name: "feature" })!;
    expect(state.rows.filter((r) => on(r.id)).map((r) => r.id)).toEqual(["f1", "base"]);
  });

  it("walks a remote branch from its tip", () => {
    loadGraph();
    const on = branchReach({ kind: "remote", name: "origin/feature" })!;
    expect(state.rows.filter((r) => on(r.id)).map((r) => r.id)).toEqual(["base"]);
  });

  it("answers a remote branch's rows in any order", () => {
    // The walk goes only as far down as asked: a deep row first, then one
    // above it, must give what a full walk would.
    state.rows = [commit("x", ["a"]), commit("a", ["b"]), commit("y", ["c"]), commit("b", ["c"]), commit("c", [])];
    state.refs = { ...EMPTY_REFS, remotes: [{ remote: "origin", name: "origin/a", target: "a" }] };
    rebuildCommitRefs();
    const on = branchReach({ kind: "remote", name: "origin/a" })!;
    expect(on("c")).toBe(true);
    expect(on("x")).toBe(false);
    expect(on("y")).toBe(false);
    expect(on("b")).toBe(true);
    expect(on("a")).toBe(true);
  });

  it("never fades a commit outside the loaded log", () => {
    loadGraph();
    expect(branchReach({ kind: "local", name: "feature" })!("elsewhere")).toBe(true);
  });

  it("fades every loaded commit for a branch whose tip isn't loaded", () => {
    loadGraph();
    const on = branchReach({ kind: "remote", name: "origin/gone" })!;
    expect(state.rows.some((r) => on(r.id))).toBe(false);
  });
});
