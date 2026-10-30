import { describe, expect, it } from "vitest";

import { pushTargets } from "./push-targets";

describe("pushTargets", () => {
  it("puts the tracked remote first, then the others", () => {
    expect(pushTargets("upstream", ["fork", "origin", "upstream"])).toEqual(["upstream", "fork", "origin"]);
  });

  it("defaults to origin without an upstream", () => {
    expect(pushTargets(null, ["fork", "origin"])).toEqual(["origin", "fork"]);
  });

  it("uses the only remote when it isn't called origin", () => {
    expect(pushTargets(undefined, ["github"])).toEqual(["github"]);
  });

  it("ignores an upstream that isn't a configured remote", () => {
    expect(pushTargets(".", ["fork", "origin"])).toEqual(["origin", "fork"]);
  });

  it("still names origin with no remotes, so git explains", () => {
    expect(pushTargets(null, [])).toEqual(["origin"]);
  });
});
