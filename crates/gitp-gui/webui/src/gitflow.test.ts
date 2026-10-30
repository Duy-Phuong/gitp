import { describe, expect, it } from "vitest";
import { finishSteps, flowBranch, suggestedGitflowConfig } from "./gitflow";
import type { GitFlowConfig } from "./types";

const cfg: GitFlowConfig = {
  production: "main",
  develop: "develop",
  feature: "feature/",
  release: "release/",
  hotfix: "hotfix/",
  version_tag: "v",
};

describe("flowBranch", () => {
  it("names the kind and strips the prefix", () => {
    expect(flowBranch(cfg, "feature/login")).toEqual({ kind: "Feature", name: "login" });
    expect(flowBranch(cfg, "release/1.2")).toEqual({ kind: "Release", name: "1.2" });
    expect(flowBranch(cfg, "hotfix/1.2.1")).toEqual({ kind: "Hotfix", name: "1.2.1" });
  });

  it("is null for other branches, a bare prefix, or without Git Flow", () => {
    expect(flowBranch(cfg, "main")).toBeNull();
    expect(flowBranch(cfg, "feature/")).toBeNull();
    expect(flowBranch(cfg, "features/x")).toBeNull();
    expect(flowBranch(null, "feature/login")).toBeNull();
  });
});

describe("finishSteps", () => {
  it("merges a feature into develop", () => {
    expect(finishSteps(cfg, "Feature", "feature/login", "login")).toEqual([
      "merge feature/login into develop",
      "delete feature/login",
    ]);
  });

  it("merges a release into production, tags it, and merges it back", () => {
    expect(finishSteps(cfg, "Release", "release/1.2", "1.2")).toEqual([
      "merge release/1.2 into main",
      "tag it v1.2",
      "merge release/1.2 into develop",
      "delete release/1.2",
    ]);
  });
});

describe("suggestedGitflowConfig", () => {
  it("keeps the settings already there", () => {
    expect(suggestedGitflowConfig(cfg, ["trunk"])).toEqual(cfg);
  });

  it("suggests main or master as production, else the first branch", () => {
    expect(suggestedGitflowConfig(null, ["dev", "master"]).production).toBe("master");
    expect(suggestedGitflowConfig(null, ["main", "master"]).production).toBe("main");
    expect(suggestedGitflowConfig(null, ["trunk"]).production).toBe("trunk");
    expect(suggestedGitflowConfig(null, []).develop).toBe("develop");
  });
});
