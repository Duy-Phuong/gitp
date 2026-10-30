// Git Flow's rules as the menus need them: which branches are feature /
// release / hotfix branches, what finishing one does, and the settings
// Initialize suggests. The git side is gitp-core's gitflow.rs.

import type { FlowKind, GitFlowConfig } from "./types";

export const FLOW_KINDS: FlowKind[] = ["Feature", "Release", "Hotfix"];

function prefix(cfg: GitFlowConfig, kind: FlowKind): string {
  return kind === "Feature" ? cfg.feature : kind === "Release" ? cfg.release : cfg.hotfix;
}

// The kind of Git Flow branch `branch` is and its name without the prefix, or
// null when it isn't one (or Git Flow isn't set up). Same rule as the backend.
export function flowBranch(cfg: GitFlowConfig | null, branch: string): { kind: FlowKind; name: string } | null {
  if (!cfg) return null;
  for (const kind of FLOW_KINDS) {
    const p = prefix(cfg, kind);
    if (branch.startsWith(p) && branch.length > p.length) return { kind, name: branch.slice(p.length) };
  }
  return null;
}

// The tag a release or hotfix called `name` gets when finished.
export function flowTag(cfg: GitFlowConfig, name: string): string {
  return `${cfg.version_tag}${name}`;
}

// What finishing `branch` does, in order — for the confirmation.
export function finishSteps(cfg: GitFlowConfig, kind: FlowKind, branch: string, name: string): string[] {
  if (kind === "Feature") return [`merge ${branch} into ${cfg.develop}`, `delete ${branch}`];
  return [
    `merge ${branch} into ${cfg.production}`,
    `tag it ${flowTag(cfg, name)}`,
    `merge ${branch} into ${cfg.develop}`,
    `delete ${branch}`,
  ];
}

// What Initialize suggests: the existing settings, else git-flow's defaults
// with `main` or `master` (whichever exists) as the production branch.
export function suggestedGitflowConfig(current: GitFlowConfig | null, branches: string[]): GitFlowConfig {
  if (current) return { ...current };
  const production = ["main", "master"].find((b) => branches.includes(b)) ?? branches[0] ?? "main";
  return {
    production,
    develop: "develop",
    feature: "feature/",
    release: "release/",
    hotfix: "hotfix/",
    version_tag: "",
  };
}
