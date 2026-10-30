// Git Flow: Initialize (a settings dialog), Start feature / release / hotfix
// (a name prompt) and Finish on a flow branch's menu. All of it is plain git
// run by the backend — the git-flow tool needn't be installed.

import { confirmDialog, gitflowFinish, gitflowInit, gitflowStart } from "./api";
import type { MenuItem } from "./views/context-menu";
import { openFormDialog } from "./views/form-dialog";
import type { FlowKind } from "./types";
import { state } from "./app-state";
import { setStatus } from "./report";
import { runBranchOp } from "./ref-actions";
import { finishSteps, FLOW_KINDS, flowBranch, flowTag, suggestedGitflowConfig } from "./gitflow";

// The "Git Flow" submenu of the branch menus: Start…, or Initialize before
// it is set up.
export function gitflowMenuItem(): MenuItem {
  if (!state.gitflow) {
    return { label: "Git Flow", submenu: [{ label: "Initialize Git Flow…", run: initGitflowAction }] };
  }
  return {
    label: "Git Flow",
    submenu: [
      { heading: "Git Flow" },
      ...FLOW_KINDS.map((kind) => ({
        label: `Start ${kind}…`,
        prompt: { placeholder: `${kind} name`, onSubmit: (name: string) => void startFlowAction(kind, name) },
      })),
      { separator: true },
      { label: "Git Flow Settings…", run: initGitflowAction },
    ],
  };
}

// "Finish Feature" (etc.) for a branch that is one, else null.
export function finishFlowItem(branch: string): MenuItem | null {
  const flow = flowBranch(state.gitflow, branch);
  return flow ? { label: `Finish ${flow.kind}…`, run: () => void finishFlowAction(branch) } : null;
}

// The Initialize dialog, filled with the current settings (it doubles as the
// way to change them) or git-flow's defaults.
export function initGitflowAction(): void {
  const s = suggestedGitflowConfig(
    state.gitflow,
    state.refs.branches.map((b) => b.name),
  );
  openFormDialog(
    {
      title: state.gitflow ? "Git Flow Settings" : "Initialize Git Flow",
      sub: "Stored in the repository's config the way git-flow stores it. The develop branch is created from production if it doesn't exist.",
      fields: [
        { label: "Production branch:", value: s.production, required: true },
        { label: "Develop branch:", value: s.develop, required: true },
        { label: "Feature prefix:", value: s.feature, required: true },
        { label: "Release prefix:", value: s.release, required: true },
        { label: "Hotfix prefix:", value: s.hotfix, required: true },
        { label: "Version tag prefix:", value: s.version_tag, placeholder: "e.g. v (optional)" },
      ],
      submitLabel: state.gitflow ? "Save" : "Initialize",
    },
    ([production, develop, feature, release, hotfix, version_tag]) =>
      void runBranchOp(
        "Initializing Git Flow",
        () => gitflowInit({ production, develop, feature, release, hotfix, version_tag }),
        false,
      ),
  );
}

export function startFlowAction(kind: FlowKind, name: string): Promise<void> {
  return runBranchOp(`Starting ${kind.toLowerCase()} ${name}`, () => gitflowStart(kind, name), true);
}

// Finish after saying what it will do. A release or hotfix asks for its tag's
// message. A conflict stops it with the merge in progress — runBranchOp then
// offers Resolve Conflicts — and Finish again completes the rest.
export async function finishFlowAction(branch: string): Promise<void> {
  const cfg = state.gitflow;
  const flow = flowBranch(cfg, branch);
  if (!cfg || !flow) return;
  const steps = finishSteps(cfg, flow.kind, branch, flow.name).join(", then ");
  const label = `Finishing ${flow.kind.toLowerCase()} ${flow.name}`;
  if (flow.kind === "Feature") {
    const ok = await confirmDialog(
      `Finish feature ${flow.name}?\n\nThis will ${steps}, leaving ${cfg.develop} checked out. The merge always makes a merge commit.`,
    );
    if (!ok) {
      setStatus("Finish cancelled.");
      return;
    }
    await runBranchOp(label, () => gitflowFinish(branch, null), true, branch);
    return;
  }
  openFormDialog(
    {
      title: `Finish ${flow.kind} ${flow.name}`,
      sub: `This will ${steps}, leaving ${cfg.develop} checked out. Each merge makes a merge commit.`,
      fields: [{ label: `Message for tag ${flowTag(cfg, flow.name)}:`, value: `${flow.kind} ${flow.name}`, required: true }],
      submitLabel: `Finish ${flow.kind}`,
    },
    ([message]) => void runBranchOp(label, () => gitflowFinish(branch, message), true, branch),
  );
}
